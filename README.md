# ✦ 苍蓝协奏台 · External Orchestrator (`antigravity-external-orchestrator`)

面向 **Google Antigravity** 的零依赖多渠道外部模型协同调度插件：**由主脑（Antigravity）负责轻量思考规划、派单指令与最终抽查验收，将消耗大量 Token 的多文件阅读、代码编写、命令排查与长文本生成自动委派给高性价比外部模型（DeepSeek / OpenAI 兼容 / Anthropic 兼容 / OpenRouter / Kimi / 本地聚合网关 / Ollama）执行**。

不动 `app.asar`，完全基于 Antigravity 官方标准的 **MCP Server + Sidecar Web UI + MCP App 内联进度卡片 + Skill + Rule + Lifecycle Hook** 架构构建，客户端版本升级无忧。

---

## ✨ 功能全景

### 1. 主脑主动派单与外接模型智能强化
- **开箱即用的省 Token 协作规范（`rules/AGENTS.md`）**：
  - 读多文件 / 调研代码 / 搜目录 → 委派 `worker_execute(mode: "readonly")` 返回精简结论；
  - 写 >15 行代码 / 多处修改 / 重构 / 写脚本 / 补测试 → 委派 `worker_execute(mode: "edit" | "full")` 执行；
  - 跑命令 / 测构建 / 查长日志 → 委派 `worker_execute(mode: "full")` 消化长输出并返回摘要；
  - 长文本起草 / 总结 / 翻译 / 格式批量转换 → 委派 `worker_generate`。
- **外接主模型智能前置提醒（`hooks/pre-invocation.mjs`）**：
  - 自动识别当前主模型是否为外接自定义模型：仅在外接模型下注入每轮派单提醒（内置每回合去重），使用 Antigravity 原生模型时自动跳过，零多余开销；支持在面板顶栏一键开关。
- **未配置静默降级**：若当前设备尚未启用任何可用外部渠道，主脑自动静默降级自行完成任务，不报错、不打断工作流。

### 2. 自主多步执行引擎（`worker_execute`）与单轮生成（`worker_generate`）
- **三级沙箱权限控制**：
  - `readonly`：仅允许只读搜索与读取文件（`read_file`、`list_dir`、`search_files`）；
  - `edit`：允许创建、编辑、局部替换工作区内文件（自动拦截越界路径，除非显式开启允许工作区外访问）；
  - `full`：额外允许在工作区内执行受控终端命令（带超时控制与高危命令拦截）。
- **双协议深度兼容**：原生支持 OpenAI 兼容协议（含 DeepSeek R1 / Reasoner 的 `reasoning_content` 多轮工具调用透传）与 Anthropic `/v1/messages` 协议。

### 3. 自定义调度角色（Profile）管理 + Fallback 容灾链 + 断路器
- **内置 4 大基础角色 + 无限自定义调度角色**：
  - 内置 `default`（默认执行手）、`coder`（代码与文件修改）、`fast`（轻量快速处理）、`reasoner`（深度分析辅助）四大角色；
  - **支持自由新建、编辑、删除自定义调度角色**（如 `reviewer` 代码审查员、`translator` 文档翻译官、`architect` 架构师）：
    - 每个角色可独立配置：**角色 ID**、**中文显示名称**、**角色说明**、**默认权限模式（`readonly` / `edit` / `full`）**、**首选模型（Primary）**、**有序备用容灾链（Fallbacks）** 以及 **角色专属 System Prompt**（执行任务或单轮生成时自动拼入系统指令）；
    - 内置角色同样支持自定义改名、绑定默认权限模式与专属 System Prompt，并受防误删保护。
- **自动断路器（Circuit Breaker）与无缝容灾**：
  - 当首选渠道连续失败达到阈值（默认 3 次）或遇 429/5xx 错误时，断路器自动熔断该渠道进入冷却期，并按当前角色的 Fallback 顺序无缝切换下一顺位模型；支持面板一键重置熔断状态。

### 4. 全链路实时执行监控、调度角色徽章与独立归档箱
- **实时工作状态监控 + MCP App 对话内联进度卡片**：
  - 任务执行期间，聊天窗口内联卡片与控制台「执行监控」页同步实时展示当前步数进度条、正在调用的工具动作、已耗时与文件增改计数。
- **全链路展示「调度角色名称」**：
  - 在 **实时运行卡片**、**执行监控历史列表**、**归档箱列表**、**展开详情** 与 **内联进度卡片** 中，统一展示醒目的 **`角色 · 中文名 (角色ID)`** 徽章（如 `角色 · 代码与文件修改 (coder)`），并在创建记录时持久化当时的角色名称。
- **完整轨迹回放与任务归档箱**：
  - 点击任意任务卡片即可展开查看完整任务描述、新建/修改文件清单、每一步工具调用参数与状态、推理过程及 Markdown 渲染的最终汇报摘要；
  - 支持单条归档、批量多选归档/删除、全部归档，以及在独立 **「归档箱」** 标签页中随时恢复或永久清理。

### 5. 多渠道可视化管理与在线试跑（Playground）
- **7 大主流预设快速添加**：DeepSeek、本地聚合网关、OpenAI 兼容、Kimi / Moonshot、OpenRouter、Anthropic 兼容、Ollama 本地；支持一键从 `/v1/models` 拉取模型、多关键词实时过滤、连通性与延迟测试。
- **在线试跑台（Playground）**：支持按「路由角色（带自动 Fallback）」或「指定具体渠道:模型」发送测试 Prompt，实时查看推理过程（Reasoning）、输出正文、Token 消耗与容灾尝试明细。

### 6. 苍蓝统一视觉与交互体系
- **Neko Glass 毛玻璃界面 & 苍蓝主题色调中心**：深色/浅色切换、自定义毛玻璃下拉框与确认弹窗、6 套官方主题预设 + 自定义双色 + 4 个自定义栏位跨插件同步、左侧栏快捷入口开关、独立浏览器全屏 `Web UI` 与 GitHub Release 在线更新检查。

---

## 🚀 安装方法

> 前置要求：**Node.js >= 20.0.0**（零第三方 npm 依赖，纯 Node.js 原生 ESM 实现）。

将本仓库克隆到 Antigravity 的全局插件目录（目录名固定为 `external-orchestrator`）：

```powershell
# Windows (PowerShell)
git clone https://github.com/A16Nights/antigravity-external-orchestrator.git "$env:USERPROFILE\.gemini\config\plugins\external-orchestrator"

# macOS / Linux
git clone https://github.com/A16Nights/antigravity-external-orchestrator.git ~/.gemini/config/plugins/external-orchestrator
```

重启或重载 Antigravity（`Ctrl+R`），插件的 MCP 工具、右侧「苍蓝协奏台」面板以及主动调度规则即自动挂载生效。

*(也可脱离 Antigravity 单独启动 Web 控制台：`node sidecars/console/server.mjs`，在浏览器访问终端输出的本地地址)*

---

## 🧰 MCP 工具一览（5 个）

| 工具名 | 作用 |
| --- | --- |
| `worker_list_models` | 查看已配置的外部渠道（密钥自动脱敏）、可用模型、所有内置/自定义调度角色路由与断路器实时状态 |
| `worker_execute` | 委派多步文件读写/编辑/搜索或终端命令任务给指定调度角色（`profile`），支持实时内联进度卡片并返回改动清单与摘要 |
| `worker_generate` | 使用指定调度角色或模型执行单轮快速文本/代码生成、总结、翻译或分析（不触碰本地文件系统） |
| `worker_test_provider` | 测试指定外部模型渠道的连通性、协议兼容性与响应延迟 |
| `worker_history` | 查看近期外部执行手任务记录列表（含调度角色名称、耗时、Token），或按 `runId` 查看完整工具调用轨迹 |

---

## 📂 数据与配置存储

- **渠道、密钥与调度角色路由配置**：`~/.gemini/external-orchestrator/config.json`
- **断路器状态与实时运行进度**：`~/.gemini/external-orchestrator/breaker-state.json`、`active-runs.json`
- **历史运行记录与完整轨迹**：`~/.gemini/external-orchestrator/runs/`
- **苍蓝套件共享主题 / 左侧栏配置**：`~/.gemini/azure-theme.json`、`~/.gemini/azure-sidebar-nav.json`

---

## 📄 License

[MIT](./LICENSE)
