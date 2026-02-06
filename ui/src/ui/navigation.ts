import { msg } from "@lit/localize";
import type { IconName } from "./icons.js";

export const TAB_GROUPS = [
  { label: msg("Chat", { id: "nav.group.chat" }), tabs: ["chat"] },
  {
    label: msg("Control", { id: "nav.group.control" }),
    tabs: ["overview", "channels", "instances", "sessions", "usage", "cron"],
  },
  { label: msg("Agent", { id: "nav.group.agent" }), tabs: ["agents", "skills", "nodes"] },
  { label: msg("Settings", { id: "nav.group.settings" }), tabs: ["config", "debug", "logs"] },
] as const;

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
      return msg("Agents", { id: "tab.agents" });
    case "overview":
      return msg("Overview", { id: "tab.overview" });
    case "channels":
      return msg("Channels", { id: "tab.channels" });
    case "instances":
      return msg("Instances", { id: "tab.instances" });
    case "sessions":
      return msg("Sessions", { id: "tab.sessions" });
    case "usage":
      return msg("Usage", { id: "tab.usage" });
    case "cron":
      return msg("Cron Jobs", { id: "tab.cron" });
    case "skills":
      return msg("Skills", { id: "tab.skills" });
    case "nodes":
      return msg("Nodes", { id: "tab.nodes" });
    case "chat":
      return msg("Chat", { id: "tab.chat" });
    case "config":
      return msg("Config", { id: "tab.config" });
    case "debug":
      return msg("Debug", { id: "tab.debug" });
    case "logs":
      return msg("Logs", { id: "tab.logs" });
    default:
      return msg("Control", { id: "nav.group.control" });
  }
}

export function subtitleForTab(tab: Tab) {
  switch (tab) {
    case "agents":
      return msg("Manage agent workspaces, tools, and identities.", {
        id: "subtitle.agents",
      });
    case "overview":
      return msg("Gateway status, entry points, and a fast health read.", {
        id: "subtitle.overview",
      });
    case "channels":
      return msg("Manage channels and settings.", { id: "subtitle.channels" });
    case "instances":
      return msg("Presence beacons from connected clients and nodes.", {
        id: "subtitle.instances",
      });
    case "sessions":
      return msg("Inspect active sessions and adjust per-session defaults.", {
        id: "subtitle.sessions",
      });
    case "usage":
      return msg("Token, cost, and activity analytics across sessions.", {
        id: "subtitle.usage",
      });
    case "cron":
      return msg("Schedule wakeups and recurring agent runs.", { id: "subtitle.cron" });
    case "skills":
      return msg("Manage skill availability and API key injection.", {
        id: "subtitle.skills",
      });
    case "nodes":
      return msg("Paired devices, capabilities, and command exposure.", {
        id: "subtitle.nodes",
      });
    case "chat":
      return msg("Direct gateway chat session for quick interventions.", {
        id: "subtitle.chat",
      });
    case "config":
      return msg("Edit ~/.openclaw/openclaw.json safely.", { id: "subtitle.config" });
    case "debug":
      return msg("Gateway snapshots, events, and manual RPC calls.", {
        id: "subtitle.debug",
      });
    case "logs":
      return msg("Live tail of the gateway file logs.", { id: "subtitle.logs" });
    default:
      return "";
  }
}
