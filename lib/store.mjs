import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export const PROVIDER_PRESETS = [
  {
    preset: "deepseek",
    name: "DeepSeek",
    tag: "官方",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    defaultModel: "deepseek-chat"
  },
  {
    preset: "local-gateway",
    name: "本地聚合网关",
    tag: "本地聚合",
    protocol: "openai",
    baseUrl: "http://127.0.0.1:18899/v1",
    models: [],
    defaultModel: ""
  },
  {
    preset: "openai-compat",
    name: "OpenAI 兼容渠道",
    tag: "自定义",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    models: [],
    defaultModel: ""
  },
  {
    preset: "kimi",
    name: "Kimi / Moonshot",
    tag: "自定义",
    protocol: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["moonshot-v1-8k", "moonshot-v1-32k"],
    defaultModel: "moonshot-v1-32k"
  },
  {
    preset: "openrouter",
    name: "OpenRouter",
    tag: "自定义",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [],
    defaultModel: ""
  },
  {
    preset: "anthropic",
    name: "Anthropic 兼容",
    tag: "自定义",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    models: ["claude-sonnet-4-20250514"],
    defaultModel: "claude-sonnet-4-20250514"
  },
  {
    preset: "ollama",
    name: "Ollama 本地",
    tag: "本地",
    protocol: "openai",
    baseUrl: "http://127.0.0.1:11434/v1",
    models: [],
    defaultModel: ""
  }
];

export function resolveDataDir(overrideDir) {
  return (
    overrideDir ||
    process.env.EXTERNAL_ORCHESTRATOR_DATA_DIR ||
    path.join(os.homedir(), ".gemini", "external-orchestrator")
  );
}

export function maskApiKey(key) {
  const s = typeof key === "string" ? key.trim() : "";
  if (!s) return "";
  if (s.length > 10) {
    return `${s.slice(0, 4)}****${s.slice(-4)}`;
  }
  return "****";
}

export const BUILTIN_PROFILE_KEYS = ["default", "coder", "fast", "reasoner"];

const BUILTIN_PROFILE_DEFAULTS = {
  default: {
    label: "默认执行手",
    description: "通用均衡调度，适用于常规任务委派",
    defaultMode: "",
    systemPrompt: "",
    primary: "deepseek:deepseek-chat",
    fallbacks: []
  },
  coder: {
    label: "代码与文件修改",
    description: "代码编写、文件修改与多步工程任务",
    defaultMode: "",
    systemPrompt: "",
    primary: "deepseek:deepseek-chat",
    fallbacks: []
  },
  fast: {
    label: "轻量快速处理",
    description: "快速阅读、摘要、翻译与轻量问答",
    defaultMode: "",
    systemPrompt: "",
    primary: "deepseek:deepseek-chat",
    fallbacks: []
  },
  reasoner: {
    label: "深度分析辅助",
    description: "复杂架构分析、深度排错与推理辅助",
    defaultMode: "",
    systemPrompt: "",
    primary: "deepseek:deepseek-reasoner",
    fallbacks: ["deepseek:deepseek-chat"]
  }
};

function defaultConfig() {
  return {
    version: 1,
    providers: [
      {
        id: "deepseek",
        name: "DeepSeek",
        preset: "deepseek",
        tag: "官方",
        protocol: "openai",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "",
        enabled: true,
        models: ["deepseek-chat", "deepseek-reasoner"],
        defaultModel: "deepseek-chat",
        timeoutMs: 120000,
        headers: {},
        lastTest: null
      },
      {
        id: "local-gateway",
        name: "本地聚合网关",
        preset: "local-gateway",
        tag: "本地聚合",
        protocol: "openai",
        baseUrl: "http://127.0.0.1:18899/v1",
        apiKey: "",
        enabled: false,
        models: [],
        defaultModel: "",
        timeoutMs: 120000,
        headers: {},
        lastTest: null
      }
    ],
    routing: {
      defaultProfile: "default",
      profiles: JSON.parse(JSON.stringify(BUILTIN_PROFILE_DEFAULTS))
    },
    circuitBreaker: {
      enabled: true,
      failureThreshold: 3,
      cooldownSec: 60
    },
    worker: {
      defaultMode: "edit",
      defaultMaxSteps: 18,
      maxStepsLimit: 40,
      commandTimeoutMs: 60000,
      allowOutsideWorkspace: false,
      perTurnReinforce: true
    }
  };
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function atomicWriteJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export const ACTIVE_RUN_LIMIT = 20;
export const ACTIVE_RUN_STEPS_LIMIT = 40;

const ACTIVE_RUN_STATUSES = new Set(["running", "completed", "error", "max_steps_reached"]);
const HISTORY_STATUS_ALIASES = new Map([
  ["failed", "error"]
]);

function normalizeStringArray(list, limit = 80) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const s = String(item == null ? "" : item).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeStepsLog(list, limit = ACTIVE_RUN_STEPS_LIMIT) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list.slice(-limit)) {
    if (!entry || typeof entry !== "object") continue;
    out.push({
      step: Math.max(0, Number(entry.step) || 0),
      action: String(entry.action || "").slice(0, 200),
      tool: String(entry.tool || "").slice(0, 60),
      phase: String(entry.phase || "").slice(0, 20),
      ok: entry.ok === undefined || entry.ok === null ? null : Boolean(entry.ok),
      detail: String(entry.detail || "").slice(0, 400),
      at: Number(entry.at) || Date.now()
    });
  }
  return out;
}

function normalizeActiveStatus(status, fallback = "running") {
  const s = String(status || "").trim();
  if (ACTIVE_RUN_STATUSES.has(s)) return s;
  if (HISTORY_STATUS_ALIASES.has(s)) return HISTORY_STATUS_ALIASES.get(s);
  return fallback;
}

function normalizeActiveRun(input) {
  if (!input || typeof input !== "object") return null;
  const runId = String(input.runId || input.id || "").trim();
  if (!runId) return null;
  const startedAt = Number(input.startedAt) || Date.now();
  const updatedAt = Number(input.updatedAt) || Date.now();
  const finishedAt = input.finishedAt === null || input.finishedAt === undefined
    ? null
    : (Number(input.finishedAt) || null);
  const step = Math.max(0, Number(input.step) || 0);
  const maxSteps = Math.max(0, Number(input.maxSteps) || 0);
  const kind = input.kind === "generate" ? "generate" : "execute";
  return {
    runId,
    kind,
    status: normalizeActiveStatus(input.status),
    profile: String(input.profile || ""),
    profileLabel: String(input.profileLabel || ""),
    model: String(input.model || "").slice(0, 200),
    providerId: String(input.providerId || ""),
    providerName: String(input.providerName || ""),
    cwd: String(input.cwd || ""),
    mode: String(input.mode || ""),
    taskPreview: String(input.taskPreview || input.task || "").slice(0, 240),
    step,
    maxSteps,
    currentAction: String(input.currentAction || "").slice(0, 200),
    stepsLog: normalizeStepsLog(input.stepsLog),
    startedAt,
    updatedAt,
    finishedAt,
    durationMs: finishedAt ? Math.max(0, finishedAt - startedAt) : Math.max(0, updatedAt - startedAt),
    summary: String(input.summary || "").slice(0, 4000),
    modifiedFiles: normalizeStringArray(input.modifiedFiles),
    createdFiles: normalizeStringArray(input.createdFiles),
    error: String(input.error || "").slice(0, 1000)
  };
}

function slugifyId(name, existingIds) {
  const base = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || `provider-${crypto.randomBytes(3).toString("hex")}`;
  let candidate = base;
  let i = 2;
  while (existingIds.has(candidate)) {
    candidate = `${base}-${i++}`;
  }
  return candidate;
}

function normalizeModels(models) {
  if (!Array.isArray(models)) {
    if (typeof models === "string") {
      models = models.split(/[\n,]+/);
    } else {
      return [];
    }
  }
  const seen = new Set();
  const out = [];
  for (const item of models) {
    const id = String(item || "").trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export class OrchestratorStore {
  constructor(dataDir) {
    this.dataDir = resolveDataDir(dataDir);
    this.configPath = path.join(this.dataDir, "config.json");
    this.breakerPath = path.join(this.dataDir, "breaker-state.json");
    this.runsDir = path.join(this.dataDir, "runs");
    this.runsIndexPath = path.join(this.runsDir, "index.json");
    this.activeRunsPath = path.join(this.dataDir, "active-runs.json");
    this.ensureInitialized();
  }

  ensureInitialized() {
    ensureDir(this.dataDir);
    ensureDir(this.runsDir);
    if (!fs.existsSync(this.configPath)) {
      atomicWriteJson(this.configPath, defaultConfig());
    }
    if (!fs.existsSync(this.runsIndexPath)) {
      atomicWriteJson(this.runsIndexPath, []);
    }
    if (!fs.existsSync(this.activeRunsPath)) {
      atomicWriteJson(this.activeRunsPath, []);
    }
  }

  readRawConfig() {
    const base = defaultConfig();
    const loaded = readJsonSafe(this.configPath, null);
    if (!loaded || typeof loaded !== "object") {
      atomicWriteJson(this.configPath, base);
      return base;
    }
    const mergedProfiles = {};
    const rawProfiles = { ...base.routing.profiles, ...(loaded.routing?.profiles || {}) };
    for (const [k, v] of Object.entries(rawProfiles)) {
      if (!v || typeof v !== "object") continue;
      const b = BUILTIN_PROFILE_DEFAULTS[k] || {};
      mergedProfiles[k] = {
        label: String(v.label || b.label || k),
        description: String(v.description !== undefined ? v.description : (b.description || "")),
        defaultMode: ["readonly", "edit", "full"].includes(v.defaultMode) ? v.defaultMode : "",
        systemPrompt: String(v.systemPrompt || ""),
        primary: String(v.primary !== undefined ? v.primary : (b.primary || "")).trim(),
        fallbacks: Array.isArray(v.fallbacks)
          ? v.fallbacks.map((x) => String(x || "").trim()).filter(Boolean)
          : (Array.isArray(b.fallbacks) ? [...b.fallbacks] : []),
        builtin: BUILTIN_PROFILE_KEYS.includes(k)
      };
    }
    const defProf = loaded.routing?.defaultProfile && mergedProfiles[loaded.routing.defaultProfile]
      ? loaded.routing.defaultProfile
      : base.routing.defaultProfile;
    return {
      version: loaded.version || 1,
      providers: Array.isArray(loaded.providers) ? loaded.providers : base.providers,
      routing: {
        defaultProfile: defProf,
        profiles: mergedProfiles
      },
      circuitBreaker: { ...base.circuitBreaker, ...(loaded.circuitBreaker || {}) },
      worker: { ...base.worker, ...(loaded.worker || {}) }
    };
  }

  getProfileLabel(profileKey, cfgOpt) {
    const key = String(profileKey || "").trim();
    if (!key) return "";
    const cfg = cfgOpt || this.readRawConfig();
    const prof = cfg?.routing?.profiles?.[key];
    if (prof && prof.label) return String(prof.label);
    if (BUILTIN_PROFILE_DEFAULTS[key]?.label) return BUILTIN_PROFILE_DEFAULTS[key].label;
    return key;
  }

  saveRawConfig(cfg) {
    atomicWriteJson(this.configPath, cfg);
  }

  getSanitizedProvider(p) {
    const { apiKey, ...rest } = p;
    return {
      ...rest,
      hasApiKey: Boolean(apiKey && String(apiKey).trim()),
      apiKeyMasked: maskApiKey(apiKey)
    };
  }

  getPublicConfig() {
    const cfg = this.readRawConfig();
    return {
      ...cfg,
      providers: cfg.providers.map((p) => this.getSanitizedProvider(p))
    };
  }

  getProviderWithSecret(providerId) {
    const cfg = this.readRawConfig();
    return cfg.providers.find((p) => p.id === providerId) || null;
  }

  upsertProvider(input) {
    if (!input || typeof input !== "object") {
      throw new Error("无效的渠道配置对象");
    }
    const name = String(input.name || "").trim();
    const protocol = input.protocol === "anthropic" ? "anthropic" : input.protocol === "openai" ? "openai" : null;
    const baseUrl = String(input.baseUrl || "").trim();
    if (!name) throw new Error("渠道名称不能为空");
    if (!protocol) throw new Error("协议类型必须为 openai 或 anthropic");
    if (!baseUrl) throw new Error("Base URL 不能为空");

    const cfg = this.readRawConfig();
    const existingIdx = input.id ? cfg.providers.findIndex((p) => p.id === input.id) : -1;
    const existing = existingIdx >= 0 ? cfg.providers[existingIdx] : null;

    const existingIds = new Set(cfg.providers.map((p) => p.id));
    const id = existing ? existing.id : (input.id ? String(input.id).trim() : slugifyId(name, existingIds));

    let nextApiKey = existing ? existing.apiKey || "" : "";
    if (input.clearApiKey === true) {
      nextApiKey = "";
    } else if (typeof input.apiKey === "string") {
      const trimmed = input.apiKey.trim();
      if (trimmed && !trimmed.includes("****")) {
        nextApiKey = trimmed;
      }
    }

    const models = input.models !== undefined ? normalizeModels(input.models) : (existing?.models || []);
    let defaultModel = input.defaultModel !== undefined ? String(input.defaultModel || "").trim() : (existing?.defaultModel || "");
    if (models.length > 0 && (!defaultModel || !models.includes(defaultModel))) {
      defaultModel = models[0];
    }

    let headers = existing?.headers || {};
    if (input.headers !== undefined) {
      if (typeof input.headers === "string") {
        const raw = input.headers.trim();
        headers = raw ? JSON.parse(raw) : {};
      } else if (input.headers && typeof input.headers === "object" && !Array.isArray(input.headers)) {
        headers = input.headers;
      }
    }

    const timeoutMs = Number.isFinite(Number(input.timeoutMs))
      ? Math.max(5000, Math.min(600000, Number(input.timeoutMs)))
      : (existing?.timeoutMs || 120000);

    const record = {
      id,
      name,
      preset: String(input.preset ?? existing?.preset ?? "custom"),
      tag: String(input.tag ?? existing?.tag ?? "自定义").trim() || "自定义",
      protocol,
      baseUrl,
      apiKey: nextApiKey,
      enabled: input.enabled !== undefined ? Boolean(input.enabled) : (existing ? existing.enabled : true),
      models,
      defaultModel,
      timeoutMs,
      headers,
      lastTest: existing?.lastTest || null
    };

    if (existingIdx >= 0) {
      cfg.providers[existingIdx] = record;
    } else {
      cfg.providers.push(record);
    }
    this.saveRawConfig(cfg);
    return this.getSanitizedProvider(record);
  }

  deleteProvider(providerId) {
    const cfg = this.readRawConfig();
    const before = cfg.providers.length;
    cfg.providers = cfg.providers.filter((p) => p.id !== providerId);
    if (cfg.providers.length === before) {
      throw new Error(`未找到渠道：${providerId}`);
    }
    this.saveRawConfig(cfg);
    this.resetCircuit(providerId);
    return { deleted: true, id: providerId };
  }

  toggleProvider(providerId, enabled) {
    const cfg = this.readRawConfig();
    const p = cfg.providers.find((item) => item.id === providerId);
    if (!p) throw new Error(`未找到渠道：${providerId}`);
    p.enabled = enabled === undefined ? !p.enabled : Boolean(enabled);
    this.saveRawConfig(cfg);
    return this.getSanitizedProvider(p);
  }

  updateProviderTestResult(providerId, lastTest) {
    const cfg = this.readRawConfig();
    const p = cfg.providers.find((item) => item.id === providerId);
    if (!p) return null;
    p.lastTest = lastTest;
    this.saveRawConfig(cfg);
    return this.getSanitizedProvider(p);
  }

  updateRoutingAndSettings(payload) {
    const cfg = this.readRawConfig();
    if (payload.routing && typeof payload.routing === "object") {
      if (typeof payload.routing.defaultProfile === "string" && payload.routing.defaultProfile.trim()) {
        cfg.routing.defaultProfile = payload.routing.defaultProfile.trim();
      }
      if (payload.routing.profiles && typeof payload.routing.profiles === "object") {
        const nextProfiles = {};
        for (const [k, v] of Object.entries(payload.routing.profiles)) {
          if (!v || typeof v !== "object") continue;
          const prev = cfg.routing.profiles?.[k] || BUILTIN_PROFILE_DEFAULTS[k] || {};
          nextProfiles[k] = {
            label: String(v.label !== undefined ? v.label : (prev.label || k)).trim() || k,
            description: String(v.description !== undefined ? v.description : (prev.description || "")).trim(),
            defaultMode: v.defaultMode !== undefined
              ? (["readonly", "edit", "full"].includes(v.defaultMode) ? v.defaultMode : "")
              : (prev.defaultMode || ""),
            systemPrompt: String(v.systemPrompt !== undefined ? v.systemPrompt : (prev.systemPrompt || "")).trim(),
            primary: String(v.primary !== undefined ? v.primary : (prev.primary || "")).trim(),
            fallbacks: Array.isArray(v.fallbacks)
              ? v.fallbacks.map((x) => String(x || "").trim()).filter(Boolean)
              : (Array.isArray(prev.fallbacks) ? prev.fallbacks : []),
            builtin: BUILTIN_PROFILE_KEYS.includes(k)
          };
        }
        // 确保内置角色不会因局部提交而丢失
        for (const bk of BUILTIN_PROFILE_KEYS) {
          if (!nextProfiles[bk]) {
            nextProfiles[bk] = cfg.routing.profiles?.[bk] || { ...BUILTIN_PROFILE_DEFAULTS[bk], builtin: true };
          }
        }
        if (Object.keys(nextProfiles).length > 0) {
          cfg.routing.profiles = nextProfiles;
        }
        if (!cfg.routing.profiles[cfg.routing.defaultProfile]) {
          cfg.routing.defaultProfile = "default";
        }
      }
    }
    if (payload.circuitBreaker && typeof payload.circuitBreaker === "object") {
      const cb = payload.circuitBreaker;
      cfg.circuitBreaker = {
        enabled: cb.enabled !== undefined ? Boolean(cb.enabled) : cfg.circuitBreaker.enabled,
        failureThreshold: Number.isFinite(Number(cb.failureThreshold))
          ? Math.max(1, Math.min(20, Math.round(Number(cb.failureThreshold))))
          : cfg.circuitBreaker.failureThreshold,
        cooldownSec: Number.isFinite(Number(cb.cooldownSec))
          ? Math.max(5, Math.min(3600, Math.round(Number(cb.cooldownSec))))
          : cfg.circuitBreaker.cooldownSec
      };
    }
    if (payload.worker && typeof payload.worker === "object") {
      const w = payload.worker;
      const validModes = new Set(["readonly", "edit", "full"]);
      const maxStepsLimit = Number.isFinite(Number(w.maxStepsLimit))
        ? Math.max(5, Math.min(100, Math.round(Number(w.maxStepsLimit))))
        : cfg.worker.maxStepsLimit;
      const defaultMaxSteps = Number.isFinite(Number(w.defaultMaxSteps))
        ? Math.max(1, Math.min(maxStepsLimit, Math.round(Number(w.defaultMaxSteps))))
        : Math.min(cfg.worker.defaultMaxSteps, maxStepsLimit);
      cfg.worker = {
        defaultMode: validModes.has(w.defaultMode) ? w.defaultMode : cfg.worker.defaultMode,
        defaultMaxSteps,
        maxStepsLimit,
        commandTimeoutMs: Number.isFinite(Number(w.commandTimeoutMs))
          ? Math.max(3000, Math.min(300000, Math.round(Number(w.commandTimeoutMs))))
          : cfg.worker.commandTimeoutMs,
        allowOutsideWorkspace: w.allowOutsideWorkspace !== undefined
          ? Boolean(w.allowOutsideWorkspace)
          : cfg.worker.allowOutsideWorkspace,
        perTurnReinforce: w.perTurnReinforce !== undefined
          ? Boolean(w.perTurnReinforce)
          : cfg.worker.perTurnReinforce !== false
      };
    }
    this.saveRawConfig(cfg);
    return this.getPublicConfig();
  }

  upsertRoutingProfile(payload = {}) {
    const cfg = this.readRawConfig();
    const rawKey = String(payload.key || payload.id || "").trim();
    if (!rawKey) throw new Error("角色 ID 不能为空");
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(rawKey)) {
      throw new Error("角色 ID 仅允许 1~32 位英文字母、数字、连字符(-)或下划线(_)");
    }
    const prev = cfg.routing.profiles?.[rawKey] || BUILTIN_PROFILE_DEFAULTS[rawKey] || {};
    const label = String(payload.label !== undefined ? payload.label : (prev.label || rawKey)).trim() || rawKey;
    const description = String(payload.description !== undefined ? payload.description : (prev.description || "")).trim();
    const defaultMode = payload.defaultMode !== undefined
      ? (["readonly", "edit", "full"].includes(payload.defaultMode) ? payload.defaultMode : "")
      : (prev.defaultMode || "");
    const systemPrompt = String(payload.systemPrompt !== undefined ? payload.systemPrompt : (prev.systemPrompt || "")).trim();
    const primary = String(payload.primary !== undefined ? payload.primary : (prev.primary || "")).trim();
    const fallbacks = Array.isArray(payload.fallbacks)
      ? payload.fallbacks.map((x) => String(x || "").trim()).filter(Boolean)
      : (Array.isArray(prev.fallbacks) ? prev.fallbacks : []);

    cfg.routing.profiles[rawKey] = {
      label,
      description,
      defaultMode,
      systemPrompt,
      primary,
      fallbacks,
      builtin: BUILTIN_PROFILE_KEYS.includes(rawKey)
    };
    if (payload.setAsDefault === true) {
      cfg.routing.defaultProfile = rawKey;
    }
    this.saveRawConfig(cfg);
    return this.getPublicConfig();
  }

  deleteRoutingProfile(profileKey) {
    const key = String(profileKey || "").trim();
    if (!key) throw new Error("缺少角色 ID");
    if (BUILTIN_PROFILE_KEYS.includes(key)) {
      throw new Error(`内置角色 "${key}" 不可删除（可编辑其名称、模型与设定）`);
    }
    const cfg = this.readRawConfig();
    if (!cfg.routing.profiles?.[key]) {
      throw new Error(`未找到调度角色：${key}`);
    }
    delete cfg.routing.profiles[key];
    if (cfg.routing.defaultProfile === key) {
      cfg.routing.defaultProfile = "default";
    }
    this.saveRawConfig(cfg);
    return this.getPublicConfig();
  }

  getBreakerStates() {
    const raw = readJsonSafe(this.breakerPath, {});
    const now = Date.now();
    const out = {};
    for (const [providerId, entry] of Object.entries(raw || {})) {
      if (!entry || typeof entry !== "object") continue;
      const openUntil = Number(entry.openUntil || 0);
      out[providerId] = {
        consecutiveFailures: Number(entry.consecutiveFailures || 0),
        lastFailureAt: entry.lastFailureAt || null,
        openUntil: openUntil || null,
        isOpen: openUntil > now,
        remainingSec: openUntil > now ? Math.ceil((openUntil - now) / 1000) : 0,
        lastError: entry.lastError || ""
      };
    }
    return out;
  }

  isCircuitOpen(providerId) {
    const cfg = this.readRawConfig();
    if (!cfg.circuitBreaker.enabled) return false;
    const raw = readJsonSafe(this.breakerPath, {});
    const entry = raw?.[providerId];
    if (!entry) return false;
    return Number(entry.openUntil || 0) > Date.now();
  }

  recordSuccess(providerId) {
    const raw = readJsonSafe(this.breakerPath, {});
    if (raw[providerId]) {
      delete raw[providerId];
      atomicWriteJson(this.breakerPath, raw);
    }
  }

  recordFailure(providerId, errorMsg) {
    const cfg = this.readRawConfig();
    const raw = readJsonSafe(this.breakerPath, {});
    const prev = raw[providerId] || { consecutiveFailures: 0 };
    const consecutiveFailures = Number(prev.consecutiveFailures || 0) + 1;
    const threshold = cfg.circuitBreaker.failureThreshold || 3;
    const cooldownMs = (cfg.circuitBreaker.cooldownSec || 60) * 1000;
    const now = Date.now();
    const shouldTrip = cfg.circuitBreaker.enabled && consecutiveFailures >= threshold;
    raw[providerId] = {
      consecutiveFailures,
      lastFailureAt: now,
      openUntil: shouldTrip ? now + cooldownMs : (prev.openUntil && prev.openUntil > now ? prev.openUntil : 0),
      lastError: String(errorMsg || "Unknown error").slice(0, 400)
    };
    atomicWriteJson(this.breakerPath, raw);
    return raw[providerId];
  }

  resetCircuit(providerId) {
    const raw = readJsonSafe(this.breakerPath, {});
    if (!providerId) {
      atomicWriteJson(this.breakerPath, {});
      return {};
    }
    delete raw[providerId];
    atomicWriteJson(this.breakerPath, raw);
    return this.getBreakerStates();
  }

  // ---------------------------------------------------------------------------
  // 实时运行进度（active-runs.json）：为 MCP App 进度卡片 / aux_pane 提供数据源
  // ---------------------------------------------------------------------------

  _readActiveRunsRaw() {
    const raw = readJsonSafe(this.activeRunsPath, []);
    if (!Array.isArray(raw)) return [];
    return raw.map((item) => normalizeActiveRun(item)).filter(Boolean);
  }

  _writeActiveRuns(list) {
    const trimmed = (Array.isArray(list) ? list : [])
      .map((item) => normalizeActiveRun(item))
      .filter(Boolean)
      .sort((a, b) => (b.updatedAt || b.startedAt || 0) - (a.updatedAt || a.startedAt || 0))
      .slice(0, ACTIVE_RUN_LIMIT);
    atomicWriteJson(this.activeRunsPath, trimmed);
    return trimmed;
  }

  /**
   * 记录 / 更新一条正在执行（或刚结束）的任务进度。
   * 采用读-合并-原子写，绝不抛错给主执行流程（调用方仍建议 try/catch）。
   * @param {object} run 至少需要 runId；其余字段增量合并。
   * @returns {object|null} 合并后的完整进度记录
   */
  upsertActiveRun(run) {
    if (!run || typeof run !== "object") return null;
    const patch = normalizeActiveRun(run);
    if (!patch) return null;
    const list = this._readActiveRunsRaw();
    const idx = list.findIndex((item) => item.runId === patch.runId);
    let merged;
    if (idx >= 0) {
      const prev = list[idx];
      merged = normalizeActiveRun({
        ...prev,
        ...patch,
        // 列表类字段：显式传入则覆盖，未传则保留旧值（normalizeActiveRun 已保证为数组）
        stepsLog: Array.isArray(run.stepsLog) ? patch.stepsLog : prev.stepsLog,
        modifiedFiles: Array.isArray(run.modifiedFiles) ? patch.modifiedFiles : prev.modifiedFiles,
        createdFiles: Array.isArray(run.createdFiles) ? patch.createdFiles : prev.createdFiles,
        summary: run.summary !== undefined ? patch.summary : prev.summary,
        error: run.error !== undefined ? patch.error : prev.error,
        finishedAt: run.finishedAt !== undefined ? patch.finishedAt : prev.finishedAt,
        currentAction: run.currentAction !== undefined ? patch.currentAction : prev.currentAction,
        step: run.step !== undefined ? patch.step : prev.step,
        maxSteps: run.maxSteps !== undefined ? patch.maxSteps : prev.maxSteps,
        startedAt: prev.startedAt || patch.startedAt,
        updatedAt: patch.updatedAt || Date.now()
      });
      list[idx] = merged;
    } else {
      merged = patch;
      list.push(merged);
    }
    const written = this._writeActiveRuns(list);
    return written.find((item) => item.runId === merged.runId) || merged;
  }

  /**
   * 追加一条步骤日志（自动裁剪到最近 ACTIVE_RUN_STEPS_LIMIT 条）。
   */
  appendActiveRunStep(runId, entry) {
    if (!runId) return null;
    const list = this._readActiveRunsRaw();
    const idx = list.findIndex((item) => item.runId === runId);
    if (idx < 0) return null;
    const prev = list[idx];
    const stepsLog = normalizeStepsLog([
      ...prev.stepsLog,
      { ...entry, at: Number(entry?.at) || Date.now() }
    ]);
    const last = stepsLog[stepsLog.length - 1];
    list[idx] = normalizeActiveRun({
      ...prev,
      stepsLog,
      step: last?.step || prev.step,
      currentAction: last?.action || prev.currentAction,
      updatedAt: Date.now()
    });
    this._writeActiveRuns(list);
    return list[idx];
  }

  /**
   * 合并 active-runs 与最近 history，按时间降序返回摘要列表。
   */
  listProgressRuns(limit = ACTIVE_RUN_LIMIT) {
    const n = Math.max(1, Math.min(100, Number(limit) || ACTIVE_RUN_LIMIT));
    const active = this._readActiveRunsRaw();
    const activeIds = new Set(active.map((item) => item.runId));

    const cfg = this.readRawConfig();
    const history = this.listRuns(200).filter((item) => item && item.id && !activeIds.has(item.id));
    const fromHistory = history.map((item) => ({
      runId: item.id,
      kind: item.kind === "generate" ? "generate" : "execute",
      status: normalizeActiveStatus(item.status, "completed"),
      profile: item.profile || "",
      profileLabel: item.profileLabel || this.getProfileLabel(item.profile, cfg),
      model: item.model || "",
      providerId: item.providerId || "",
      providerName: item.providerName || "",
      cwd: item.cwd || "",
      mode: item.mode || "",
      taskPreview: item.taskPreview || "",
      step: item.steps || 0,
      maxSteps: 0,
      currentAction: "",
      startedAt: item.startedAt || 0,
      updatedAt: item.finishedAt || item.startedAt || 0,
      finishedAt: item.finishedAt || null,
      durationMs: item.durationMs || 0,
      summary: "",
      error: item.error || "",
      modifiedCount: item.modifiedCount || 0,
      createdCount: item.createdCount || 0,
      stepsCount: 0,
      source: "history"
    }));

    const merged = [
      ...active.map((item) => ({
        ...item,
        profileLabel: item.profileLabel || this.getProfileLabel(item.profile, cfg),
        modifiedCount: item.modifiedFiles.length,
        createdCount: item.createdFiles.length,
        stepsCount: item.stepsLog.length,
        source: "active"
      })),
      ...fromHistory
    ];

    // 运行中任务置顶，其余按 updatedAt / startedAt 降序
    merged.sort((a, b) => {
      const aRunning = a.status === "running" ? 1 : 0;
      const bRunning = b.status === "running" ? 1 : 0;
      if (aRunning !== bRunning) return bRunning - aRunning;
      const ta = a.updatedAt || a.startedAt || 0;
      const tb = b.updatedAt || b.startedAt || 0;
      return tb - ta;
    });

    return merged.slice(0, n);
  }

  /**
   * 返回单条任务的完整进度详情（优先 active-runs，其次 history 全量记录）。
   */
  getProgressRunDetail(runId) {
    const id = String(runId || "").trim();
    if (!id || /[\\/]/.test(id)) return null;
    const active = this._readActiveRunsRaw().find((item) => item.runId === id);
    const full = this.getRun(id);
    if (!active && !full) return null;
    if (!full) {
      return {
        ...active,
        modifiedCount: active.modifiedFiles.length,
        createdCount: active.createdFiles.length,
        source: "active"
      };
    }
    const base = active || normalizeActiveRun({
      runId: id,
      kind: full.kind,
      status: normalizeActiveStatus(full.status, "completed"),
      profile: full.profile,
      model: full.model,
      providerId: full.providerId,
      providerName: full.providerName,
      cwd: full.cwd,
      mode: full.mode,
      taskPreview: full.task,
      step: full.steps || 0,
      maxSteps: 0,
      currentAction: "",
      stepsLog: [],
      startedAt: full.startedAt,
      updatedAt: full.finishedAt || full.startedAt,
      finishedAt: full.finishedAt,
      summary: full.summary,
      modifiedFiles: full.modifiedFiles,
      createdFiles: full.createdFiles,
      error: full.error
    });
    return {
      ...base,
      stepsLog: base.stepsLog.length > 0 ? base.stepsLog : (Array.isArray(full.trace) ? full.trace.map((t) => ({
        step: t.step || 0,
        action: (t.tools || []).map((x) => `${x.tool || ""}`).filter(Boolean).join(", ") || "模型思考",
        tool: (t.tools || []).map((x) => x.tool).filter(Boolean).join(","),
        phase: "done",
        ok: (t.tools || []).every((x) => x.ok !== false),
        detail: String(t.thoughtPreview || "").slice(0, 400),
        at: full.startedAt || Date.now()
      })) : []),
      summary: base.summary || full.summary || "",
      modifiedFiles: base.modifiedFiles.length > 0 ? base.modifiedFiles : (full.modifiedFiles || []),
      createdFiles: base.createdFiles.length > 0 ? base.createdFiles : (full.createdFiles || []),
      error: base.error || full.error || "",
      trace: Array.isArray(full.trace) ? full.trace : [],
      usage: full.usage || null,
      modifiedCount: (base.modifiedFiles.length > 0 ? base.modifiedFiles : (full.modifiedFiles || [])).length,
      createdCount: (base.createdFiles.length > 0 ? base.createdFiles : (full.createdFiles || [])).length,
      source: active ? "active" : "history"
    };
  }

  createRun(meta) {
    const runId = `run_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const now = Date.now();
    const profileKey = meta.profile || "";
    const profileLabel = meta.profileLabel || (profileKey ? this.getProfileLabel(profileKey) : "");
    const full = {
      id: runId,
      kind: meta.kind || "execute",
      status: "running",
      task: String(meta.task || ""),
      cwd: meta.cwd || "",
      mode: meta.mode || "",
      profile: profileKey,
      profileLabel,
      providerId: meta.providerId || "",
      providerName: meta.providerName || "",
      model: meta.model || "",
      fallbackUsed: false,
      attempts: [],
      steps: 0,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      createdFiles: [],
      modifiedFiles: [],
      trace: [],
      summary: "",
      reasoningContent: "",
      error: "",
      startedAt: now,
      finishedAt: null,
      durationMs: 0
    };
    atomicWriteJson(path.join(this.runsDir, `${runId}.json`), full);
    this._upsertRunIndex(full);
    return full;
  }

  updateRun(runId, patch) {
    const runPath = path.join(this.runsDir, `${runId}.json`);
    const cur = readJsonSafe(runPath, null);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    if (next.finishedAt && next.startedAt && !patch.durationMs) {
      next.durationMs = Math.max(0, next.finishedAt - next.startedAt);
    }
    atomicWriteJson(runPath, next);
    this._upsertRunIndex(next);
    return next;
  }

  _upsertRunIndex(run) {
    const index = readJsonSafe(this.runsIndexPath, []);
    const existingEntry = Array.isArray(index) ? index.find((item) => item && item.id === run.id) : null;
    const summaryEntry = {
      id: run.id,
      kind: run.kind,
      status: run.status,
      taskPreview: String(run.task || "").slice(0, 140),
      cwd: run.cwd || "",
      mode: run.mode || "",
      profile: run.profile || "",
      profileLabel: run.profileLabel || existingEntry?.profileLabel || (run.profile ? this.getProfileLabel(run.profile) : ""),
      providerId: run.providerId || "",
      providerName: run.providerName || "",
      model: run.model || "",
      fallbackUsed: Boolean(run.fallbackUsed),
      steps: run.steps || 0,
      usage: run.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      createdCount: Array.isArray(run.createdFiles) ? run.createdFiles.length : 0,
      modifiedCount: Array.isArray(run.modifiedFiles) ? run.modifiedFiles.length : 0,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs || 0,
      error: run.error || "",
      archived: Boolean(run.archived ?? existingEntry?.archived ?? false),
      archivedAt: run.archivedAt ?? existingEntry?.archivedAt ?? null
    };
    const filtered = Array.isArray(index) ? index.filter((item) => item && item.id !== run.id) : [];
    filtered.unshift(summaryEntry);
    atomicWriteJson(this.runsIndexPath, filtered.slice(0, 200));
  }

  listRuns(limit = 30, options = {}) {
    const index = readJsonSafe(this.runsIndexPath, []);
    if (!Array.isArray(index)) return [];
    const wantArchived = Boolean(options?.archived);
    const filtered = index.filter((item) => item && Boolean(item.archived) === wantArchived);
    const n = Math.max(1, Math.min(200, Number(limit) || 30));
    return filtered.slice(0, n);
  }

  archiveRuns(ids = []) {
    const idSet = new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean));
    if (idSet.size === 0) return { count: 0 };
    const index = readJsonSafe(this.runsIndexPath, []);
    if (!Array.isArray(index)) return { count: 0 };
    const now = Date.now();
    let count = 0;
    for (const item of index) {
      if (item && idSet.has(item.id) && !item.archived) {
        item.archived = true;
        item.archivedAt = now;
        count++;
        const runPath = path.join(this.runsDir, `${item.id}.json`);
        const full = readJsonSafe(runPath, null);
        if (full) {
          full.archived = true;
          full.archivedAt = now;
          atomicWriteJson(runPath, full);
        }
      }
    }
    atomicWriteJson(this.runsIndexPath, index);
    return { count };
  }

  archiveAllRuns() {
    const index = readJsonSafe(this.runsIndexPath, []);
    if (!Array.isArray(index)) return { count: 0 };
    const activeIds = index.filter((item) => item && !item.archived).map((item) => item.id);
    return this.archiveRuns(activeIds);
  }

  unarchiveRuns(ids = []) {
    const idSet = new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean));
    if (idSet.size === 0) return { count: 0 };
    const index = readJsonSafe(this.runsIndexPath, []);
    if (!Array.isArray(index)) return { count: 0 };
    let count = 0;
    for (const item of index) {
      if (item && idSet.has(item.id) && item.archived) {
        item.archived = false;
        item.archivedAt = null;
        count++;
        const runPath = path.join(this.runsDir, `${item.id}.json`);
        const full = readJsonSafe(runPath, null);
        if (full) {
          full.archived = false;
          full.archivedAt = null;
          atomicWriteJson(runPath, full);
        }
      }
    }
    atomicWriteJson(this.runsIndexPath, index);
    return { count };
  }

  deleteRuns(ids = []) {
    const idSet = new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean));
    if (idSet.size === 0) return { count: 0 };
    const index = readJsonSafe(this.runsIndexPath, []);
    if (!Array.isArray(index)) return { count: 0 };
    let count = 0;
    const kept = [];
    for (const item of index) {
      if (item && idSet.has(item.id)) {
        count++;
        try {
          fs.unlinkSync(path.join(this.runsDir, `${item.id}.json`));
        } catch {}
      } else if (item) {
        kept.push(item);
      }
    }
    atomicWriteJson(this.runsIndexPath, kept);
    return { count };
  }

  clearArchivedRuns() {
    const index = readJsonSafe(this.runsIndexPath, []);
    if (!Array.isArray(index)) return { count: 0 };
    const archivedIds = index.filter((item) => item && item.archived).map((item) => item.id);
    return this.deleteRuns(archivedIds);
  }

  getRun(runId) {
    if (!runId || /[\\/]/.test(runId)) return null;
    return readJsonSafe(path.join(this.runsDir, `${runId}.json`), null);
  }

  clearRuns() {
    ensureDir(this.runsDir);
    for (const file of fs.readdirSync(this.runsDir)) {
      if (file.endsWith(".json") && file !== "index.json") {
        try {
          fs.unlinkSync(path.join(this.runsDir, file));
        } catch {}
      }
    }
    atomicWriteJson(this.runsIndexPath, []);
    return { cleared: true };
  }
}
