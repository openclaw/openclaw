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
