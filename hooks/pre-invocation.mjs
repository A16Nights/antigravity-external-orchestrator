#!/usr/bin/env node
import { OrchestratorStore } from "../lib/store.mjs";

function main() {
  try {
    const store = new OrchestratorStore();
    const cfg = store.getPublicConfig();
    if (cfg.worker?.perTurnReinforce === false) {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    const enabledProviders = (cfg.providers || []).filter((p) => p && p.enabled !== false);
    if (!enabledProviders.length) {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    const names = enabledProviders
      .slice(0, 4)
      .map((p) => p.name || p.id)
      .join(" / ");
    const extra = enabledProviders.length > 4 ? ` 等 ${enabledProviders.length} 个` : "";

    const msg =
      `[苍蓝协奏台 · 派单提醒] 本机已启用外部高性价比执行手（${names}${extra}）。` +
      `凡涉及读多个/长文件、写 >15 行代码、重构、跑命令查长日志或长文本生成，优先调用 worker_execute / worker_generate 派单执行并轻量抽查验收，节省主脑 Token。`;

    process.stdout.write(JSON.stringify({ systemMessage: msg }));
  } catch {
    process.stdout.write(JSON.stringify({}));
  }
}

main();
