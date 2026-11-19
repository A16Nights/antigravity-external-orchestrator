function isLocalUrl(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
  } catch {
    return false;
  }
}

export function normalizeOpenAIEndpoint(baseUrl, suffix) {
  const clean = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!clean) throw new Error("Base URL 不能为空");
  if (clean.endsWith("/chat/completions")) {
    if (suffix === "/chat/completions") return clean;
    return clean.slice(0, -"/chat/completions".length) + suffix;
  }
  if (clean.endsWith("/models")) {
    if (suffix === "/models") return clean;
    return clean.slice(0, -"/models".length) + suffix;
  }
  if (/\/(v\d+(?:beta\d*)?|compatible-mode\/v\d+|api\/v\d+)$/i.test(clean)) {
    return `${clean}${suffix}`;
  }
  return `${clean}/v1${suffix}`;
}

export function normalizeAnthropicEndpoint(baseUrl, suffix = "/messages") {
  const clean = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!clean) throw new Error("Base URL 不能为空");
  if (clean.endsWith("/messages")) {
    if (suffix === "/messages") return clean;
    return clean.slice(0, -"/messages".length) + suffix;
  }
  if (/\/v\d+$/i.test(clean)) {
    return `${clean}${suffix}`;
  }
  return `${clean}/v1${suffix}`;
}

function safeJsonParse(str, fallback = {}) {
  if (str && typeof str === "object") return str;
  try {
    return JSON.parse(String(str || "{}"));
  } catch {
    return fallback;
  }
}

async function readHttpError(res) {
  let bodyText = "";
  try {
    bodyText = await res.text();
  } catch {}
  let detail = bodyText;
  try {
    const j = JSON.parse(bodyText);
    detail = j?.error?.message || j?.message || j?.error || bodyText;
  } catch {}
  return `HTTP ${res.status}: ${String(detail || res.statusText || "Request failed").slice(0, 320)}`;
}

export async function callOpenAI({ provider, model, messages, tools, temperature, maxTokens, signal }) {
  const endpoint = normalizeOpenAIEndpoint(provider.baseUrl, "/chat/completions");
  const headers = {
    "Content-Type": "application/json",
    ...(provider.headers && typeof provider.headers === "object" ? provider.headers : {})
  };
  if (provider.apiKey && String(provider.apiKey).trim()) {
    headers.Authorization = `Bearer ${String(provider.apiKey).trim()}`;
  }

  const body = {
    model,
    messages,
    stream: false
  };
  const isReasoner = /reasoner|r1/i.test(model);
  if (temperature !== undefined && temperature !== null && !isReasoner) {
    body.temperature = temperature;
  }
  if (maxTokens !== undefined && maxTokens !== null) {
    body.max_tokens = maxTokens;
  }
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) {
    throw new Error(await readHttpError(res));
  }
  const data = await res.json();
  const choice = data?.choices?.[0];
  if (!choice || !choice.message) {
    throw new Error("上游未返回有效 choices[0].message");
  }
  const msg = choice.message;
  const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const toolCalls = rawCalls.map((tc, idx) => ({
    id: tc.id || `call_${Date.now()}_${idx}`,
    type: "function",
    function: {
      name: tc.function?.name || "",
      arguments: typeof tc.function?.arguments === "string"
        ? tc.function.arguments
        : JSON.stringify(tc.function?.arguments || {})
    }
  }));

  const usageRaw = data.usage || {};
  return {
    content: typeof msg.content === "string" ? msg.content : (Array.isArray(msg.content) ? msg.content.map((p) => p?.text || "").join("") : ""),
    reasoningContent: typeof msg.reasoning_content === "string" ? msg.reasoning_content : (typeof msg.reasoning === "string" ? msg.reasoning : ""),
    toolCalls,
    finishReason: choice.finish_reason || "",
    usage: {
      promptTokens: Number(usageRaw.prompt_tokens || 0),
      completionTokens: Number(usageRaw.completion_tokens || 0),
      totalTokens: Number(usageRaw.total_tokens || (Number(usageRaw.prompt_tokens || 0) + Number(usageRaw.completion_tokens || 0)))
    }
  };
}

function toAnthropicMessages(messages) {
  const systemParts = [];
  const out = [];

  for (const m of messages || []) {
    if (!m) continue;
    if (m.role === "system") {
      if (m.content) systemParts.push(String(m.content));
      continue;
    }
    if (m.role === "user") {
      out.push({
        role: "user",
        content: [{ type: "text", text: String(m.content || "") }]
      });
      continue;
    }
    if (m.role === "assistant") {
      const blocks = [];
      if (m.content) {
        blocks.push({ type: "text", text: String(m.content) });
      }
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          blocks.push({
            type: "tool_use",
            id: tc.id || `tool_${Date.now()}`,
            name: tc.function?.name || "",
            input: safeJsonParse(tc.function?.arguments, {})
          });
        }
      }
      if (blocks.length > 0) {
        out.push({ role: "assistant", content: blocks });
      }
      continue;
    }
    if (m.role === "tool") {
      const toolBlock = {
        type: "tool_result",
        tool_use_id: m.tool_call_id || "",
        content: String(m.content || "")
      };
      const prev = out[out.length - 1];
      if (prev && prev.role === "user" && Array.isArray(prev.content) && prev.content.some((b) => b.type === "tool_result")) {
        prev.content.push(toolBlock);
      } else {
        out.push({ role: "user", content: [toolBlock] });
      }
    }
  }

  return {
    system: systemParts.join("\n\n").trim(),
    messages: out
  };
}

export async function callAnthropic({ provider, model, messages, tools, temperature, maxTokens, signal }) {
  const endpoint = normalizeAnthropicEndpoint(provider.baseUrl, "/messages");
  const headers = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    ...(provider.headers && typeof provider.headers === "object" ? provider.headers : {})
  };
  if (provider.apiKey && String(provider.apiKey).trim()) {
    headers["x-api-key"] = String(provider.apiKey).trim();
  }

  const converted = toAnthropicMessages(messages);
  const body = {
    model,
    max_tokens: maxTokens || 4096,
    messages: converted.messages
  };
  if (converted.system) {
    body.system = converted.system;
  }
  if (temperature !== undefined && temperature !== null) {
    body.temperature = temperature;
  }
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools.map((t) => ({
      name: t.function?.name || "",
      description: t.function?.description || "",
      input_schema: t.function?.parameters || { type: "object", properties: {} }
    }));
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) {
    throw new Error(await readHttpError(res));
  }
  const data = await res.json();
  const blocks = Array.isArray(data.content) ? data.content : [];
  const textParts = [];
  const thinkingParts = [];
  const toolCalls = [];

  for (const b of blocks) {
    if (!b) continue;
    if (b.type === "text" && b.text) textParts.push(b.text);
    else if (b.type === "thinking" && b.thinking) thinkingParts.push(b.thinking);
    else if (b.type === "tool_use") {
      toolCalls.push({
        id: b.id || `call_${Date.now()}`,
        type: "function",
        function: {
          name: b.name || "",
          arguments: JSON.stringify(b.input || {})
        }
      });
    }
  }

  const usageRaw = data.usage || {};
  const promptTokens = Number(usageRaw.input_tokens || 0);
  const completionTokens = Number(usageRaw.output_tokens || 0);
  return {
    content: textParts.join(""),
    reasoningContent: thinkingParts.join("\n"),
    toolCalls,
    finishReason: data.stop_reason || "",
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens
    }
  };
}

export async function callSingleProvider({ provider, model, messages, tools, temperature, maxTokens, signal }) {
  if (provider.protocol === "anthropic") {
    return callAnthropic({ provider, model, messages, tools, temperature, maxTokens, signal });
  }
  return callOpenAI({ provider, model, messages, tools, temperature, maxTokens, signal });
}

export async function fetchProviderModels(provider) {
  const signal = AbortSignal.timeout(Math.min(30000, provider.timeoutMs || 20000));
  if (provider.protocol === "anthropic") {
    const endpoint = normalizeAnthropicEndpoint(provider.baseUrl, "/models");
    const headers = {
      "anthropic-version": "2023-06-01",
      ...(provider.headers && typeof provider.headers === "object" ? provider.headers : {})
    };
    if (provider.apiKey && String(provider.apiKey).trim()) {
      headers["x-api-key"] = String(provider.apiKey).trim();
    }
    const res = await fetch(endpoint, { method: "GET", headers, signal });
    if (!res.ok) {
      throw new Error(`该 Anthropic 渠道不支持自动拉取模型列表 (${await readHttpError(res)})，请手动填写模型名`);
    }
    const data = await res.json();
    const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
    return list.map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean);
  }

  const endpoint = normalizeOpenAIEndpoint(provider.baseUrl, "/models");
  const headers = {
    ...(provider.headers && typeof provider.headers === "object" ? provider.headers : {})
  };
  if (provider.apiKey && String(provider.apiKey).trim()) {
    headers.Authorization = `Bearer ${String(provider.apiKey).trim()}`;
  }
  const res = await fetch(endpoint, { method: "GET", headers, signal });
  if (!res.ok) {
    throw new Error(await readHttpError(res));
  }
  const data = await res.json();
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : (Array.isArray(data) ? data : []));
  const ids = [];
  const seen = new Set();
  for (const item of list) {
    const id = typeof item === "string" ? item : (item?.id || item?.name || "");
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export async function testProvider(store, providerId, modelOverride) {
  const provider = store.getProviderWithSecret(providerId);
  if (!provider) {
    throw new Error(`未找到渠道：${providerId}`);
  }
  if (!provider.apiKey && !isLocalUrl(provider.baseUrl)) {
    throw new Error(`渠道「${provider.name}」尚未填入 API Key`);
  }

  let model = String(modelOverride || provider.defaultModel || provider.models?.[0] || "").trim();
  if (!model) {
    try {
      const fetched = await fetchProviderModels(provider);
      if (fetched.length > 0) {
        model = fetched[0];
      }
    } catch {}
  }
  if (!model) {
    throw new Error(`渠道「${provider.name}」未配置可用模型，请先拉取模型或手动添加一个模型名`);
  }

  const started = Date.now();
  try {
    const res = await callSingleProvider({
      provider,
      model,
      messages: [{ role: "user", content: "Reply with OK" }],
      maxTokens: 16,
      signal: AbortSignal.timeout(Math.min(30000, provider.timeoutMs || 30000))
    });
    const latencyMs = Date.now() - started;
    store.recordSuccess(providerId);
    const lastTest = {
      ok: true,
      latencyMs,
      model,
      message: `连接正常 (${String(res.content || "OK").trim().slice(0, 40)})`,
      at: Date.now()
    };
    store.updateProviderTestResult(providerId, lastTest);
    return { ...lastTest, providerId, providerName: provider.name };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const msg = err?.message || String(err);
    store.recordFailure(providerId, msg);
    const lastTest = {
      ok: false,
      latencyMs,
      model,
      message: msg,
      at: Date.now()
    };
    store.updateProviderTestResult(providerId, lastTest);
    return { ...lastTest, providerId, providerName: provider.name };
  }
}

export async function callWithFallback({ store, candidates, messages, tools, temperature, maxTokens }) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("未配置任何可用的候选模型，请先在控制台中启用渠道并绑定模型");
  }

  const attempts = [];
  const validCandidates = [];
  const halfOpenSkipped = [];

  for (const cand of candidates) {
    const provider = store.getProviderWithSecret(cand.providerId);
    if (!provider) {
      attempts.push({ providerId: cand.providerId, model: cand.model || "", status: "skipped", reason: "渠道不存在" });
      continue;
    }
    if (!provider.enabled) {
      attempts.push({ providerId: provider.id, model: cand.model || "", status: "skipped", reason: "渠道已停用" });
      continue;
    }
    if (!provider.apiKey && !isLocalUrl(provider.baseUrl)) {
      attempts.push({ providerId: provider.id, model: cand.model || "", status: "skipped", reason: "未配置 API Key" });
      continue;
    }
    const model = String(cand.model || provider.defaultModel || provider.models?.[0] || "").trim();
    if (!model) {
      attempts.push({ providerId: provider.id, model: "", status: "skipped", reason: "渠道未配置模型名" });
      continue;
    }
    if (store.isCircuitOpen(provider.id)) {
      halfOpenSkipped.push({ provider, model });
      continue;
    }
    validCandidates.push({ provider, model });
  }

  // If every otherwise-valid candidate is currently circuit-open, probe the one closest to cooldown expiry.
  if (validCandidates.length === 0 && halfOpenSkipped.length > 0) {
    const breakerStates = store.getBreakerStates();
    halfOpenSkipped.sort((a, b) => {
      const remA = breakerStates[a.provider.id]?.remainingSec ?? 0;
      const remB = breakerStates[b.provider.id]?.remainingSec ?? 0;
      return remA - remB;
    });
    const probe = halfOpenSkipped.shift();
    validCandidates.push({ ...probe, halfOpenProbe: true });
    for (const item of halfOpenSkipped) {
      attempts.push({ providerId: item.provider.id, model: item.model, status: "circuit_open", reason: "断路器冷却中" });
    }
  } else {
    for (const item of halfOpenSkipped) {
      attempts.push({ providerId: item.provider.id, model: item.model, status: "circuit_open", reason: "断路器冷却中" });
    }
  }

  if (validCandidates.length === 0) {
    const summary = attempts.map((a) => `${a.providerId}${a.model ? ":" + a.model : ""} (${a.reason})`).join("; ");
    throw new Error(`没有可执行的有效模型候选：${summary || "请先配置渠道 API Key 并启用"}`);
  }

  for (let i = 0; i < validCandidates.length; i++) {
    const { provider, model, halfOpenProbe } = validCandidates[i];
    const started = Date.now();
    try {
      const result = await callSingleProvider({
        provider,
        model,
        messages,
        tools,
        temperature,
        maxTokens,
        signal: AbortSignal.timeout(provider.timeoutMs || 120000)
      });
      store.recordSuccess(provider.id);
      attempts.push({
        providerId: provider.id,
        providerName: provider.name,
        model,
        status: "ok",
        halfOpenProbe: Boolean(halfOpenProbe),
        latencyMs: Date.now() - started
      });
      return {
        ...result,
        providerId: provider.id,
        providerName: provider.name,
        model,
        attempts,
        fallbackUsed: attempts.some((a) => a.status === "failed" || a.status === "circuit_open")
      };
    } catch (err) {
      const msg = err?.message || String(err);
      store.recordFailure(provider.id, msg);
      attempts.push({
        providerId: provider.id,
        providerName: provider.name,
        model,
        status: "failed",
        latencyMs: Date.now() - started,
        reason: msg
      });
    }
  }

  const detail = attempts
    .map((a) => `[${a.providerId}${a.model ? ":" + a.model : ""}] ${a.status}: ${a.reason || ""}`)
    .join(" | ");
  throw new Error(`全部候选模型均执行失败：${detail}`);
}
