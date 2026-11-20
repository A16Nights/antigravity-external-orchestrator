import { checkGithubUpdate } from "../../lib/update-checker.mjs";
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

function getWebUrl() {
  return TOKEN
    ? `http://127.0.0.1:${actualPort}/?token=${encodeURIComponent(TOKEN)}`
    : `http://127.0.0.1:${actualPort}/`;
}

function buildStatePayload() {
  return {
    config: store.getPublicConfig(),
    presets: PROVIDER_PRESETS,
    breakerStates: store.getBreakerStates(),
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
    res.end(html);
    return;
  }

  if (pathname.startsWith("/api/")) {
    if (!checkAuth(req, url)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    try {
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
      if (req.method === "POST" && pathname === "/api/breaker/reset") {
        const body = await readBody(req);
        store.resetCircuit(body.providerId || undefined);
        sendJson(res, 200, { ok: true, state: buildStatePayload() });
        return;
      }
      if (req.method === "GET" && pathname === "/api/runs") {
        const limit = Number(url.searchParams.get("limit")) || 40;
        sendJson(res, 200, { runs: store.listRuns(limit) });
        return;
      }
      if (req.method === "GET" && pathname === "/api/run") {
        const id = url.searchParams.get("id") || "";
        const run = store.getRun(id);
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
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
