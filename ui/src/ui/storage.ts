// Control UI module implements storage behavior.
const SETTINGS_KEY_PREFIX = "openclaw.control.settings.v1:";
const LEGACY_SETTINGS_KEY = "openclaw.control.settings.v1";
const LOCAL_USER_IDENTITY_KEY = "openclaw.control.user.v1";
const LOCAL_ASSISTANT_IDENTITY_KEY = "openclaw.control.assistant.v1";
const LEGACY_TOKEN_SESSION_KEY = "openclaw.control.token.v1";
const TOKEN_SESSION_KEY_PREFIX = "openclaw.control.token.v1:";
const MAX_SCOPED_SESSION_ENTRIES = 10;

function settingsKeyForGateway(gatewayUrl: string): string {
  return `${SETTINGS_KEY_PREFIX}${normalizeGatewayTokenScope(gatewayUrl)}`;
}

type ScopedSessionSelection = {
  sessionKey: string;
  lastActiveSessionKey: string;
};

type PersistedUiSettings = Omit<UiSettings, "token" | "sessionKey" | "lastActiveSessionKey"> & {
  token?: never;
  sessionKey?: string;
  lastActiveSessionKey?: string;
  sessionsByGateway?: Record<string, ScopedSessionSelection>;
};

type LoadedSettingsSource = "scoped" | "default" | "legacy";

import { isSupportedLocale } from "../i18n/index.ts";
import { getSafeLocalStorage, getSafeSessionStorage } from "../local-storage.ts";
import { parseImportedCustomTheme, type ImportedCustomTheme } from "./custom-theme.ts";
import { inferBasePathFromPathname, normalizeBasePath } from "./navigation.ts";
import { normalizeOptionalString } from "./string-coerce.ts";
import { parseThemeSelection, type ThemeMode, type ThemeName } from "./theme.ts";
import {
  hasLocalUserIdentity,
  normalizeLocalUserIdentity,
  type LocalUserIdentity,
} from "./user-identity.ts";

export const BORDER_RADIUS_STOPS = [0, 25, 50, 75, 100] as const;
export type BorderRadiusStop = (typeof BORDER_RADIUS_STOPS)[number];

export const TEXT_SCALE_STOPS = [90, 100, 110, 125, 140] as const;
export type TextScaleStop = (typeof TEXT_SCALE_STOPS)[number];

export const CHAT_AUTO_SCROLL_MODES = ["always", "near-bottom", "off"] as const;
export type ChatAutoScrollMode = (typeof CHAT_AUTO_SCROLL_MODES)[number];

export function normalizeChatAutoScrollMode(value: unknown): ChatAutoScrollMode {
  return CHAT_AUTO_SCROLL_MODES.includes(value as ChatAutoScrollMode)
    ? (value as ChatAutoScrollMode)
    : "near-bottom";
}

function snapBorderRadius(value: number): BorderRadiusStop {
  let best: BorderRadiusStop = BORDER_RADIUS_STOPS[0];
  let bestDist = Math.abs(value - best);
  for (const stop of BORDER_RADIUS_STOPS) {
    const dist = Math.abs(value - stop);
    if (dist < bestDist) {
      best = stop;
      bestDist = dist;
    }
  }
  return best;
}

export function normalizeTextScale(value: unknown, fallback: TextScaleStop = 100): TextScaleStop {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  let best: TextScaleStop = TEXT_SCALE_STOPS[0];
  let bestDist = Math.abs(value - best);
  for (const stop of TEXT_SCALE_STOPS) {
    const dist = Math.abs(value - stop);
    if (dist < bestDist) {
      best = stop;
      bestDist = dist;
    }
  }
  return best;
}

export type UiSettings = {
  gatewayUrl: string;
  token: string;
  sessionKey: string;
  lastActiveSessionKey: string;
  theme: ThemeName;
  themeMode: ThemeMode;
  chatShowThinking: boolean;
  chatShowToolCalls: boolean;
  chatAutoScroll?: ChatAutoScrollMode;
  splitRatio: number; // Sidebar split ratio (0.4 to 0.7, default 0.6)
  navCollapsed: boolean; // Collapsible sidebar state
  navWidth: number; // Sidebar width when expanded (240–400px)
  navGroupsCollapsed: Record<string, boolean>; // Which nav groups are collapsed
  recentSessionsCollapsed?: boolean; // Collapse recent sessions list in sidebar
  borderRadius: number; // Corner roundness (0–100, default 50)
  textScale?: TextScaleStop; // Browser-local text scale percentage
  customTheme?: ImportedCustomTheme;
  locale?: string;
};

export type { LocalUserIdentity } from "./user-identity.ts";

function isViteDevPage(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  return Boolean(document.querySelector('script[src*="/@vite/client"]'));
}

function formatHostWithPort(hostname: string, port: string): string {
  const normalizedHost = hostname.includes(":") ? `[${hostname}]` : hostname;
  return `${normalizedHost}:${port}`;
}

function deriveDefaultGatewayUrl(): { pageUrl: string; effectiveUrl: string } {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const configured =
    typeof window !== "undefined" &&
    normalizeOptionalString(window["__OPENCLAW_CONTROL_UI_BASE_PATH__"]);
  const basePath = configured
    ? normalizeBasePath(configured)
    : inferBasePathFromPathname(location.pathname);
  const pageUrl = `${proto}://${location.host}${basePath}`;
  if (!isViteDevPage()) {
    return { pageUrl, effectiveUrl: pageUrl };
  }
  const effectiveUrl = `${proto}://${formatHostWithPort(location.hostname, "18789")}`;
  return { pageUrl, effectiveUrl };
}

function getSessionStorage(): Storage | null {
  return getSafeSessionStorage();
}

function parseGatewayScopeParts(
  gatewayUrl: string,
): { scope: string; origin: string; host: string; pathname: string } | null {
  try {
    const base =
      typeof location !== "undefined"
        ? `${location.protocol}//${location.host}${location.pathname || "/"}`
        : undefined;
    const parsed = base ? new URL(gatewayUrl, base) : new URL(gatewayUrl);
    const pathname =
      parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "") || parsed.pathname;
    const origin = `${parsed.protocol}//${parsed.host}`;
    return { scope: `${origin}${pathname}`, origin, host: parsed.host, pathname };
  } catch {
    return null;
  }
}

function normalizeGatewayTokenScope(gatewayUrl: string): string {
  const trimmed = normalizeOptionalString(gatewayUrl) ?? "";
  if (!trimmed) {
    return "default";
  }
  return parseGatewayScopeParts(trimmed)?.scope ?? trimmed;
}

function resolvePersistedGatewayUrl(params: {
  parsedGatewayUrl: string;
  pageDerivedUrl: string;
  defaultUrl: string;
}): string {
  if (params.parsedGatewayUrl === params.pageDerivedUrl) {
    return params.defaultUrl;
  }
  return params.parsedGatewayUrl;
}

function isRootWebSocketEndpointPath(pathname: string): boolean {
  return pathname.toLowerCase() === "/ws";
}

function shouldIgnoreLegacySettingsForPage(params: {
  source: LoadedSettingsSource;
  parsedGatewayUrl: string;
  pageDerivedUrl: string;
}): boolean {
  if (params.source !== "legacy") {
    return false;
  }
  const parsed = parseGatewayScopeParts(params.parsedGatewayUrl);
  const page = parseGatewayScopeParts(params.pageDerivedUrl);
  if (!parsed || !page || !page.pathname || parsed.host !== page.host) {
    return false;
  }
  if (parsed.pathname === page.pathname) {
    return false;
  }
  if (isRootWebSocketEndpointPath(parsed.pathname)) {
    return false;
  }
  return true;
}

function tokenSessionKeyForGateway(gatewayUrl: string): string {
  return `${TOKEN_SESSION_KEY_PREFIX}${normalizeGatewayTokenScope(gatewayUrl)}`;
}

function resolveScopedSessionSelection(
  gatewayUrl: string,
  parsed: PersistedUiSettings,
  defaults: UiSettings,
): ScopedSessionSelection {
  const scope = normalizeGatewayTokenScope(gatewayUrl);
  const scoped = parsed.sessionsByGateway?.[scope];
  const scopedSessionKey = normalizeOptionalString(scoped?.sessionKey);
  const scopedLastActiveSessionKey = normalizeOptionalString(scoped?.lastActiveSessionKey);
  if (scopedSessionKey && scopedLastActiveSessionKey) {
    return {
      sessionKey: scopedSessionKey,
      lastActiveSessionKey: scopedLastActiveSessionKey,
    };
  }

  const legacySessionKey = normalizeOptionalString(parsed.sessionKey) ?? defaults.sessionKey;
  const legacyLastActiveSessionKey =
    normalizeOptionalString(parsed.lastActiveSessionKey) ??
    legacySessionKey ??
    defaults.lastActiveSessionKey;

  return {
    sessionKey: legacySessionKey,
    lastActiveSessionKey: legacyLastActiveSessionKey,
  };
}

function loadSessionToken(gatewayUrl: string): string {
  try {
    const storage = getSessionStorage();
    if (!storage) {
      return "";
    }
    storage.removeItem(LEGACY_TOKEN_SESSION_KEY);
    const token = storage.getItem(tokenSessionKeyForGateway(gatewayUrl));
    return normalizeOptionalString(token) ?? "";
  } catch {
    return "";
  }
}

export function resolveGatewayTokenForUrlEdit(
  currentGatewayUrl: string,
  nextGatewayUrl: string,
  currentToken: string,
): string {
  if (
    normalizeGatewayTokenScope(currentGatewayUrl) === normalizeGatewayTokenScope(nextGatewayUrl)
  ) {
    return currentToken;
  }
  // Gateway tokens stay session-scoped across endpoint edits.
  // Durable settings may contain scrubbed legacy tokens, but must not restore them here.
  return loadSessionToken(nextGatewayUrl);
}

function persistSessionToken(gatewayUrl: string, token: string) {
  try {
    const storage = getSessionStorage();
    if (!storage) {
      return;
    }
    storage.removeItem(LEGACY_TOKEN_SESSION_KEY);
    const key = tokenSessionKeyForGateway(gatewayUrl);
    const normalized = normalizeOptionalString(token) ?? "";
    if (normalized) {
      storage.setItem(key, normalized);
      return;
    }
    storage.removeItem(key);
  } catch {
    // best-effort
  }
}

export function loadSettings(): UiSettings {
  const { pageUrl: pageDerivedUrl, effectiveUrl: defaultUrl } = deriveDefaultGatewayUrl();
  const storage = getSafeLocalStorage();

  const defaults: UiSettings = {
    gatewayUrl: defaultUrl,
    token: loadSessionToken(defaultUrl),
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "claw",
    themeMode: "system",
    chatShowThinking: true,
    chatShowToolCalls: true,
    chatAutoScroll: "near-bottom",
    splitRatio: 0.6,
    navCollapsed: false,
    navWidth: 220,
    navGroupsCollapsed: {},
    recentSessionsCollapsed: false,
    borderRadius: 50,
    textScale: 100,
  };

  try {
    // Prefer the current scoped record; legacy global settings are a fallback for older installs.
    const scopedKey = settingsKeyForGateway(defaults.gatewayUrl);
    const pageScopedKey = settingsKeyForGateway(pageDerivedUrl);
    const scopedRaw = storage?.getItem(scopedKey);
    const pageScopedRaw = pageScopedKey === scopedKey ? null : storage?.getItem(pageScopedKey);
    const defaultRaw = storage?.getItem(SETTINGS_KEY_PREFIX + "default");
    const legacyRaw = storage?.getItem(LEGACY_SETTINGS_KEY);
    const loaded =
      scopedRaw != null
        ? { raw: scopedRaw, source: "scoped" as const }
        : pageScopedRaw != null
          ? { raw: pageScopedRaw, source: "scoped" as const }
          : defaultRaw != null
            ? { raw: defaultRaw, source: "default" as const }
            : legacyRaw != null
              ? { raw: legacyRaw, source: "legacy" as const }
              : null;
    if (!loaded?.raw) {
      return defaults;
    }
    const parsed = JSON.parse(loaded.raw) as PersistedUiSettings;
    const parsedGatewayUrl = normalizeOptionalString(parsed.gatewayUrl) ?? defaults.gatewayUrl;
    if (
      shouldIgnoreLegacySettingsForPage({
        source: loaded.source,
        parsedGatewayUrl,
        pageDerivedUrl,
      })
    ) {
      persistSettings(defaults);
      return defaults;
    }
    const gatewayUrl = resolvePersistedGatewayUrl({
      parsedGatewayUrl,
      pageDerivedUrl,
      defaultUrl,
    });
    const scopedSessionSelection = resolveScopedSessionSelection(gatewayUrl, parsed, defaults);
    const customTheme = parseImportedCustomTheme((parsed as { customTheme?: unknown }).customTheme);
    const { theme, mode } = parseThemeSelection(
      (parsed as { theme?: unknown }).theme,
      (parsed as { themeMode?: unknown }).themeMode,
    );
    const settings = {
      gatewayUrl,
      // Gateway auth is intentionally in-memory only; scrub any legacy persisted token on load.
      token: loadSessionToken(gatewayUrl),
      sessionKey: scopedSessionSelection.sessionKey,
      lastActiveSessionKey: scopedSessionSelection.lastActiveSessionKey,
      theme: theme === "custom" && !customTheme ? "claw" : theme,
      themeMode: mode,
      chatShowThinking:
        typeof parsed.chatShowThinking === "boolean"
          ? parsed.chatShowThinking
          : defaults.chatShowThinking,
      chatShowToolCalls:
        typeof parsed.chatShowToolCalls === "boolean"
          ? parsed.chatShowToolCalls
          : defaults.chatShowToolCalls,
      chatAutoScroll: normalizeChatAutoScrollMode(parsed.chatAutoScroll),
      splitRatio:
        typeof parsed.splitRatio === "number" &&
        parsed.splitRatio >= 0.4 &&
        parsed.splitRatio <= 0.7
          ? parsed.splitRatio
          : defaults.splitRatio,
      navCollapsed:
        typeof parsed.navCollapsed === "boolean" ? parsed.navCollapsed : defaults.navCollapsed,
      navWidth:
        typeof parsed.navWidth === "number" && parsed.navWidth >= 200 && parsed.navWidth <= 400
          ? parsed.navWidth
          : defaults.navWidth,
      navGroupsCollapsed:
        typeof parsed.navGroupsCollapsed === "object" && parsed.navGroupsCollapsed !== null
          ? parsed.navGroupsCollapsed
          : defaults.navGroupsCollapsed,
      recentSessionsCollapsed:
        typeof parsed.recentSessionsCollapsed === "boolean"
          ? parsed.recentSessionsCollapsed
          : defaults.recentSessionsCollapsed,
      borderRadius:
        typeof parsed.borderRadius === "number" &&
        parsed.borderRadius >= 0 &&
        parsed.borderRadius <= 100
          ? snapBorderRadius(parsed.borderRadius)
          : defaults.borderRadius,
      textScale: normalizeTextScale(parsed.textScale, defaults.textScale),
      customTheme: customTheme ?? undefined,
      locale: isSupportedLocale(parsed.locale) ? parsed.locale : undefined,
    };
    if (loaded.source === "legacy" || "token" in parsed) {
      persistSettings(settings);
    }
    return settings;
  } catch {
    return defaults;
  }
}

export function saveSettings(next: UiSettings) {
  persistSettings(next);
}

export function loadLocalUserIdentity(): LocalUserIdentity {
  const storage = getSafeLocalStorage();
  try {
    const raw = storage?.getItem(LOCAL_USER_IDENTITY_KEY);
    if (!raw) {
      return normalizeLocalUserIdentity();
    }
    return normalizeLocalUserIdentity(JSON.parse(raw) as Partial<LocalUserIdentity>);
  } catch {
    return normalizeLocalUserIdentity();
  }
}

export function saveLocalUserIdentity(next: LocalUserIdentity) {
  const storage = getSafeLocalStorage();
  const normalized = normalizeLocalUserIdentity(next);
  try {
    if (!hasLocalUserIdentity(normalized)) {
      storage?.removeItem(LOCAL_USER_IDENTITY_KEY);
      return;
    }
    storage?.setItem(LOCAL_USER_IDENTITY_KEY, JSON.stringify(normalized));
  } catch {
    // best-effort — quota exceeded or security restrictions should not
    // prevent in-memory identity updates from being applied
  }
}

export type LocalAssistantIdentity = { avatar: string | null; agentId?: string | null };

type PersistedLocalAssistantIdentities = {
  avatars?: Record<string, unknown>;
  avatar?: unknown;
  agentId?: unknown;
};

function parseLocalAssistantAvatarMap(raw: string): {
  avatars: Record<string, string>;
  legacyAvatar: string | null;
} {
  const parsed = JSON.parse(raw) as PersistedLocalAssistantIdentities;
  const avatars = Object.create(null) as Record<string, string>;
  if (parsed.avatars && typeof parsed.avatars === "object" && !Array.isArray(parsed.avatars)) {
    for (const [agentId, avatar] of Object.entries(parsed.avatars)) {
      const normalizedAgentId = normalizeOptionalString(agentId);
      const normalizedAvatar = normalizeOptionalString(avatar);
      if (normalizedAgentId && normalizedAvatar) {
        avatars[normalizedAgentId] = normalizedAvatar;
      }
    }
  }
  const legacyAvatar = normalizeOptionalString(parsed.avatar);
  const legacyAgentId = normalizeOptionalString(parsed.agentId);
  if (legacyAvatar && legacyAgentId && !Object.hasOwn(avatars, legacyAgentId)) {
    avatars[legacyAgentId] = legacyAvatar;
  }
  return { avatars, legacyAvatar: legacyAgentId ? null : (legacyAvatar ?? null) };
}

function persistLocalAssistantAvatarMap(storage: Storage | null, avatars: Record<string, string>) {
  if (Object.keys(avatars).length === 0) {
    storage?.removeItem(LOCAL_ASSISTANT_IDENTITY_KEY);
    return;
  }
  storage?.setItem(LOCAL_ASSISTANT_IDENTITY_KEY, JSON.stringify({ avatars }));
}

export function loadLocalAssistantIdentity(opts?: {
  agentId?: string | null;
}): LocalAssistantIdentity {
  const agentId = normalizeOptionalString(opts?.agentId);
  if (!agentId) {
    return { avatar: null };
  }
  const storage = getSafeLocalStorage();
  try {
    const raw = storage?.getItem(LOCAL_ASSISTANT_IDENTITY_KEY);
    if (!raw) {
      return { avatar: null };
    }
    const { avatars, legacyAvatar } = parseLocalAssistantAvatarMap(raw);
    if (!Object.hasOwn(avatars, agentId) && legacyAvatar) {
      // Assign the old global override to the first concrete agent that loads it.
      avatars[agentId] = legacyAvatar;
      persistLocalAssistantAvatarMap(storage, avatars);
    }
    return { avatar: Object.hasOwn(avatars, agentId) ? avatars[agentId] : null, agentId };
  } catch {
    return { avatar: null };
  }
}

export function saveLocalAssistantIdentity(next: LocalAssistantIdentity) {
  const agentId = normalizeOptionalString(next.agentId);
  if (!agentId) {
    return;
  }
  const storage = getSafeLocalStorage();
  try {
    const raw = storage?.getItem(LOCAL_ASSISTANT_IDENTITY_KEY);
    const avatars = raw
      ? parseLocalAssistantAvatarMap(raw).avatars
      : (Object.create(null) as Record<string, string>);
    const avatar = normalizeOptionalString(next.avatar);
    if (avatar) {
      avatars[agentId] = avatar;
    } else {
      delete avatars[agentId];
    }
    persistLocalAssistantAvatarMap(storage, avatars);
  } catch {
    // best-effort — quota exceeded or security restrictions should not
    // prevent in-memory identity updates from being applied
  }
}

function persistSettings(next: UiSettings) {
  persistSessionToken(next.gatewayUrl, next.token);
  const storage = getSafeLocalStorage();
  const scope = normalizeGatewayTokenScope(next.gatewayUrl);
  const scopedKey = settingsKeyForGateway(next.gatewayUrl);
  let existingSessionsByGateway: Record<string, ScopedSessionSelection> = {};
  try {
    // Try to migrate from legacy key or other scopes
    const raw =
      storage?.getItem(scopedKey) ??
      storage?.getItem(SETTINGS_KEY_PREFIX + "default") ??
      storage?.getItem("openclaw.control.settings.v1");
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedUiSettings;
      if (parsed.sessionsByGateway && typeof parsed.sessionsByGateway === "object") {
        existingSessionsByGateway = parsed.sessionsByGateway;
      }
    }
  } catch {
    // best-effort
  }
  const sessionsByGateway = Object.fromEntries(
    [
      ...Object.entries(existingSessionsByGateway).filter(([key]) => key !== scope),
      [
        scope,
        {
          sessionKey: next.sessionKey,
          lastActiveSessionKey: next.lastActiveSessionKey,
        },
      ],
    ].slice(-MAX_SCOPED_SESSION_ENTRIES),
  );
  const persisted: PersistedUiSettings = {
    gatewayUrl: next.gatewayUrl,
    theme: next.theme,
    themeMode: next.themeMode,
    chatShowThinking: next.chatShowThinking,
    chatShowToolCalls: next.chatShowToolCalls,
    chatAutoScroll: normalizeChatAutoScrollMode(next.chatAutoScroll),
    splitRatio: next.splitRatio,
    navCollapsed: next.navCollapsed,
    navWidth: next.navWidth,
    navGroupsCollapsed: next.navGroupsCollapsed,
    recentSessionsCollapsed: next.recentSessionsCollapsed ?? false,
    borderRadius: next.borderRadius,
    textScale: normalizeTextScale(next.textScale),
    ...(next.customTheme ? { customTheme: next.customTheme } : {}),
    sessionsByGateway,
    ...(next.locale ? { locale: next.locale } : {}),
  };
  const serialized = JSON.stringify(persisted);
  try {
    storage?.setItem(scopedKey, serialized);
    const { pageUrl: pageDerivedUrl } = deriveDefaultGatewayUrl();
    const pageScopedKey = settingsKeyForGateway(pageDerivedUrl);
    if (pageScopedKey !== scopedKey) {
      storage?.setItem(pageScopedKey, serialized);
    }
    storage?.removeItem(LEGACY_SETTINGS_KEY);
  } catch {
    // best-effort — quota exceeded or security restrictions should not
    // prevent in-memory settings and visual updates from being applied
  }
}
