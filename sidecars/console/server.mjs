import { checkGithubUpdate } from "../../lib/update-checker.mjs";
import { isLeftSidebarEnabled, setLeftSidebarEnabled, listOwnedPluginsNavState, registerSidecarRuntime, refreshAntigravityMcpServers, injectSidebarToggleWidget } from "../../lib/sidebar-nav.mjs";
import { handleAzureThemeHttp } from "../../lib/azure-theme.mjs";
import { injectAzureUiKit } from "../../lib/azure-ui-kit.mjs";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { OrchestratorStore, PROVIDER_PRESETS } from "../../lib/store.mjs";
import { fetchProviderModels, testProvider } from "../../lib/llm-client.mjs";
import { generateOnce } from "../../lib/executor.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, "index.html");
const store = new OrchestratorStore();

const PORT = parseInt(
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || "18795",
  10
);
const TOKEN = (
  process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN ||
  process.env.ANTIGRAVITY_SIDECAR_AUTH_TOKEN ||
  process.env.ANTIGRAVITY_SIDECAR_WEB_TOKEN ||
  ""
).trim();

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c;
      if (buf.length > 2 * 1024 * 1024) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function checkAuth(req, url) {
  if (!TOKEN) return true;
  const hdr = req.headers["x-codeium-sidecar-token"] || req.headers["x-sidecar-token"];
  const q = url.searchParams.get("token");
  return hdr === TOKEN || q === TOKEN;
}

let actualPort = PORT;
const activeSseClosers = [];
const MAX_SSE_CLIENTS = 2;

function getWebUrl() {
  return TOKEN
    ? `http://127.0.0.1:${actualPort}/?token=${encodeURIComponent(TOKEN)}`
    : `http://127.0.0.1:${actualPort}/`;
}

function getActiveRunsPayload() {
  return store.listProgressRuns(20).filter((r) => r && r.status === "running");
}

function buildStatePayload() {
  return {
    config: store.getPublicConfig(),
    presets: PROVIDER_PRESETS,
    breakerStates: store.getBreakerStates(),
    activeRuns: getActiveRunsPayload(),
    runs: store.listRuns(100, { archived: false }),
    archivedRuns: store.listRuns(100, { archived: true }),
    configPath: store.configPath,
    webUrl: getWebUrl()
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${actualPort}`);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/api/check-update") {
    const force = new URL(req.url, "http://127.0.0.1").searchParams.get("force") === "1";
    const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const info = await checkGithubUpdate({ pluginRoot, repo: "A16Nights/antigravity-external-orchestrator", force });
    sendJson(res, 200, info);
    return;
  }

  if (pathname === "/healthz") {
    sendJson(res, 200, { ok: true, service: "external-orchestrator-console" });
    return;
  }

  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    const html = fs.readFileSync(HTML_PATH, "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(injectAzureUiKit(injectSidebarToggleWidget(html, "external-orchestrator"), "external-orchestrator"));
    return;
  }

  if (pathname.startsWith("/api/")) {
    if (!checkAuth(req, url)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    try {
      if (await handleAzureThemeHttp(req, res)) return;
    if (req.method === "GET" && pathname === "/api/sidebar-nav") {
        sendJson(res, 200, {
          ok: true,
          pluginId: "external-orchestrator",
          showInLeftSidebar: isLeftSidebarEnabled("external-orchestrator"),
          plugins: listOwnedPluginsNavState()
        });
        return;
      }
      if (req.method === "POST" && pathname === "/api/sidebar-nav") {
        const body = await readBody(req);
        const targetId = String(body.pluginId || "external-orchestrator").trim();
        const nextVal = Boolean(body.showInLeftSidebar);
        setLeftSidebarEnabled(targetId, nextVal);
        const rf = await refreshAntigravityMcpServers();
        sendJson(res, 200, {
          ok: true,
          pluginId: targetId,
          showInLeftSidebar: nextVal,
          refreshed: Boolean(rf?.ok),
          plugins: listOwnedPluginsNavState()
        });
        return;
      }
      if (req.method === "GET" && pathname === "/api/state") {
        sendJson(res, 200, buildStatePayload());
        return;
      }
      if (req.method === "POST" && pathname === "/api/provider") {
        const body = await readBody(req);
        const saved = store.upsertProvider(body);
        sendJson(res, 200, { provider: saved, state: buildStatePayload() });
        return;
      }
      if (req.method === "POST" && pathname === "/api/provider/delete") {
        const body = await readBody(req);
        store.deleteProvider(body.id);
        sendJson(res, 200, { ok: true, state: buildStatePayload() });
        return;
      }
      if (req.method === "POST" && pathname === "/api/provider/toggle") {
        const body = await readBody(req);
        const updated = store.toggleProvider(body.id, body.enabled);
        sendJson(res, 200, { provider: updated, state: buildStatePayload() });
        return;
      }
      if (req.method === "POST" && pathname === "/api/provider/test") {
        const body = await readBody(req);
        const result = await testProvider(store, body.id, body.model);
        sendJson(res, 200, { result, state: buildStatePayload() });
        return;
      }
      if (req.method === "POST" && pathname === "/api/provider/models") {
        const body = await readBody(req);
        const existing = body.id ? store.getProviderWithSecret(body.id) : null;
        let apiKey = existing?.apiKey || "";
        if (body.clearApiKey === true) {
          apiKey = "";
        } else if (typeof body.apiKey === "string" && body.apiKey.trim() && !body.apiKey.includes("****")) {
          apiKey = body.apiKey.trim();
        }
        let headers = existing?.headers || {};
        if (body.headers && typeof body.headers === "object" && !Array.isArray(body.headers)) {
          headers = body.headers;
        } else if (typeof body.headers === "string" && body.headers.trim()) {
          headers = JSON.parse(body.headers.trim());
        }
        const probeTarget = {
          id: body.id || "probe",
          name: body.name || existing?.name || "Probe",
          protocol: body.protocol || existing?.protocol || "openai",
          baseUrl: String(body.baseUrl || existing?.baseUrl || "").trim(),
          apiKey,
          timeoutMs: Number(body.timeoutMs || existing?.timeoutMs || 20000),
          headers
        };
        const models = await fetchProviderModels(probeTarget);
        if (body.save && existing && models.length > 0) {
          const merged = Array.from(new Set([...(existing.models || []), ...models]));
          store.upsertProvider({ id: existing.id, name: existing.name, protocol: existing.protocol, baseUrl: existing.baseUrl, models: merged });
        }
        sendJson(res, 200, { models, state: buildStatePayload() });
        return;
      }
      if (req.method === "POST" && pathname === "/api/routing") {
        const body = await readBody(req);
        store.updateRoutingAndSettings(body);
        sendJson(res, 200, { ok: true, state: buildStatePayload() });
        return;
      }
      if (req.method === "POST" && pathname === "/api/routing/profile") {
        const body = await readBody(req);
        store.upsertRoutingProfile(body);
        sendJson(res, 200, { ok: true, state: buildStatePayload() });
        return;
      }
      if (req.method === "POST" && pathname === "/api/routing/profile/delete") {
        const body = await readBody(req);
        store.deleteRoutingProfile(body.key);
        sendJson(res, 200, { ok: true, state: buildStatePayload() });
        return;
      }
      if (req.method === "POST" && pathname === "/api/reinforce") {
        const body = await readBody(req);
        store.updateRoutingAndSettings({ worker: { perTurnReinforce: Boolean(body.enabled) } });
        sendJson(res, 200, { ok: true, state: buildStatePayload() });
        return;
      }
      if (req.method === "POST" && pathname === "/api/breaker/reset") {
        const body = await readBody(req);
        store.resetCircuit(body.providerId || undefined);
        sendJson(res, 200, { ok: true, state: buildStatePayload() });
        return;
      }
      if (req.method === "GET" && pathname === "/api/active-runs") {
        sendJson(res, 200, { activeRuns: getActiveRunsPayload(), serverTime: Date.now() });
        return;
      }
      if (req.method === "GET" && pathname === "/api/active-runs/stream") {
        while (activeSseClosers.length >= MAX_SSE_CLIENTS) {
          const oldest = activeSseClosers.shift();
          try { oldest?.(); } catch {}
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no"
        });
        let closed = false;
        let lastJson = "";
        let lastIds = new Set();
        const pushSnapshot = (force = false) => {
          if (closed) return;
          try {
            const list = getActiveRunsPayload();
            const nextIds = new Set(list.map((r) => r.runId));
            let finishedAny = false;
            for (const oldId of lastIds) {
              if (!nextIds.has(oldId)) { finishedAny = true; break; }
            }
            lastIds = nextIds;
            const payload = JSON.stringify({ activeRuns: list, finishedAny, serverTime: Date.now() });
            if (force || payload !== lastJson || finishedAny) {
              lastJson = payload;
              res.write(`event: active_runs\ndata: ${payload}\n\n`);
            }
          } catch {}
        };
        pushSnapshot(true);
        const timer = setInterval(() => pushSnapshot(false), 1000);
        const pingTimer = setInterval(() => {
          if (!closed) { try { res.write(": keepalive\n\n"); } catch {} }
        }, 15000);
        const cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          clearInterval(pingTimer);
          const idx = activeSseClosers.indexOf(cleanup);
          if (idx >= 0) activeSseClosers.splice(idx, 1);
          try { res.end(); } catch {}
        };
        activeSseClosers.push(cleanup);
        req.on("close", cleanup);
        res.on("close", cleanup);
        return;
      }
      if (req.method === "GET" && pathname === "/api/runs") {
        const limit = Number(url.searchParams.get("limit")) || 40;
        sendJson(res, 200, { runs: store.listRuns(limit) });
        return;
      }
      if (req.method === "GET" && pathname === "/api/run") {
        const id = url.searchParams.get("id") || "";
        const run = store.getRun(id) || store.getProgressRunDetail(id);
        if (!run) {
          sendJson(res, 404, { error: "Run not found" });
          return;
        }
        sendJson(res, 200, { run });
        return;
      }
      if (req.method === "POST" && pathname === "/api/runs/clear") {
        store.clearRuns();
        sendJson(res, 200, { ok: true, state: buildStatePayload() });
        return;
      }
      if (req.method === "POST" && pathname === "/api/runs/archive") {
        const body = await readBody(req);
        const result = body.all ? store.archiveAllRuns() : store.archiveRuns(body.ids || (body.id ? [body.id] : []));
        sendJson(res, 200, { ok: true, ...result, state: buildStatePayload() });
        return;
      }
      if (req.method === "POST" && pathname === "/api/runs/unarchive") {
        const body = await readBody(req);
        const result = store.unarchiveRuns(body.ids || (body.id ? [body.id] : []));
        sendJson(res, 200, { ok: true, ...result, state: buildStatePayload() });
        return;
      }
      if (req.method === "POST" && pathname === "/api/runs/delete") {
        const body = await readBody(req);
        const result = body.allArchived ? store.clearArchivedRuns() : store.deleteRuns(body.ids || (body.id ? [body.id] : []));
        sendJson(res, 200, { ok: true, ...result, state: buildStatePayload() });
        return;
      }
      if (req.method === "POST" && pathname === "/api/playground") {
        const body = await readBody(req);
        const result = await generateOnce(store, {
          prompt: body.prompt,
          system: body.system,
          profile: body.profile,
          provider: body.provider,
          model: body.model,
          temperature: body.temperature !== undefined && body.temperature !== "" ? Number(body.temperature) : undefined,
          maxTokens: body.maxTokens !== undefined && body.maxTokens !== "" ? Number(body.maxTokens) : undefined
        });
        sendJson(res, 200, { result, state: buildStatePayload() });
        return;
      }
      if (req.method === "POST" && pathname === "/api/open-config") {
        store.ensureInitialized();
        if (process.platform === "win32") {
          const child = spawn("explorer.exe", [`/select,${store.configPath}`], {
            detached: true,
            stdio: "ignore"
          });
          child.unref();
        }
        sendJson(res, 200, { ok: true, path: store.configPath });
        return;
      }
      sendJson(res, 404, { error: "API route not found" });
    } catch (err) {
      sendJson(res, 400, { error: err?.message || String(err) });
    }
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

server.listen(PORT, "127.0.0.1", () => {
  const addr = server.address();
  if (addr && typeof addr === "object") actualPort = addr.port;
  console.log(`[external-orchestrator console] listening on http://127.0.0.1:${actualPort}`);
  try {
    const __a = server.address();
    const __p = (__a && typeof __a === "object" && __a.port) ? __a.port : Number(PORT) || 0;
    const __t = (process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || process.env.ANTIGRAVITY_SIDECAR_AUTH_TOKEN || process.env.ANTIGRAVITY_SIDECAR_WEB_TOKEN || "").trim();
    const __u = __t ? `http://127.0.0.1:${__p}/?token=${encodeURIComponent(__t)}` : `http://127.0.0.1:${__p}/`;
    registerSidecarRuntime("external-orchestrator", { port: __p, url: __u });
  } catch {}
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
