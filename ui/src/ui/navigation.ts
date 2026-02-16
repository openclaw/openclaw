import type { IconName } from "./icons.js";

export const TAB_GROUPS = [
  { label: "Chat", tabs: ["chat"] },
  {
    label: "Control",
    tabs: ["overview", "channels", "providers", "instances", "sessions", "usage", "health", "cron"],
  },
  { label: "Agent", tabs: ["agents", "hierarchy", "skills", "nodes", "voice"] },
  { label: "Settings", tabs: ["config", "security", "debug", "logs"] },
  { label: "Integrations", tabs: ["twitter", "resources"] },
] as const;

export type Tab =
  | "agents"
  | "overview"
  | "channels"
  | "providers"
  | "instances"
  | "sessions"
  | "usage"
  | "health"
  | "cron"
  | "hierarchy"
  | "skills"
  | "nodes"
  | "voice"
  | "chat"
  | "config"
  | "security"
  | "debug"
  | "logs"
  | "twitter"
  | "resources";

const TAB_PATHS: Record<Tab, string> = {
  agents: "/agents",
  overview: "/overview",
  channels: "/channels",
  providers: "/providers",
  instances: "/instances",
  sessions: "/sessions",
  usage: "/usage",
  health: "/health",
  cron: "/cron",
  hierarchy: "/hierarchy",
  skills: "/skills",
  nodes: "/nodes",
  voice: "/voice",
  chat: "/chat",
  config: "/config",
  security: "/security",
  debug: "/debug",
  logs: "/logs",
  twitter: "/twitter",
  resources: "/resources",
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
    case "providers":
      return "plug";
    case "instances":
      return "radio";
    case "sessions":
      return "fileText";
    case "usage":
      return "barChart";
    case "health":
      return "activity";
    case "cron":
      return "loader";
    case "hierarchy":
      return "gitBranch";
    case "skills":
      return "zap";
    case "nodes":
      return "monitor";
    case "voice":
      return "smartphone";
    case "config":
      return "settings";
    case "security":
      return "shield";
    case "debug":
      return "bug";
    case "logs":
      return "scrollText";
    case "twitter":
      return "twitter";
    case "resources":
      return "puzzle";
    default:
      return "folder";
  }
}

export function titleForTab(tab: Tab) {
  switch (tab) {
    case "agents":
      return "Agents";
    case "overview":
      return "Overview";
    case "channels":
      return "Channels";
    case "providers":
      return "Providers";
    case "instances":
      return "Instances";
    case "sessions":
      return "Sessions";
    case "usage":
      return "Usage";
    case "health":
      return "Health";
    case "cron":
      return "Cron Jobs";
    case "hierarchy":
      return "Hierarchy";
    case "skills":
      return "Skills";
    case "nodes":
      return "Nodes";
    case "voice":
      return "Voice";
    case "chat":
      return "Chat";
    case "config":
      return "Config";
    case "security":
      return "Security";
    case "debug":
      return "Debug";
    case "logs":
      return "Logs";
    case "twitter":
      return "Twitter";
    case "resources":
      return "Resources";
    default:
      return "Control";
  }
}

export function subtitleForTab(tab: Tab) {
  switch (tab) {
    case "agents":
      return "Manage agent workspaces, tools, and identities.";
    case "overview":
      return "Gateway status, entry points, and a fast health read.";
    case "channels":
      return "Manage channels and settings.";
    case "providers":
      return "Model providers, OAuth status, and API key health.";
    case "instances":
      return "Presence beacons from connected clients and nodes.";
    case "sessions":
      return "Inspect active sessions and adjust per-session defaults.";
    case "usage":
      return "";
    case "health":
      return "Gateway health checks and channel diagnostics.";
    case "cron":
      return "Schedule wakeups and recurring agent runs.";
    case "hierarchy":
      return "Agent delegation tree and parent-child relationships.";
    case "skills":
      return "Manage skill availability and API key injection.";
    case "nodes":
      return "Paired devices, capabilities, and command exposure.";
    case "voice":
      return "Text-to-speech, wake words, and talk mode settings.";
    case "chat":
      return "Direct gateway chat session for quick interventions.";
    case "config":
      return "Edit ~/.openclaw/openclaw.json safely.";
    case "security":
      return "Security events, alerts, and audit reports.";
    case "debug":
      return "Gateway snapshots, events, and manual RPC calls.";
    case "logs":
      return "Live tail of the gateway file logs.";
    case "twitter":
      return "Twitter integration dashboard and relationships.";
    case "resources":
      return "Agent resources and external data sources.";
    default:
      return "";
  }
}
