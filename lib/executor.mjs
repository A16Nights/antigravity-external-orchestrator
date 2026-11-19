import fs from "node:fs";
import path from "node:path";
import { callWithFallback } from "./llm-client.mjs";
import { getWorkerToolSchemas, resolveSafePath, runWorkerTool } from "./worker-tools.mjs";

function parseCandidateSpec(spec) {
  const s = String(spec || "").trim();
  if (!s) return null;
  const idx = s.indexOf(":");
  if (idx <= 0) {
    return { providerId: s, model: "" };
  }
  return {
    providerId: s.slice(0, idx).trim(),
    model: s.slice(idx + 1).trim()
  };
}

export function resolveCandidates(store, { profile, provider, model } = {}) {
  const cfg = store.readRawConfig();
  const profileName = String(profile || cfg.routing?.defaultProfile || "default").trim();
  const route = cfg.routing?.profiles?.[profileName] || cfg.routing?.profiles?.[cfg.routing?.defaultProfile] || null;

  const list = [];
  const seen = new Set();
  const pushUnique = (cand) => {
    if (!cand || !cand.providerId) return;
    const key = `${cand.providerId}::${cand.model || ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      list.push(cand);
    }
  };

  if (provider) {
    pushUnique({ providerId: String(provider).trim(), model: String(model || "").trim() });
    if (route) {
      for (const fb of route.fallbacks || []) {
        pushUnique(parseCandidateSpec(fb));
      }
    }
    return list;
  }

  if (route) {
    if (route.primary) pushUnique(parseCandidateSpec(route.primary));
    for (const fb of route.fallbacks || []) {
      pushUnique(parseCandidateSpec(fb));
    }
  }

  // Fallback safety net: any enabled configured provider
  for (const p of cfg.providers) {
    if (p.enabled) {
      pushUnique({ providerId: p.id, model: p.defaultModel || p.models?.[0] || "" });
    }
  }
  return list;
}

function buildWorkerSystemPrompt({ cwd, mode, systemHint }) {
  const lines = [
    "你是主规划手（Antigravity Orchestrator）委派的外部执行手（Worker Agent）。",
    `当前工作目录：${cwd}`,
    `当前权限模式：${mode}`,
    "执行原则：",
    "1. 只完成本次委派的任务，不要擅自改动无关文件或偏离范围。",
    "2. 修改代码/文本前先用 read_file 或 search_files 确认真实上下文，改完后务必复核确认。",
    "3. 严格遵守工作区边界，禁止编造未观察到的文件内容或命令输出。",
    "4. 完成全部操作后，用简洁清晰的中文汇报：做了什么改动、涉及哪些文件、验证结果如何、是否存在未解决的阻塞项。"
  ];
  if (systemHint && String(systemHint).trim()) {
    lines.push("", "主规划手附加要求：", String(systemHint).trim());
  }
  return lines.join("\n");
}

function preloadContextFiles(cwd, contextFiles, allowOutside) {
  if (!Array.isArray(contextFiles) || contextFiles.length === 0) return "";
  const chunks = [];
  for (const rel of contextFiles.slice(0, 5)) {
    try {
      const abs = resolveSafePath(cwd, rel, allowOutside);
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) continue;
      let content = fs.readFileSync(abs, "utf8");
      if (content.length > 16000) {
        content = content.slice(0, 16000) + "\n... [预加载文件已截断]";
      }
      chunks.push(`### 参考文件：${rel}\n\`\`\`\n${content}\n\`\`\``);
    } catch (err) {
      chunks.push(`### 参考文件：${rel}\n（读取失败：${err.message}）`);
    }
  }
  return chunks.length > 0 ? "\n\n以下为主规划手预先指定的参考文件内容：\n" + chunks.join("\n\n") : "";
}

function parseToolArgs(rawArgs) {
  if (!rawArgs) return { ok: true, value: {} };
  if (typeof rawArgs === "object") return { ok: true, value: rawArgs };
  try {
    return { ok: true, value: JSON.parse(String(rawArgs)) };
  } catch (err) {
    return { ok: false, error: `工具参数 JSON 解析失败：${err.message}` };
  }
}

function summarizeToolResult(result) {
  const s = typeof result === "string" ? result : JSON.stringify(result);
  return s.length > 500 ? s.slice(0, 500) + "..." : s;
}

export async function executeWorkerTask(store, opts = {}) {
  const task = String(opts.task || "").trim();
  if (!task) throw new Error("缺少 task 参数");
  const cwdRaw = String(opts.cwd || "").trim();
  if (!cwdRaw) throw new Error("缺少 cwd（工作目录）参数");
  const cwd = path.resolve(cwdRaw);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`工作目录不存在或不是目录：${cwd}`);
  }

  const cfg = store.readRawConfig();
  const workerCfg = cfg.worker || {};
  const validModes = new Set(["readonly", "edit", "full"]);
  const mode = validModes.has(opts.mode) ? opts.mode : (workerCfg.defaultMode || "edit");
  const maxLimit = Number(workerCfg.maxStepsLimit || 40);
  const maxSteps = Math.max(1, Math.min(maxLimit, Number(opts.maxSteps) || Number(workerCfg.defaultMaxSteps || 18)));

  const candidates = resolveCandidates(store, {
    profile: opts.profile,
    provider: opts.provider,
    model: opts.model
  });

  const run = store.createRun({
    kind: "execute",
    task,
    cwd,
    mode,
    profile: opts.profile || cfg.routing?.defaultProfile || "default"
  });

  const tracker = { createdFiles: [], modifiedFiles: [] };
  const trace = [];
  const totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const allAttempts = [];
  const toolSchemas = getWorkerToolSchemas(mode);

  const preloadText = preloadContextFiles(cwd, opts.contextFiles, Boolean(workerCfg.allowOutsideWorkspace));
  const messages = [
    { role: "system", content: buildWorkerSystemPrompt({ cwd, mode, systemHint: opts.systemHint }) },
    { role: "user", content: task + preloadText }
  ];

  let lastMeta = { providerId: "", providerName: "", model: "", fallbackUsed: false };
  let lastReasoning = "";

  try {
    for (let step = 1; step <= maxSteps; step++) {
      const res = await callWithFallback({
        store,
        candidates,
        messages,
        tools: toolSchemas
      });

      lastMeta = {
        providerId: res.providerId,
        providerName: res.providerName,
        model: res.model,
        fallbackUsed: lastMeta.fallbackUsed || Boolean(res.fallbackUsed)
      };
      allAttempts.push(...res.attempts);
      totalUsage.promptTokens += res.usage?.promptTokens || 0;
      totalUsage.completionTokens += res.usage?.completionTokens || 0;
      totalUsage.totalTokens += res.usage?.totalTokens || 0;
      if (res.reasoningContent) {
        lastReasoning = res.reasoningContent;
      }

      const assistantMsg = {
        role: "assistant",
        content: res.content || ""
      };
      if (res.reasoningContent) {
        assistantMsg.reasoning_content = res.reasoningContent;
      }
      if (res.toolCalls && res.toolCalls.length > 0) {
        assistantMsg.tool_calls = res.toolCalls;
      }
      messages.push(assistantMsg);

      if (!res.toolCalls || res.toolCalls.length === 0) {
        const finishedAt = Date.now();
        const finalSummary = String(res.content || "").trim() || "（执行完成，模型未返回文本摘要）";
        store.updateRun(run.id, {
          status: "completed",
          providerId: lastMeta.providerId,
          providerName: lastMeta.providerName,
          model: lastMeta.model,
          fallbackUsed: lastMeta.fallbackUsed,
          attempts: allAttempts.slice(-20),
          steps: step,
          usage: totalUsage,
          createdFiles: tracker.createdFiles,
          modifiedFiles: tracker.modifiedFiles,
          trace,
          summary: finalSummary,
          reasoningContent: lastReasoning,
          finishedAt
        });

        return {
          runId: run.id,
          status: "completed",
          providerId: lastMeta.providerId,
          providerName: lastMeta.providerName,
          model: lastMeta.model,
          fallbackUsed: lastMeta.fallbackUsed,
          steps: step,
          usage: totalUsage,
          durationMs: finishedAt - run.startedAt,
          createdFiles: tracker.createdFiles,
          modifiedFiles: tracker.modifiedFiles,
          summary: finalSummary,
          trace
        };
      }

      const stepToolLogs = [];
      for (const tc of res.toolCalls) {
        const fnName = tc.function?.name || "";
        const parsed = parseToolArgs(tc.function?.arguments);
        let output;
        let ok = true;
        if (!parsed.ok) {
          ok = false;
          output = { error: parsed.error };
        } else {
          try {
            output = await runWorkerTool({
              name: fnName,
              args: parsed.value,
              cwd,
              mode,
              workerConfig: workerCfg,
              tracker
            });
          } catch (toolErr) {
            ok = false;
            output = { error: toolErr?.message || String(toolErr) };
          }
        }

        const serialized = typeof output === "string" ? output : JSON.stringify(output);
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: serialized.length > 24000 ? serialized.slice(0, 24000) + "\n... [工具输出已截断]" : serialized
        });
        stepToolLogs.push({
          tool: fnName,
          args: parsed.ok ? parsed.value : String(tc.function?.arguments || "").slice(0, 200),
          ok,
          preview: summarizeToolResult(serialized)
        });
      }

      trace.push({
        step,
        model: `${lastMeta.providerId}:${lastMeta.model}`,
        thoughtPreview: String(res.content || "").slice(0, 200),
        tools: stepToolLogs
      });

      store.updateRun(run.id, {
        providerId: lastMeta.providerId,
        providerName: lastMeta.providerName,
        model: lastMeta.model,
        fallbackUsed: lastMeta.fallbackUsed,
        steps: step,
        usage: totalUsage,
        createdFiles: tracker.createdFiles,
        modifiedFiles: tracker.modifiedFiles,
        trace
      });
    }

    // Reached maxSteps: request a concise wrap-up without tools
    let wrapSummary = "";
    try {
      messages.push({
        role: "user",
        content: "已达到最大执行步数上限，请立即停止进一步操作并简要汇总目前已完成的工作、修改的文件以及剩余待办。"
      });
      const wrapRes = await callWithFallback({
        store,
        candidates,
        messages,
        tools: []
      });
      totalUsage.promptTokens += wrapRes.usage?.promptTokens || 0;
      totalUsage.completionTokens += wrapRes.usage?.completionTokens || 0;
      totalUsage.totalTokens += wrapRes.usage?.totalTokens || 0;
      wrapSummary = String(wrapRes.content || "").trim();
    } catch {}

    const finishedAt = Date.now();
    const summary = wrapSummary || `已达到最大步数上限 (${maxSteps})，请主规划手核查当前改动。`;
    store.updateRun(run.id, {
      status: "max_steps_reached",
      providerId: lastMeta.providerId,
      providerName: lastMeta.providerName,
      model: lastMeta.model,
      fallbackUsed: lastMeta.fallbackUsed,
      attempts: allAttempts.slice(-20),
      steps: maxSteps,
      usage: totalUsage,
      createdFiles: tracker.createdFiles,
      modifiedFiles: tracker.modifiedFiles,
      trace,
      summary,
      reasoningContent: lastReasoning,
      finishedAt
    });

    return {
      runId: run.id,
      status: "max_steps_reached",
      providerId: lastMeta.providerId,
      providerName: lastMeta.providerName,
      model: lastMeta.model,
      fallbackUsed: lastMeta.fallbackUsed,
      steps: maxSteps,
      usage: totalUsage,
      durationMs: finishedAt - run.startedAt,
      createdFiles: tracker.createdFiles,
      modifiedFiles: tracker.modifiedFiles,
      summary,
      trace
    };
  } catch (err) {
    const finishedAt = Date.now();
    const errMsg = err?.message || String(err);
    store.updateRun(run.id, {
      status: "failed",
      providerId: lastMeta.providerId,
      providerName: lastMeta.providerName,
      model: lastMeta.model,
      fallbackUsed: lastMeta.fallbackUsed,
      attempts: allAttempts.slice(-20),
      usage: totalUsage,
      createdFiles: tracker.createdFiles,
      modifiedFiles: tracker.modifiedFiles,
      trace,
      error: errMsg,
      finishedAt
    });
    throw err;
  }
}

export async function generateOnce(store, opts = {}) {
  const prompt = String(opts.prompt || "").trim();
  if (!prompt) throw new Error("缺少 prompt 参数");

  const cfg = store.readRawConfig();
  const candidates = resolveCandidates(store, {
    profile: opts.profile,
    provider: opts.provider,
    model: opts.model
  });

  const run = store.createRun({
    kind: "generate",
    task: prompt.slice(0, 500),
    profile: opts.profile || cfg.routing?.defaultProfile || "default"
  });

  const messages = [];
  if (opts.system && String(opts.system).trim()) {
    messages.push({ role: "system", content: String(opts.system).trim() });
  }
  messages.push({ role: "user", content: prompt });

  const started = Date.now();
  try {
    const res = await callWithFallback({
      store,
      candidates,
      messages,
      tools: [],
      temperature: opts.temperature,
      maxTokens: opts.maxTokens
    });
    const finishedAt = Date.now();
    const latencyMs = finishedAt - started;

    store.updateRun(run.id, {
      status: "completed",
      providerId: res.providerId,
      providerName: res.providerName,
      model: res.model,
      fallbackUsed: res.fallbackUsed,
      attempts: res.attempts,
      steps: 1,
      usage: res.usage,
      summary: res.content,
      reasoningContent: res.reasoningContent || "",
      finishedAt,
      durationMs: latencyMs
    });

    return {
      runId: run.id,
      text: res.content,
      reasoningContent: res.reasoningContent || "",
      providerId: res.providerId,
      providerName: res.providerName,
      model: res.model,
      fallbackUsed: res.fallbackUsed,
      attempts: res.attempts,
      usage: res.usage,
      latencyMs
    };
  } catch (err) {
    const finishedAt = Date.now();
    store.updateRun(run.id, {
      status: "failed",
      error: err?.message || String(err),
      finishedAt,
      durationMs: finishedAt - started
    });
    throw err;
  }
}
