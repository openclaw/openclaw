const KEY = "openclaw.control.settings.v1";

import { isSupportedLocale } from "../i18n/index.ts";
import type { ThemeMode } from "./theme.ts";

export type UiSettings = {
  gatewayUrl: string;
  token: string;
  sessionKey: string;
  lastActiveSessionKey: string;
  theme: ThemeMode;
  chatFocusMode: boolean;
  chatShowThinking: boolean;
  splitRatio: number; // Sidebar split ratio (0.4 to 0.7, default 0.6)
  navCollapsed: boolean; // Collapsible sidebar state
  navGroupsCollapsed: Record<string, boolean>; // Which nav groups are collapsed
  locale?: string;
};

export function loadSettings(): UiSettings {
  const defaultUrl = (() => {
    if (typeof globalThis.location === "undefined") {
      return "ws://localhost:18789";
    }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}`;
  })();

  const defaults: UiSettings = {
    gatewayUrl: defaultUrl,
    token: "",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "system",
    chatFocusMode: false,
    chatShowThinking: true,
    splitRatio: 0.6,
    navCollapsed: false,
    navGroupsCollapsed: {},
  };

  try {
    if (typeof globalThis.localStorage === "undefined") {
      return defaults;
    }
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      return defaults;
    }
    const parsed = JSON.parse(raw) as Partial<UiSettings>;
    return {
      gatewayUrl:
        typeof parsed.gatewayUrl === "string" && parsed.gatewayUrl.trim()
          ? parsed.gatewayUrl.trim()
          : defaults.gatewayUrl,
      token: typeof parsed.token === "string" ? parsed.token : defaults.token,
      sessionKey:
        typeof parsed.sessionKey === "string" && parsed.sessionKey.trim()
          ? parsed.sessionKey.trim()
          : defaults.sessionKey,
      lastActiveSessionKey:
        typeof parsed.lastActiveSessionKey === "string" && parsed.lastActiveSessionKey.trim()
          ? parsed.lastActiveSessionKey.trim()
          : (typeof parsed.sessionKey === "string" && parsed.sessionKey.trim()) ||
            defaults.lastActiveSessionKey,
      theme:
        parsed.theme === "light" || parsed.theme === "dark" || parsed.theme === "system"
          ? parsed.theme
          : defaults.theme,
      chatFocusMode:
        typeof parsed.chatFocusMode === "boolean" ? parsed.chatFocusMode : defaults.chatFocusMode,
      chatShowThinking:
        typeof parsed.chatShowThinking === "boolean"
          ? parsed.chatShowThinking
          : defaults.chatShowThinking,
      splitRatio:
        typeof parsed.splitRatio === "number" &&
        parsed.splitRatio >= 0.4 &&
        parsed.splitRatio <= 0.7
          ? parsed.splitRatio
          : defaults.splitRatio,
      navCollapsed:
        typeof parsed.navCollapsed === "boolean" ? parsed.navCollapsed : defaults.navCollapsed,
      navGroupsCollapsed:
        typeof parsed.navGroupsCollapsed === "object" && parsed.navGroupsCollapsed !== null
          ? parsed.navGroupsCollapsed
          : defaults.navGroupsCollapsed,
      locale: isSupportedLocale(parsed.locale) ? parsed.locale : undefined,
    };
  } catch {
    return defaults;
  }
}

export function saveSettings(next: UiSettings) {
  if (typeof globalThis.localStorage === "undefined") {
    return;
  }
  localStorage.setItem(KEY, JSON.stringify(next));
}

// Per-session workspace directory cache.
// Survives page reloads so the project label renders immediately
// without waiting for the async sessions.list RPC.
const WORKSPACES_KEY = "openclaw.session.workspaces";

export function saveSessionWorkspace(sessionKey: string, dir: string | null) {
  try {
    const raw = localStorage.getItem(WORKSPACES_KEY);
    const map: Record<string, string> = raw ? JSON.parse(raw) : {};
    if (dir) {
      map[sessionKey] = dir;
    } else {
      delete map[sessionKey];
    }
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify(map));
  } catch {
    // Best-effort; localStorage may be full or unavailable.
  }
}

export function loadSessionWorkspace(sessionKey: string): string | null {
  try {
    const raw = localStorage.getItem(WORKSPACES_KEY);
    if (!raw) {
      return null;
    }
    const map = JSON.parse(raw) as Record<string, unknown>;
    const val = map[sessionKey];
    return typeof val === "string" ? val : null;
  } catch {
    return null;
  }
}
