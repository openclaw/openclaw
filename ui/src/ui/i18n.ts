export type UiLanguage = "system" | "en" | "zh-CN";

type ResolvedLanguage = "en" | "zh-CN";

let currentLanguage: ResolvedLanguage = "en";

const DICT: Record<ResolvedLanguage, Record<string, string>> = {
  en: {},
  "zh-CN": {
    "nav.chat": "聊天",
    "nav.control": "控制",
    "nav.agent": "智能体",
    "nav.settings": "设置",
    "tab.agents": "智能体",
    "tab.overview": "总览",
    "tab.channels": "渠道",
    "tab.instances": "实例",
    "tab.sessions": "会话",
    "tab.usage": "用量",
    "tab.cron": "定时任务",
    "tab.skills": "技能",
    "tab.nodes": "节点",
    "tab.chat": "聊天",
    "tab.config": "配置",
    "tab.debug": "调试",
    "tab.logs": "日志",
    "sub.agents": "管理智能体工作区、工具与身份信息。",
    "sub.overview": "网关状态、入口信息与快速健康检查。",
    "sub.channels": "管理渠道与配置。",
    "sub.instances": "查看已连接客户端与节点的在线信标。",
    "sub.sessions": "查看活跃会话并调整每会话默认项。",
    "sub.cron": "安排唤醒与周期性智能体运行。",
    "sub.skills": "管理技能可用性与 API 密钥注入。",
    "sub.nodes": "已配对设备、能力与命令暴露。",
    "sub.chat": "直接通过网关会话聊天，快速介入。",
    "sub.config": "安全编辑 ~/.openclaw/openclaw.json。",
    "sub.debug": "网关快照、事件与手动 RPC 调用。",
    "sub.logs": "实时查看网关日志。",
    "label.resources": "资源",
    "label.docs": "文档",
    "label.health": "健康",
    "label.offline": "离线",
    "title.dashboard": "网关控制台",
    "title.language": "语言",
    "lang.auto": "自动",
    "lang.english": "英文",
    "lang.simplifiedChinese": "简体中文",
    "title.refreshChatData": "刷新聊天数据",
    "title.disabledOnboarding": "引导流程中不可用",
    "title.toggleThinking": "切换显示智能体思考/执行输出",
    "title.toggleFocus": "切换专注模式（隐藏侧栏与页头）",
    "a11y.docsNewTab": "文档（新标签页打开）",
    "usage.title.page": "用量",
    "usage.title.filters": "筛选",
    "usage.title.activityByTime": "按时间活跃度",
    "usage.title.dailyUsage": "每日用量",
    "usage.title.dailyTokenUsage": "每日 Token 用量",
    "usage.title.dailyCostUsage": "每日成本用量",
    "usage.title.usageOverview": "用量总览",
    "usage.title.sessions": "会话",
    "overview.title.gatewayAccess": "网关访问",
    "overview.title.snapshot": "快照",
    "overview.title.notes": "说明",
    "instances.title.connectedInstances": "已连接实例",
    "sessions.title.page": "会话",
    "skills.title.page": "技能",
    "nodes.title.nodes": "节点",
    "nodes.title.devices": "设备",
    "nodes.title.execNodeBinding": "执行节点绑定",
    "nodes.title.execApprovals": "执行审批",
    "nodes.title.allowlist": "允许列表",
    "agents.title.agents": "智能体",
    "agents.title.selectAgent": "选择一个智能体",
    "agents.title.overview": "概览",
    "agents.title.agentContext": "智能体上下文",
    "agents.title.channels": "渠道",
    "agents.title.scheduler": "调度器",
    "agents.title.agentCronJobs": "智能体定时任务",
    "agents.title.coreFiles": "核心文件",
    "agents.title.toolAccess": "工具访问",
    "agents.title.skills": "技能",
    "cron.title.scheduler": "调度器",
    "cron.title.newJob": "新建任务",
    "cron.title.jobs": "任务",
    "cron.title.runHistory": "运行历史",
    "debug.title.snapshots": "快照",
    "debug.title.manualRpc": "手动 RPC",
    "debug.title.models": "模型",
    "debug.title.eventLog": "事件日志",
    "logs.title.page": "日志",
    "channels.title.channelHealth": "渠道健康状态",
  },
};

function resolveBrowserLanguage(): ResolvedLanguage {
  const raw = (navigator.language || "en").toLowerCase();
  if (raw.startsWith("zh")) {
    return "zh-CN";
  }
  return "en";
}

export function resolveUiLanguage(language: UiLanguage): ResolvedLanguage {
  if (language === "system") {
    return resolveBrowserLanguage();
  }
  return language;
}

export function setUiLanguage(language: UiLanguage) {
  currentLanguage = resolveUiLanguage(language);
}

export function tr(key: string, fallback: string): string {
  return DICT[currentLanguage][key] ?? fallback;
}
