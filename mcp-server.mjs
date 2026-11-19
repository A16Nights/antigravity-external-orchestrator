#!/usr/bin/env node
import readline from "node:readline";
import { OrchestratorStore } from "./lib/store.mjs";
import { testProvider } from "./lib/llm-client.mjs";
import { executeWorkerTask, generateOnce } from "./lib/executor.mjs";

const store = new OrchestratorStore();

const TOOLS = [
  {
    name: "worker_list_models",
    description: "列出已配置的外部模型渠道（密钥已脱敏）、可用模型、角色路由配置、断路器实时状态以及控制台链接。",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "worker_execute",
    description: "将多步代码编写、文件阅读/修改、文本批处理或命令检查任务委派给外部执行手模型（如 DeepSeek / OFM），自动完成多步工具调用并返回改动摘要。",
    inputSchema: {
      type: "object",
      required: ["task", "cwd"],
      properties: {
        task: { type: "string", description: "清晰具体的执行指令与完成标准" },
        cwd: { type: "string", description: "工作目录绝对路径，执行手工具被限制在此目录内（除非全局允许越界）" },
        profile: { type: "string", description: "路由角色名（如 default / coder / fast / reasoner），省略则用默认角色" },
        provider: { type: "string", description: "可选：显式指定渠道 ID（会优先尝试该渠道，失败再按路由 fallback）" },
        model: { type: "string", description: "可选：显式指定模型 ID" },
        mode: { type: "string", enum: ["readonly", "edit", "full"], description: "工具权限：readonly 仅只读探索；edit 可读写改文件；full 额外允许执行终端命令" },
        contextFiles: { type: "array", items: { type: "string" }, description: "可选：最多 5 个相对 cwd 的文件路径，预加载给执行手作为起始上下文" },
        maxSteps: { type: "number", description: "可选：最大工具循环步数（默认 18，上限受 config.worker.maxStepsLimit 限制）" },
        systemHint: { type: "string", description: "可选：主规划手给执行手的额外约束提示" }
      }
    }
  },
  {
    name: "worker_generate",
    description: "使用外部模型执行单轮快速文本/代码生成、总结、翻译或分析（不读写本地文件系统）。",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string", description: "用户输入内容" },
        system: { type: "string", description: "可选系统提示词" },
        profile: { type: "string", description: "可选路由角色名" },
        provider: { type: "string", description: "可选指定渠道 ID" },
        model: { type: "string", description: "可选指定模型 ID" },
        temperature: { type: "number", description: "可选温度参数" },
        maxTokens: { type: "number", description: "可选最大输出 token 数" }
      }
    }
  },
  {
    name: "worker_test_provider",
    description: "测试指定外部模型渠道的连通性与响应延迟。",
    inputSchema: {
      type: "object",
      required: ["provider"],
      properties: {
        provider: { type: "string", description: "渠道 ID（如 deepseek / ofm）" },
        model: { type: "string", description: "可选：测试用的特定模型 ID" }
      }
    }
  },
  {
    name: "worker_history",
    description: "查看外部执行手的近期任务记录列表，或根据 runId 查看某次执行的完整工具调用轨迹与摘要。",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "返回最近几条记录（默认 15）" },
        runId: { type: "string", description: "可选：传入特定 runId 获取完整详细记录" }
      }
    }
  }
];

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sendResponse(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  send({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}

async function dispatchTool(name, args = {}) {
  switch (name) {
    case "worker_list_models": {
      const cfg = store.getPublicConfig();
      return {
        ...cfg,
        breakerStates: store.getBreakerStates(),
        configPath: store.configPath,
        sidecarLink: "[苍蓝协奏台](sidecar://external-orchestrator/console/)"
      };
    }
    case "worker_execute":
      return await executeWorkerTask(store, args);
    case "worker_generate":
      return await generateOnce(store, args);
    case "worker_test_provider":
      return await testProvider(store, args.provider, args.model);
    case "worker_history":
      if (args.runId) {
        const run = store.getRun(args.runId);
        if (!run) throw new Error(`未找到运行记录：${args.runId}`);
        return run;
      }
      return {
        runs: store.listRuns(args.limit || 15)
      };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }
  const { id, method, params } = req;
  if (id === undefined || id === null) {
    return;
  }
  try {
    switch (method) {
      case "initialize":
        sendResponse(id, {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "external-orchestrator", version: "1.0.0" }
        });
        break;
      case "ping":
        sendResponse(id, {});
        break;
      case "tools/list":
        sendResponse(id, { tools: TOOLS });
        break;
      case "tools/call": {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        try {
          const result = await dispatchTool(toolName, toolArgs);
          sendResponse(id, {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            isError: false
          });
        } catch (err) {
          sendResponse(id, {
            content: [{ type: "text", text: `Error (${toolName}): ${err?.message || String(err)}` }],
            isError: true
          });
        }
        break;
      }
      default:
        sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    sendError(id, -32603, "Internal error", String(err));
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  handleLine(line).catch((err) => {
    process.stderr.write(`[external-orchestrator mcp] unhandled error: ${err?.stack || err}\n`);
  });
});
