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
      profiles: {
        default: {
          label: "默认执行手",
          primary: "deepseek:deepseek-chat",
          fallbacks: []
        },
        coder: {
          label: "代码与文件修改",
          primary: "deepseek:deepseek-chat",
          fallbacks: []
        },
        fast: {
          label: "轻量快速处理",
          primary: "deepseek:deepseek-chat",
          fallbacks: []
        },
        reasoner: {
          label: "深度分析辅助",
          primary: "deepseek:deepseek-reasoner",
          fallbacks: ["deepseek:deepseek-chat"]
        }
      }
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
  }

  readRawConfig() {
    const base = defaultConfig();
    const loaded = readJsonSafe(this.configPath, null);
    if (!loaded || typeof loaded !== "object") {
      atomicWriteJson(this.configPath, base);
      return base;
    }
    return {
      version: loaded.version || 1,
      providers: Array.isArray(loaded.providers) ? loaded.providers : base.providers,
      routing: {
        defaultProfile: loaded.routing?.defaultProfile || base.routing.defaultProfile,
        profiles: { ...base.routing.profiles, ...(loaded.routing?.profiles || {}) }
      },
      circuitBreaker: { ...base.circuitBreaker, ...(loaded.circuitBreaker || {}) },
      worker: { ...base.worker, ...(loaded.worker || {}) }
    };
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
          nextProfiles[k] = {
            label: String(v.label || k),
            primary: String(v.primary || "").trim(),
            fallbacks: Array.isArray(v.fallbacks)
              ? v.fallbacks.map((x) => String(x || "").trim()).filter(Boolean)
              : []
          };
        }
        if (Object.keys(nextProfiles).length > 0) {
          cfg.routing.profiles = nextProfiles;
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

  createRun(meta) {
    const runId = `run_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const now = Date.now();
    const full = {
      id: runId,
      kind: meta.kind || "execute",
      status: "running",
      task: String(meta.task || ""),
      cwd: meta.cwd || "",
      mode: meta.mode || "",
      profile: meta.profile || "",
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
