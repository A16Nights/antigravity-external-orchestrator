---
name: external-orchestrator
description: >-
  Delegate multi-step coding, file editing, command execution, or fast text generation
  tasks to user-configured external LLM APIs (DeepSeek, OpenAI, Anthropic, OpenRouter,
  local gateways, Ollama) with automatic fallback chains and circuit breakers to save
  primary model tokens. Use proactively whenever coding, researching files, or generating
  text, or when configuring/testing/inspecting external worker models and runs.
---

# 苍蓝协奏台 · External Orchestrator

本插件让 Antigravity 作为**主规划手（Orchestrator）**只做轻量规划、任务拆解与最终抽查验收，并主动通过 MCP 工具把耗费大量 Token 的具体执行工作（代码编写、多文件读取调研、命令排查、长文本生成）派发给外部高性价比模型（如 DeepSeek、本地聚合网关或其他 OpenAI/Anthropic 兼容 API），最大限度节省主脑 Token 额度与上下文窗口。

## 控制台面板与配置路径
- 右侧可视化面板：`[苍蓝协奏台](sidecar://external-orchestrator/console/)`（Antigravity 2.35.1+ 回复含该链接会自动弹开侧栏，仅在用户需要查看或配置渠道时输出）
- 持久化配置文件：`~/.gemini/external-orchestrator/config.json`（不同设备自动解析各自用户目录）
- 所有 MCP 工具返回均已自动脱敏，不会暴露明文 API Key；如需修改密钥请引导至控制台 UI 或配置文件。

## 可用 MCP 工具（`external-orchestrator`）
1. `worker_list_models`：查看已配置的渠道、模型列表、角色路由（`default` / `coder` / `fast` / `reasoner`）及断路器状态。
2. `worker_execute(task, cwd, profile?, provider?, model?, mode?, contextFiles?, maxSteps?, systemHint?)`：
   - 派发需要多步读/写/改文件或跑命令的执行任务。
   - `mode`：`readonly`（只读探索）、`edit`（默认，可创建/编辑文件）、`full`（额外允许运行终端命令）。
   - 执行完成后会返回 `createdFiles`、`modifiedFiles`、`steps`、`usage`、`summary` 和执行轨迹。
3. `worker_generate(prompt, system?, profile?, provider?, model?, temperature?, maxTokens?)`：单轮生成、翻译、总结或文本处理（不触碰文件系统）。
4. `worker_test_provider(provider, model?)`：测试指定渠道的连通性与延迟。
5. `worker_history(limit?, runId?)`：查看历史运行概要或单次任务的完整轨迹。

## 主规划手主动调度流程（重要）
1. **主动识别可外包任务**：遇到多文件改动、批量编辑、样板代码编写、大范围只读调研、长文本生成/翻译时，主动规划并派单，不必等用户点名；简单问答、小改动和高危不可逆操作由主脑直接完成。
2. **先规划再派单**：明确目标、涉及文件和完成标准，再调用 `worker_execute` / `worker_generate`；若当前设备尚无就绪渠道则自动降级由主脑自行完成。
3. **明确范围与最小权限**：优先使用 `readonly` 或 `edit`，仅在确实需要跑测试/构建命令时传 `mode: "full"`。
4. **主脑必须复核验收**：拿到 `worker_execute` 返回后，按需抽查关键改动文件或复验结果，再向用户汇报最终结论。
