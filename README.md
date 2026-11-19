# ✦ 苍蓝协奏台（External Orchestrator）

面向 **Google Antigravity** 的零依赖多渠道外部模型调度插件：**主脑（Antigravity）负责规划、拆解与最终验收，外部高性价比模型（DeepSeek / OpenAI 兼容 / Anthropic 兼容 / 本地聚合网关 / Ollama）负责具体执行**。

不动 `app.asar`，完全基于 Antigravity 官方标准的 **MCP Server + Sidecar Web UI + Skill + Rule** 架构构建，版本更新无忧。

---

## 核心特性

- **主脑主动调度（开箱即用）**
  - 内置主动协作规则（`rules/AGENTS.md`）：遇到多文件编码、批量改写、大范围只读探索、长文本生成/翻译时，主脑会自动规划并委派外部模型执行，完成后由主脑复核验收。
  - 若新设备尚未配置可用渠道，自动静默降级由主脑直接完成，不报错、不阻塞。
- **自主多步执行引擎（`worker_execute`）**
  - 支持 `readonly`（只读探索）、`edit`（读写改文件）、`full`（额外允许执行受控终端命令）三级沙箱权限，自动拦截工作区越界与高危命令。
  - 兼容 OpenAI（含 `reasoning_content` 多轮透传）与 Anthropic 双协议工具调用。
- **单轮快速生成（`worker_generate`）**
  - 不触碰本地文件系统，适合快速文档起草、翻译、总结与批处理。
- **容灾 Fallback 链 + 断路器**
  - 支持 `default` / `coder` / `fast` / `reasoner` 四个角色路由，各自配置首选模型与有序 Fallback 备用链。
  - 渠道连续失败达到阈值后自动熔断冷却并无缝切换下一顺位渠道，支持面板一键重置。
- **独立可视化控制台（Sidecar + 浏览器全屏）**
  - 渠道卡片管理、一键拉取 `/v1/models` 并支持多关键词实时搜索筛选、连通性与延迟测试、路由配置、任务执行监控（含工具调用轨迹与文件变更列表）、在线试跑。
- **密钥隔离与脱敏**
  - 所有用户配置与密钥保存在 `~/.gemini/external-orchestrator/config.json`（与插件代码完全隔离），MCP 返回与列表接口均自动脱敏，不向对话上下文泄露明文 API Key。

---

## 环境要求

- Google Antigravity 桌面端或 IDE
- Node.js `v20+`（零第三方 npm 依赖，纯 Node.js ESM 内置模块运行）

---

## 安装方法

将本仓库克隆到 Antigravity 的全局插件目录：

```bash
# Windows (PowerShell)
git clone https://github.com/A16Nights/external-orchestrator.git "$env:USERPROFILE\.gemini\config\plugins\external-orchestrator"

# macOS / Linux
git clone https://github.com/A16Nights/external-orchestrator.git ~/.gemini/config/plugins/external-orchestrator
```

然后**重启或重载 Antigravity**，插件的 MCP 工具、右侧「苍蓝协奏台」面板以及主动调度规则会自动挂载生效。

*(也可脱离 Antigravity 单独启动 Web 控制台：`node sidecars/console/server.mjs`，访问 `http://127.0.0.1:18795/`)*

---

## 快速上手

1. 打开右侧辅助面板 **「苍蓝协奏台」**（或在聊天中点击面板链接）。
2. 在 **「模型渠道」** 页添加或编辑渠道（内置 DeepSeek、本地聚合网关、OpenAI 兼容、Kimi、OpenRouter、Anthropic、Ollama 预设），填入 API Key（本地免密端口可留空）并拉取/添加模型，点 **「测试」** 确认连通。
3. 在 **「路由与容灾」** 页为 `default` / `coder` / `fast` / `reasoner` 绑定主模型和备用 Fallback 链并保存。
4. 之后正常向 Antigravity 下达任务即可，主脑会自动判断何时派单并在执行完毕后替你验收~

---

## MCP 工具一览

| 工具名 | 作用 |
| --- | --- |
| `worker_list_models` | 查看已配置的外部渠道（脱敏）、模型、角色路由与断路器状态 |
| `worker_execute` | 委派多步文件读写/编辑/搜索或终端命令任务并返回改动清单与摘要 |
| `worker_generate` | 单轮快速生成/翻译/总结（不触碰文件系统） |
| `worker_test_provider` | 测试指定渠道的连通性与延迟 |
| `worker_history` | 查看历史执行记录与单次任务的完整工具调用轨迹 |

---

## License

[MIT](./LICENSE)
