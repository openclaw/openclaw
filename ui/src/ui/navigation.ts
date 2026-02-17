import type { IconName } from "./icons.js";
import { t } from "../i18n/index.ts";

export const TAB_GROUPS = [
  { label: "chat", tabs: ["chat"] },
  {
    label: "control",
    tabs: ["overview", "channels", "instances", "sessions", "usage", "cron"],
  },
  { label: "agent", tabs: ["agents", "skills", "nodes"] },
  { label: "settings", tabs: ["config", "debug", "logs"] },
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

export type AppMode = "basic" | "advanced" | "configure";
export type TabVisibility = Partial<Record<Tab, boolean>>;

// Tabs visible in Basic mode (simplified view for regular developers)
const BASIC_TABS: Tab[] = ["chat", "overview", "sessions", "instances", "config"];

// Tabs visible in Advanced mode (full functionality for power users)
const ADVANCED_TABS: Tab[] = [
  "chat",
  "overview",
  "channels",
  "instances",
  "sessions",
  "usage",
  "cron",
  "agents",
  "skills",
  "nodes",
  "config",
  "debug",
  "logs",
];

// All tabs (for configure mode)
const ALL_TABS: Tab[] = [
  "chat",
  "overview",
  "channels",
  "instances",
  "sessions",
  "usage",
  "cron",
  "agents",
  "skills",
  "nodes",
  "config",
  "debug",
  "logs",
];

/**
 * Returns the tabs visible for the given mode.
 * @param mode - The current app mode ("basic", "advanced", or "configure")
 * @returns Array of visible tabs based on mode
 */
export function getVisibleTabs(
  mode: AppMode,
): ReadonlyArray<{ readonly label: string; readonly tabs: readonly Tab[] }> {
  const visibleSet = mode === "basic" ? BASIC_TABS : mode === "advanced" ? ADVANCED_TABS : ALL_TABS;
  return TAB_GROUPS.map((group) => ({
    ...group,
    tabs: group.tabs.filter((tab) => visibleSet.includes(tab)),
  })).filter((group) => group.tabs.length > 0);
}

/**
 * Returns the tabs visible for the given mode with user overrides.
 * @param mode - The current app mode
 * @param overrides - User-specific tab visibility overrides
 * @returns Array of visible tabs based on mode and overrides
 */
export function getVisibleTabsWithOverrides(
  mode: AppMode,
  overrides: TabVisibility,
): ReadonlyArray<{ readonly label: string; readonly tabs: readonly Tab[] }> {
  if (mode === "configure") {
    // In configure mode, show all tabs so user can toggle them
    return TAB_GROUPS.map((group) => ({
      ...group,
      tabs: group.tabs.filter((tab) => ALL_TABS.includes(tab)),
    })).filter((group) => group.tabs.length > 0);
  }

  // For basic/advanced modes, start with default tabs for that mode
  const baseSet = mode === "basic" ? BASIC_TABS : ADVANCED_TABS;

  // Apply user overrides
  const filteredTabs = new Set(
    baseSet.filter((tab) => {
      // If override exists, use it; otherwise default to visible
      return overrides[tab] !== false;
    }),
  );

  return TAB_GROUPS.map((group) => ({
    ...group,
    tabs: group.tabs.filter((tab) => filteredTabs.has(tab)),
  })).filter((group) => group.tabs.length > 0);
}

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
  return t(`tabs.${tab}`);
}

export function subtitleForTab(tab: Tab) {
  return t(`subtitles.${tab}`);
}
