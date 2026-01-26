export const TAB_GROUPS = [
  { label: "Chat", tabs: ["chat"] },
  {
    label: "Control",
    tabs: ["overview", "agents", "channels", "instances", "sessions", "cron", "overseer"],
  },
  { label: "Agent", tabs: ["skills", "nodes"] },
  { label: "Settings", tabs: ["config", "debug", "logs"] },
] as const;

export type Tab =
  | "landing"
  | "overview"
  | "agents"
  | "channels"
  | "instances"
  | "sessions"
  | "cron"
  | "overseer"
  | "skills"
  | "nodes"
  | "chat"
  | "config"
  | "debug"
  | "logs";

const TAB_PATHS: Record<Tab, string> = {
  landing: "/",
  overview: "/overview",
  agents: "/agents",
  channels: "/channels",
  instances: "/instances",
  sessions: "/sessions",
  cron: "/cron",
  overseer: "/overseer",
  skills: "/skills",
  nodes: "/nodes",
  chat: "/chat",
  config: "/config",
  debug: "/debug",
  logs: "/logs",
};

const PATH_TO_TAB = new Map(
  Object.entries(TAB_PATHS).map(([tab, path]) => [path, tab as Tab]),
);

export type HashRoute = {
  path: string;
  searchParams: URLSearchParams;
};

export function normalizeBasePath(basePath: string): string {
  if (!basePath) return "";
  let base = basePath.trim();
  if (!base.startsWith("/")) base = `/${base}`;
  if (base === "/") return "";
  if (base.endsWith("/")) base = base.slice(0, -1);
  return base;
}

export function normalizePath(path: string): string {
  if (!path) return "/";
  let normalized = path.trim();
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
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

export function rootPathForBasePath(basePath = ""): string {
  const base = normalizeBasePath(basePath);
  return base ? `${base}/` : "/";
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
  if (normalized.endsWith("/index.html")) normalized = "/";
  if (normalized === "/") return "landing";
  return PATH_TO_TAB.get(normalized) ?? null;
}

export function parseHashRoute(hash: string): HashRoute {
  const trimmed = (hash ?? "").trim();
  if (!trimmed || trimmed === "#") {
    return { path: "/", searchParams: new URLSearchParams() };
  }
  const withoutHash = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  const queryIndex = withoutHash.indexOf("?");
  const pathRaw = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const queryRaw = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : "";
  let path = (pathRaw || "/").trim();
  if (!path.startsWith("/")) path = `/${path}`;
  return { path: normalizePath(path), searchParams: new URLSearchParams(queryRaw) };
}

export function buildHashRoute(path: string, searchParams?: URLSearchParams): string {
  const normalizedPath = normalizePath(path);
  const params = searchParams ? new URLSearchParams(searchParams) : new URLSearchParams();
  const query = params.toString();
  return query ? `#${normalizedPath}?${query}` : `#${normalizedPath}`;
}

export function hashForTab(tab: Tab, searchParams?: URLSearchParams): string {
  return buildHashRoute(TAB_PATHS[tab], searchParams);
}

export function hrefForTab(
  tab: Tab,
  basePath = "",
  query?: Record<string, string | undefined>,
): string {
  const params = new URLSearchParams();
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (typeof value === "string" && value.trim()) params.set(key, value);
    }
  }
  const root = rootPathForBasePath(basePath);
  return `${root}${hashForTab(tab, params)}`;
}

export function tabFromHash(hash: string): Tab | null {
  const trimmed = (hash ?? "").trim();
  if (!trimmed || trimmed === "#") return null;
  const { path } = parseHashRoute(hash);
  if (path === "/") return "landing";
  return PATH_TO_TAB.get(path.toLowerCase()) ?? null;
}

export function inferBasePathFromPathname(pathname: string): string {
  let normalized = normalizePath(pathname);
  if (normalized.endsWith("/index.html")) {
    normalized = normalizePath(normalized.slice(0, -"/index.html".length));
  }
  if (normalized === "/") return "";
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return "";
  for (let i = 0; i < segments.length; i++) {
    const candidate = `/${segments.slice(i).join("/")}`.toLowerCase();
    if (PATH_TO_TAB.has(candidate)) {
      const prefix = segments.slice(0, i);
      return prefix.length ? `/${prefix.join("/")}` : "";
    }
  }
  return `/${segments.join("/")}`;
}

export function iconForTab(tab: Tab): string {
  switch (tab) {
    case "landing":
      return "🏠";
    case "chat":
      return "💬";
    case "overview":
      return "📊";
    case "agents":
      return "🪐";
    case "channels":
      return "🔗";
    case "instances":
      return "📡";
    case "sessions":
      return "📄";
    case "cron":
      return "⏰";
    case "overseer":
      return "✨";
    case "skills":
      return "⚡️";
    case "nodes":
      return "🖥️";
    case "config":
      return "⚙️";
    case "debug":
      return "🐞";
    case "logs":
      return "🧾";
    default:
      return "📁";
  }
}

export function titleForTab(tab: Tab) {
  switch (tab) {
    case "landing":
      return "Welcome";
    case "overview":
      return "Overview";
    case "agents":
      return "Agents";
    case "channels":
      return "Channels";
    case "instances":
      return "Instances";
    case "sessions":
      return "Sessions";
    case "cron":
      return "Cron Jobs";
    case "overseer":
      return "Overseer";
    case "skills":
      return "Skills";
    case "nodes":
      return "Nodes";
    case "chat":
      return "Chat";
    case "config":
      return "Config";
    case "debug":
      return "Debug";
    case "logs":
      return "Logs";
    default:
      return "Control";
  }
}

export function subtitleForTab(tab: Tab) {
  switch (tab) {
    case "landing":
      return "Discover what Clawdbrain can do for you.";
    case "overview":
      return "Gateway status, entry points, and a fast health read.";
    case "agents":
      return "Orbit your agents and drill into Cron vs regular sessions.";
    case "channels":
      return "Manage channels and settings.";
    case "instances":
      return "Presence beacons from connected clients and nodes.";
    case "sessions":
      return "Inspect active sessions and adjust per-session defaults.";
    case "cron":
      return "Schedule wakeups and recurring agent runs.";
    case "overseer":
      return "Inspect durable plans, assignments, and recovery state.";
    case "skills":
      return "Manage skill availability and API key injection.";
    case "nodes":
      return "Paired devices, capabilities, and command exposure.";
    case "chat":
      return "Direct gateway chat session for quick interventions.";
    case "config":
      return "Edit ~/.clawdbot/clawdbot.json safely.";
    case "debug":
      return "Gateway snapshots, events, and manual RPC calls.";
    case "logs":
      return "Live tail of the gateway file logs.";
    default:
      return "";
  }
}
