#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OrchestratorStore } from "../lib/store.mjs";
import { isExternalModel } from "../lib/external-model-guard.mjs";

const DATA_DIR = process.env.EXTERNAL_ORCHESTRATOR_DATA_DIR
  ? path.resolve(process.env.EXTERNAL_ORCHESTRATOR_DATA_DIR)
  : path.join(process.env.USERPROFILE || os.homedir(), ".gemini", "external-orchestrator");
const DEDUP_FILE = path.join(DATA_DIR, "reinforce-dedup.json");

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data.trim()));
    process.stdin.on("error", () => resolve(""));
  });
}

function shouldSkipSameTurn(input) {
  try {
    const cid = String(input.conversationId || input.conversation_id || "").trim();
    const step = input.initialNumSteps ?? input.initial_num_steps;
    if (!cid || step === undefined || step === null) return false;
    const key = `${cid}:${step}`;
    let state = {};
    if (fs.existsSync(DEDUP_FILE)) {
      state = JSON.parse(fs.readFileSync(DEDUP_FILE, "utf8")) || {};
    }
    if (state.lastKey === key) return true;
    fs.mkdirSync(path.dirname(DEDUP_FILE), { recursive: true });
    const tmp = `${DEDUP_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ lastKey: key, updatedAt: Date.now() }), "utf8");
    fs.renameSync(tmp, DEDUP_FILE);
    return false;
  } catch {
    return false;
  }
}

async function main() {
  try {
    const raw = await readStdin();
    let input = {};
    if (raw) {
      try {
        input = JSON.parse(raw) || {};
      } catch {
        input = {};
      }
    }

    const store = new OrchestratorStore();
    const cfg = store.getPublicConfig();
    if (cfg.worker?.perTurnReinforce === false) {
      process.stdout.write("{}\n");
      return;
    }

    // 仅对外接自定义模型生效；Antigravity 内部模型自动跳过
    if (!isExternalModel(input)) {
      process.stdout.write("{}\n");
      return;
    }

    const enabledProviders = (cfg.providers || []).filter((p) => p && p.enabled !== false);
    if (!enabledProviders.length) {
      process.stdout.write("{}\n");
      return;
    }

    if (shouldSkipSameTurn(input)) {
      process.stdout.write("{}\n");
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

    process.stdout.write(
      JSON.stringify({
        injectSteps: [
          {
            systemMessage: {
              systemMessage: msg
            }
          }
        ]
      }) + "\n"
    );
  } catch {
    process.stdout.write("{}\n");
  }
}

main();
