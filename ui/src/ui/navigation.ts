import { t } from "../i18n/index.ts";
import type { IconName } from "./icons.js";
import { normalizeLowercaseStringOrEmpty } from "./string-coerce.ts";

export const TAB_GROUPS = [
  { label: "chat", tabs: ["chat", "projects"] },
  {
    label: "control",
    tabs: ["overview", "channels", "instances", "sessions", "usage", "cron"],
  },
  {
    label: "dashboards",
    tabs: ["appStudio", "musicStudio", "snesStudio", "bookWriter", "kalshi", "patternLab"],
  },
  { label: "agent", tabs: ["agents", "agentWorkflows", "skills", "nodes", "dreams"] },
  {
    label: "settings",
    tabs: [
      "config",
      "communications",
      "appearance",
      "automation",
      "infrastructure",
      "aiAgents",
      "debug",
      "logs",
    ],
  },
] as const;

export type Tab =
  | "agents"
  | "agentWorkflows"
  | "overview"
  | "appStudio"
  | "musicStudio"
  | "snesStudio"
  | "kalshi"
  | "bookWriter"
  | "patternLab"
  | "channels"
  | "instances"
  | "sessions"
  | "usage"
  | "cron"
  | "skills"
  | "nodes"
  | "chat"
  | "projects"
  | "config"
  | "communications"
  | "appearance"
  | "automation"
  | "infrastructure"
  | "aiAgents"
  | "debug"
  | "logs"
  | "dreams";

const TAB_PATHS: Record<Tab, string> = {
  agents: "/agents",
  agentWorkflows: "/agent-workflows",
  overview: "/overview",
  appStudio: "/app-studio",
  musicStudio: "/music-studio",
  snesStudio: "/snes-studio",
  kalshi: "/kalshi",
  bookWriter: "/book-writer",
  patternLab: "/pattern-lab",
  channels: "/channels",
  instances: "/instances",
  sessions: "/sessions",
  usage: "/usage",
  cron: "/cron",
  skills: "/skills",
  nodes: "/nodes",
  chat: "/chat",
  projects: "/projects",
  config: "/config",
  communications: "/communications",
  appearance: "/appearance",
  automation: "/automation",
  infrastructure: "/infrastructure",
  aiAgents: "/ai-agents",
  debug: "/debug",
  logs: "/logs",
  dreams: "/dreaming",
};

const PATH_ALIASES: Record<string, Tab> = {
  "/dreams": "dreams",
};

const PATH_TO_TAB = new Map<string, Tab>([
  ...Object.entries(TAB_PATHS).map(([tab, path]) => [path, tab as Tab] as const),
  ...Object.entries(PATH_ALIASES),
]);

const TAB_TITLE_FALLBACKS: Partial<Record<Tab, string>> = {
  agentWorkflows: "Agent Workflow Maps",
  appStudio: "App Studio",
  musicStudio: "Music Studio",
  snesStudio: "SNES Studio",
  kalshi: "Kalshi",
  bookWriter: "Book Studio",
  patternLab: "Pattern Lab",
  projects: "Projects",
};

const TAB_SUBTITLE_FALLBACKS: Partial<Record<Tab, string>> = {
  agentWorkflows: "Live Agent Workspace workflow maps, ownership, and health.",
  appStudio: "Prompt, build, validate, and prepare native iPhone apps for the App Store.",
  musicStudio: "Prompt, arrange, play, and finish original music.",
  snesStudio: "Prompt, play, and edit a SNES game without SNES jargon.",
  kalshi: "Prediction market paper trading status.",
  bookWriter: "Plan, write, package, and publish-prep original books.",
  patternLab: "YouTube review, approval, and learning dashboard.",
  projects: "Project workspaces, chats, and resources.",
};

export function normalizeBasePath(basePath: string): string {
  if (!basePath) {
    return "";
  }
  let base = basePath.trim();
  if (!base.startsWith("/")) {
    base = `/${base}`;
  }
  if (base === "/") {
    return "";
  }
  if (base.endsWith("/")) {
    base = base.slice(0, -1);
  }
  return base;
}

export function normalizePath(path: string): string {
  if (!path) {
    return "/";
  }
  let normalized = path.trim();
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function pathForTab(tab: Tab, basePath = ""): string {
  const base = normalizeBasePath(basePath);
  const path = TAB_PATHS[tab];
  return base ? `${base}${path}` : path;
}

export function tabFromPath(pathname: string, basePath = ""): Tab | null {
  const base = normalizeBasePath(basePath);
  let path = pathname || "/";
  if (base) {
    if (path === base) {
      path = "/";
    } else if (path.startsWith(`${base}/`)) {
      path = path.slice(base.length);
    }
  }
  let normalized = normalizeLowercaseStringOrEmpty(normalizePath(path));
  if (normalized.endsWith("/index.html")) {
    normalized = "/";
  }
  if (normalized === "/") {
    return "chat";
  }
  return PATH_TO_TAB.get(normalized) ?? null;
}

export function inferBasePathFromPathname(pathname: string): string {
  let normalized = normalizePath(pathname);
  if (normalized.endsWith("/index.html")) {
    normalized = normalizePath(normalized.slice(0, -"/index.html".length));
  }
  if (normalized === "/") {
    return "";
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) {
    return "";
  }
  for (let i = 0; i < segments.length; i++) {
    const candidate = normalizeLowercaseStringOrEmpty(`/${segments.slice(i).join("/")}`);
    if (PATH_TO_TAB.has(candidate)) {
      const prefix = segments.slice(0, i);
      return prefix.length ? `/${prefix.join("/")}` : "";
    }
  }
  return `/${segments.join("/")}`;
}

export function iconForTab(tab: Tab): IconName {
  switch (tab) {
    case "agents":
      return "folder";
    case "agentWorkflows":
      return "brain";
    case "chat":
      return "messageSquare";
    case "projects":
      return "folder";
    case "overview":
      return "barChart";
    case "appStudio":
      return "spark";
    case "musicStudio":
      return "radio";
    case "snesStudio":
      return "monitor";
    case "kalshi":
      return "lineChart";
    case "bookWriter":
      return "book";
    case "patternLab":
      return "monitor";
    case "channels":
      return "link";
    case "instances":
      return "radio";
    case "sessions":
      return "fileText";
    case "usage":
      return "barChart";
    case "cron":
      return "loader";
    case "skills":
      return "zap";
    case "nodes":
      return "monitor";
    case "config":
      return "settings";
    case "communications":
      return "send";
    case "appearance":
      return "spark";
    case "automation":
      return "terminal";
    case "infrastructure":
      return "globe";
    case "aiAgents":
      return "brain";
    case "debug":
      return "bug";
    case "logs":
      return "scrollText";
    case "dreams":
      return "moon";
    default:
      return "folder";
  }
}

export function titleForTab(tab: Tab) {
  const key = `tabs.${tab}`;
  const translated = t(key);
  return translated === key ? (TAB_TITLE_FALLBACKS[tab] ?? translated) : translated;
}

export function subtitleForTab(tab: Tab) {
  const key = `subtitles.${tab}`;
  const translated = t(key);
  return translated === key ? (TAB_SUBTITLE_FALLBACKS[tab] ?? translated) : translated;
}
