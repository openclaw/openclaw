import type { IconName } from "./icons.js";
import { t } from "./i18n/index.js";

export const TAB_GROUPS = [
  { label: "Chat", tabs: ["chat"] },
  {
    label: "Control",
    tabs: ["overview", "channels", "instances", "sessions", "usage", "cron"],
  },
  { label: "Agent", tabs: ["agents", "skills", "nodes"] },
  { label: "Settings", tabs: ["config", "debug", "logs"] },
] as const;

/** Translate tab group labels dynamically */
export function groupLabel(group: (typeof TAB_GROUPS)[number]): string {
  return t(group.label);
}

export type Tab =
  | "agents"
  | "overview"
  | "channels"
  | "instances"
  | "sessions"
  | "usage"
  | "cron"
  | "skills"
  | "nodes"
  | "chat"
  | "config"
  | "debug"
  | "logs";

const TAB_PATHS: Record<Tab, string> = {
  agents: "/agents",
  overview: "/overview",
  channels: "/channels",
  instances: "/instances",
  sessions: "/sessions",
  usage: "/usage",
  cron: "/cron",
  skills: "/skills",
  nodes: "/nodes",
  chat: "/chat",
  config: "/config",
  debug: "/debug",
  logs: "/logs",
};

const PATH_TO_TAB = new Map(Object.entries(TAB_PATHS).map(([tab, path]) => [path, tab as Tab]));

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
  let normalized = normalizePath(path).toLowerCase();
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
    const candidate = `/${segments.slice(i).join("/")}`.toLowerCase();
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
    case "chat":
      return "messageSquare";
    case "overview":
      return "barChart";
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
    case "debug":
      return "bug";
    case "logs":
      return "scrollText";
    default:
      return "folder";
  }
}

export function titleForTab(tab: Tab) {
  switch (tab) {
    case "agents":
      return t("Agents");
    case "overview":
      return t("Overview");
    case "channels":
      return t("Channels");
    case "instances":
      return t("Instances");
    case "sessions":
      return t("Sessions");
    case "usage":
      return t("Usage");
    case "cron":
      return t("Cron Jobs");
    case "skills":
      return t("Skills");
    case "nodes":
      return t("Nodes");
    case "chat":
      return t("Chat");
    case "config":
      return t("Config");
    case "debug":
      return t("Debug");
    case "logs":
      return t("Logs");
    default:
      return t("Control");
  }
}

export function subtitleForTab(tab: Tab) {
  switch (tab) {
    case "agents":
      return t("Manage agent workspaces, tools, and identities.");
    case "overview":
      return t("Gateway status, entry points, and a fast health read.");
    case "channels":
      return t("Manage channels and settings.");
    case "instances":
      return t("Presence beacons from connected clients and nodes.");
    case "sessions":
      return t("Inspect active sessions and adjust per-session defaults.");
    case "usage":
      return "";
    case "cron":
      return t("Schedule wakeups and recurring agent runs.");
    case "skills":
      return t("Manage skill availability and API key injection.");
    case "nodes":
      return t("Paired devices, capabilities, and command exposure.");
    case "chat":
      return t("Direct gateway chat session for quick interventions.");
    case "config":
      return t("Edit ~/.openclaw/openclaw.json safely.");
    case "debug":
      return t("Gateway snapshots, events, and manual RPC calls.");
    case "logs":
      return t("Live tail of the gateway file logs.");
    default:
      return "";
  }
}
