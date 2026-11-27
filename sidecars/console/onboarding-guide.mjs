export const ORCHESTRATOR_ONBOARDING_GUIDE = {
  version: "1",
  icon: "✦",
  title: "欢迎使用苍蓝协奏台——外部模型调度与省流",
  subtitle: "1 分钟掌握外部模型接入、角色路由、实时监控与在线试跑（随时点顶栏「? 指南」重看）",
  steps: [
    {
      icon: "🔌",
      navTitle: "接入模型渠道",
      title: "先添加你的外部大模型 API 渠道",
      desc: "接入 DeepSeek、OpenAI、Anthropic、OpenRouter、本地网关或 Ollama 后，主模型就能把重活派给高性价比外接模型，大幅省 Token。",
      spotlight: {
        clickBefore: '.tab[data-tab="providers"]',
        selector: "#preset-buttons",
        buttonText: "定位渠道预设",
        hint: "点上方任意快捷预设即可快速填入接口地址与协议，粘贴 API Key 并测通"
      },
      items: [
        {
          icon: "⚡",
          title: "一键套用主流服务商预设",
          text: "在「模型渠道」页点常用预设自动补齐 Base URL 和协议，再点「拉取模型列表」勾选要启用的模型。"
        },
        {
          icon: "🧪",
          title: "先测通再派单",
          text: "每个渠道卡片都支持一键测试连通性，确保返回绿色可用后再交给路由调度。"
        }
      ],
      tip: "API Key 只保存在本机配置目录中，不会上传到任何第三方服务。"
    },
    {
      icon: "🧭",
      navTitle: "路由与容灾",
      title: "按角色分配模型，配好容灾自动降级",
      desc: "把读代码、写代码、快速生成分别指派给不同性价比的模型，并支持多模型回退链与熔断器。",
      spotlight: {
        clickBefore: '.tab[data-tab="routing"]',
        selector: "#profiles-grid",
        buttonText: "定位调度角色",
        hint: "这里可以为 coder / fast / default 等角色配置主用模型与备用回退顺序"
      },
      items: [
        {
          icon: "🎭",
          title: "多角色独立路由",
          text: "为不同任务档位（如编码、快速文本、默认主力）绑定最合适的模型，主脑派单时自动匹配。"
        },
        {
          icon: "🛡️",
          title: "断路器与超时保护",
          text: "某个渠道限流或超时后自动切换到下一个备选模型并短暂冷却，不拖死整轮任务。"
        }
      ],
      tip: "勾选「每轮强化协同」后，可提醒主模型更积极地把长文件阅读与大段代码改动派给协奏台执行。"
    },
    {
      icon: "📡",
      navTitle: "实时执行监控",
      title: "随时查看派单进度、耗时与修改文件",
      desc: "每次外部模型被调用都会在「执行监控」留下完整轨迹，耗时、状态、变更文件与输出摘要一目了然。",
      spotlight: {
        clickBefore: '.tab[data-tab="runs"]',
        selector: "#runs-list",
        buttonText: "定位监控列表",
        hint: "所有外派任务的实时状态、Token 与改动文件都会在这里汇总展示"
      },
      items: [
        {
          icon: "🔍",
          title: "只看运行中 & 批量归档",
          text: "可筛选仅看正在运行的任务，也能开启批量选择把历史记录收进「归档箱」保持清爽。"
        },
        {
          icon: "📂",
          title: "全链路透明可查",
          text: "点开任意任务卡片即可核对调用模型、执行步骤与最终产出。"
        }
      ],
      tip: "刚配好渠道想立刻试效果？切到下一步的「在线试跑」就能当场验证。"
    },
    {
      icon: "🚀",
      navTitle: "在线试跑与联动",
      title: "在线试跑验证效果，无缝联动苍蓝全家桶",
      desc: "无需开新对话，直接在控制台内发一条测试提示词对比不同模型与角色的响应速度和质量。",
      spotlight: {
        clickBefore: '.tab[data-tab="playground"]',
        selector: "#pg-run-btn",
        buttonText: "定位试跑按钮",
        hint: "在「在线试跑」选择角色或直连模型，输入测试语即可直观查看推理与正文耗时"
      },
      items: [
        {
          icon: "✨",
          title: "对比推理链与输出速度",
          text: "试跑结果会分栏展示推理内容、正文回复与重试路径，调模型组合非常方便。"
        },
        {
          icon: "🪐",
          title: "与苍蓝星轨渠道互通",
          text: "在协奏台配好的渠道可直接被「苍蓝星轨」一键同步挂载到 Antigravity 左下角原生模型菜单。"
        }
      ],
      tip: "随时可点顶栏「? 指南」重看本教程，支持键盘 ← / → 翻页与 Esc 关闭。"
    }
  ]
};
