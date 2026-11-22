export const RUN_CARD_URI = "ui://external-orchestrator/run-card.html";

function safeJsonForHtml(obj) {
  return JSON.stringify(obj ?? {}).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

const BASE_CSS = `
  :root {
    --bg: #0b1220;
    --card: rgba(16, 26, 46, 0.92);
    --card-2: rgba(22, 36, 62, 0.85);
    --border: rgba(96, 165, 250, 0.22);
    --text: #e2ecf8;
    --muted: #8ea4c2;
    --accent: #38bdf8;
    --ok: #34d399;
    --warn: #fbbf24;
    --err: #f87171;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 10px 12px;
    background: var(--bg); color: var(--text);
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  .card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 12px; padding: 12px 14px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.28);
  }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .between { justify-content: space-between; }
  .title { font-weight: 600; font-size: 13.5px; color: #f0f7ff; }
  .badge {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600;
    background: rgba(56, 189, 248, 0.14); color: var(--accent); border: 1px solid rgba(56, 189, 248, 0.3);
  }
  .badge.ok { background: rgba(52, 211, 153, 0.14); color: var(--ok); border-color: rgba(52, 211, 153, 0.32); }
  .badge.warn { background: rgba(251, 191, 36, 0.14); color: var(--warn); border-color: rgba(251, 191, 36, 0.32); }
  .badge.err { background: rgba(248, 113, 113, 0.14); color: var(--err); border-color: rgba(248, 113, 113, 0.32); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .pulse { animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .4; transform: scale(.8); } }
  .bar-wrap { height: 6px; border-radius: 999px; background: rgba(148,163,184,0.16); overflow: hidden; margin: 9px 0; }
  .bar { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #0ea5e9, #38bdf8, #818cf8); transition: width .25s ease; }
  .meta { font-size: 11.5px; color: var(--muted); }
  .action {
    margin-top: 6px; padding: 6px 9px; border-radius: 8px;
    background: var(--card-2); border: 1px solid rgba(148,163,184,0.14);
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px;
    color: #cfe4ff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .summary {
    margin-top: 8px; padding: 8px 10px; border-radius: 8px;
    background: rgba(15, 23, 42, 0.65); border: 1px solid rgba(148,163,184,0.12);
    font-size: 12px; color: #dbeafe; white-space: pre-wrap; max-height: 160px; overflow-y: auto;
  }
  .btn {
    background: rgba(56, 189, 248, 0.12); color: #bae6fd;
    border: 1px solid rgba(56, 189, 248, 0.28); border-radius: 7px;
    padding: 3px 9px; font-size: 11.5px; cursor: pointer;
  }
  .btn:hover { background: rgba(56, 189, 248, 0.22); }
  .btn.active { background: rgba(56, 189, 248, 0.28); color: #fff; border-color: #38bdf8; }
`;

const MCP_BRIDGE_JS = `
  let rpcId = 1;
  const pending = new Map();
  function sendRpc(method, params) {
    const id = rpcId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("RPC timeout")); }, 8000);
      pending.set(id, { resolve, reject, timer });
      window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
    });
  }
  async function callApi(action, payload = {}) {
    const res = await sendRpc("tools/call", { name: "worker_progress_api", arguments: { action, payload } });
    if (res && res.structuredContent) return res.structuredContent;
    const txt = res && res.content && res.content[0] && res.content[0].text;
    return txt ? JSON.parse(txt) : res;
  }
  function esc(s) {
    return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  function statusMeta(st) {
    if (st === "running") return { cls: "", label: "执行中", pulse: true };
    if (st === "completed") return { cls: "ok", label: "已完成", pulse: false };
    if (st === "max_steps_reached") return { cls: "warn", label: "达步数上限", pulse: false };
    return { cls: "err", label: "异常中断", pulse: false };
  }
`;

export function buildInlineRunCardHtml(initialSnapshot = {}) {
  const initJson = safeJsonForHtml(initialSnapshot);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>苍蓝协奏台 · 实时执行卡片</title>
<style>${BASE_CSS}</style>
</head>
<body>
<div id="app" class="card">
  <div class="row between">
    <span class="title">苍蓝协奏台 · 外部执行手</span>
    <span class="badge"><span class="dot pulse"></span>连接中</span>
  </div>
  <div class="meta" style="margin-top:6px;">正在获取执行状态...</div>
</div>
<script>
(() => {
  ${MCP_BRIDGE_JS}
  let state = ${initJson};
  let targetRunId = "";
  let toolDone = false;

  function pickRun(runs) {
    if (!Array.isArray(runs) || !runs.length) return null;
    if (targetRunId) {
      const exact = runs.find((r) => r.runId === targetRunId);
      if (exact) return exact;
    }
    return runs.find((r) => r.status === "running") || runs[0];
  }

  function renderRun(run) {
    const el = document.getElementById("app");
    if (!run) {
      el.innerHTML = '<div class="row between"><span class="title">苍蓝协奏台 · 外部执行手</span><span class="badge">等待任务</span></div><div class="meta" style="margin-top:6px;">暂无正在执行的任务</div>';
      return;
    }
    const sm = statusMeta(run.status);
    const maxS = Math.max(1, Number(run.maxSteps) || 1);
    const step = Math.min(maxS, Number(run.step) || 0);
    const pct = run.status === "completed" ? 100 : Math.max(6, Math.round((step / maxS) * 100));
    const modCount = Number(run.modifiedCount ?? (run.modifiedFiles?.length || 0));
    const newCount = Number(run.createdCount ?? (run.createdFiles?.length || 0));
    const roleText = run.profileLabel && run.profile && run.profileLabel !== run.profile
      ? (run.profileLabel + " (" + run.profile + ")")
      : (run.profileLabel || run.profile || "");
    const titleText = [roleText ? ("[" + roleText + "]") : "", run.model || "外部执行手"].filter(Boolean).join(" ");
    el.innerHTML = \`
      <div class="row between">
        <span class="title">\${esc(titleText)}</span>
        <span class="badge \${sm.cls}"><span class="dot \${sm.pulse ? "pulse" : ""}"></span>\${sm.label} · \${step}/\${maxS} 步</span>
      </div>
      <div class="bar-wrap"><div class="bar" style="width:\${pct}%"></div></div>
      <div class="row between meta">
        <span>任务：\${esc((run.taskPreview || "").slice(0, 72) || "执行中")}</span>
        <span>改 \${modCount} / 建 \${newCount}</span>
      </div>
      \${run.currentAction ? \`<div class="action">▶ \${esc(run.currentAction)}</div>\` : ""}
      \${run.summary ? \`<div class="summary">\${esc(run.summary.slice(0, 600))}</div>\` : ""}
    \`;
  }

  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || "RPC error"));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "ui/notifications/tool-result") {
      toolDone = true;
      const sc = msg.params?.structuredContent;
      if (sc && sc.runId) { targetRunId = sc.runId; }
      refresh();
    }
  });

  async function refresh() {
    try {
      const data = await callApi("list", { limit: 10 });
      const run = pickRun(data?.runs || []);
      if (run && !targetRunId && run.status === "running") targetRunId = run.runId;
      renderRun(run);
    } catch {}
  }

  renderRun(pickRun(state?.runs || []));
  sendRpc("ui/initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "eo-run-card", version: "1.0.0" } })
    .then(() => {
      window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, "*");
      refresh();
    })
    .catch(() => {});
  setInterval(() => { if (!toolDone) refresh(); }, 2000);
})();
</script>
</body>
</html>`;
}
