import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function createStorageMock(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

function setTestLocation(params: { protocol: string; host: string; pathname: string }) {
  vi.stubGlobal("location", {
    protocol: params.protocol,
    host: params.host,
    hostname: params.host.replace(/:\d+$/, ""),
    pathname: params.pathname,
  } as Location);
}

function setControlUiBasePath(value: string | undefined) {
  if (typeof window === "undefined") {
    vi.stubGlobal(
      "window",
      value == null
        ? ({} as Window & typeof globalThis)
        : ({ __OPENCLAW_CONTROL_UI_BASE_PATH__: value } as Window & typeof globalThis),
    );
    return;
  }
  if (value == null) {
    delete window.__OPENCLAW_CONTROL_UI_BASE_PATH__;
    return;
  }
  Object.defineProperty(window, "__OPENCLAW_CONTROL_UI_BASE_PATH__", {
    value,
    writable: true,
    configurable: true,
  });
}

function expectedGatewayUrl(basePath: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${basePath}`;
}

function normalizeGatewayScope(gatewayUrl: string): string {
  const trimmed = gatewayUrl.trim();
  if (!trimmed) {
    return "default";
  }
  const base = `${location.protocol}//${location.host}${location.pathname || "/"}`;
  const parsed = new URL(trimmed, base);
  const pathname =
    parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "") || parsed.pathname;
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}

function settingsKeyForGateway(gatewayUrl: string): string {
  return `openclaw.control.settings.v1:${normalizeGatewayScope(gatewayUrl)}`;
}

function tokenKeyForGateway(gatewayUrl: string): string {
  return `openclaw.control.token.v1:${normalizeGatewayScope(gatewayUrl)}`;
}

describe("loadSettings default gateway URL derivation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    localStorage.clear();
    sessionStorage.clear();
    setControlUiBasePath(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setControlUiBasePath(undefined);
    vi.unstubAllGlobals();
  });

  it("uses configured base path and normalizes trailing slash", async () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/ignored/path",
    });
    setControlUiBasePath(" /openclaw/ ");

    const { loadSettings } = await import("./storage.ts");
    expect(loadSettings().gatewayUrl).toBe(expectedGatewayUrl("/openclaw"));
  });

  it("infers base path from nested pathname when configured base path is not set", async () => {
    setTestLocation({
      protocol: "http:",
      host: "gateway.example:18789",
      pathname: "/apps/openclaw/chat",
    });

    const { loadSettings } = await import("./storage.ts");
    expect(loadSettings().gatewayUrl).toBe(expectedGatewayUrl("/apps/openclaw"));
  });

  it("ignores and scrubs legacy persisted tokens", async () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });
    const gatewayUrl = "wss://gateway.example:8443/openclaw";
    sessionStorage.setItem("openclaw.control.token.v1", "legacy-session-token");
    localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({
        gatewayUrl,
        token: "persisted-token",
        sessionKey: "agent",
      }),
    );

    const { loadSettings } = await import("./storage.ts");
    expect(loadSettings()).toMatchObject({
      gatewayUrl,
      token: "",
      sessionKey: "agent",
      lastActiveSessionKey: "agent",
    });
    expect(sessionStorage.getItem("openclaw.control.token.v1")).toBeNull();
    expect(JSON.parse(localStorage.getItem(settingsKeyForGateway(gatewayUrl)) ?? "{}")).toEqual({
      gatewayUrl,
      theme: "claw",
      themeMode: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
      sessionsByGateway: {
        [normalizeGatewayScope(gatewayUrl)]: {
          sessionKey: "agent",
          lastActiveSessionKey: "agent",
        },
      },
    });
  });

  it("loads the current-tab token from sessionStorage", async () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });
    setControlUiBasePath("/openclaw");
    const gatewayUrl = "wss://gateway.example:8443/openclaw";

    const { loadSettings, saveSettings } = await import("./storage.ts");
    saveSettings({
      gatewayUrl,
      token: "session-token",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
    });

    expect(loadSettings()).toMatchObject({ gatewayUrl, token: "session-token" });
    expect(sessionStorage.getItem(tokenKeyForGateway(gatewayUrl))).toBe("session-token");
  });

  it("does not reuse a session token for a different gatewayUrl", async () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const { loadSettings, saveSettings } = await import("./storage.ts");
    saveSettings({
      gatewayUrl: "wss://gateway.example:8443/openclaw",
      token: "gateway-a-token",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
    });

    localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({
        gatewayUrl: "wss://other-gateway.example:8443/openclaw",
        sessionKey: "main",
        lastActiveSessionKey: "main",
        theme: "claw",
        themeMode: "system",
        chatFocusMode: false,
        chatShowThinking: true,
        chatShowToolCalls: true,
        splitRatio: 0.6,
        navCollapsed: false,
        navWidth: 220,
        navGroupsCollapsed: {},
      }),
    );

    expect(loadSettings()).toMatchObject({
      gatewayUrl: "wss://other-gateway.example:8443/openclaw",
      token: "",
    });
  });

  it("does not persist gateway tokens when saving settings", async () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });
    setControlUiBasePath("/openclaw");
    const gatewayUrl = "wss://gateway.example:8443/openclaw";

    const { loadSettings, saveSettings } = await import("./storage.ts");
    saveSettings({
      gatewayUrl,
      token: "memory-only-token",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
    });

    expect(loadSettings()).toMatchObject({ gatewayUrl, token: "memory-only-token" });
    expect(JSON.parse(localStorage.getItem(settingsKeyForGateway(gatewayUrl)) ?? "{}")).toEqual({
      gatewayUrl,
      theme: "claw",
      themeMode: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
      sessionsByGateway: {
        [normalizeGatewayScope(gatewayUrl)]: {
          sessionKey: "main",
          lastActiveSessionKey: "main",
        },
      },
    });
    expect(sessionStorage.getItem(tokenKeyForGateway(gatewayUrl))).toBe("memory-only-token");
  });

  it("clears the current-tab token when saving an empty token", async () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });
    const gatewayUrl = "wss://gateway.example:8443/openclaw";

    const { loadSettings, saveSettings } = await import("./storage.ts");
    saveSettings({
      gatewayUrl,
      token: "stale-token",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
    });
    saveSettings({
      gatewayUrl,
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
    });

    expect(loadSettings().token).toBe("");
    expect(sessionStorage.getItem(tokenKeyForGateway(gatewayUrl))).toBeNull();
  });

  it("persists themeMode and navWidth alongside the selected theme", async () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });
    const gatewayUrl = "wss://gateway.example:8443/openclaw";

    const { saveSettings } = await import("./storage.ts");
    saveSettings({
      gatewayUrl,
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "dash",
      themeMode: "light",
      chatFocusMode: false,
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 320,
      navGroupsCollapsed: {},
    });

    expect(
      JSON.parse(localStorage.getItem(settingsKeyForGateway(gatewayUrl)) ?? "{}"),
    ).toMatchObject({
      theme: "dash",
      themeMode: "light",
      navWidth: 320,
    });
  });

  it("resolves scoped session selection from persisted sessionsByGateway", async () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const persisted = {
      gatewayUrl: "wss://gateway-a.example:8443/openclaw",
      theme: "claw",
      themeMode: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
      sessionsByGateway: {
        "wss://gateway-a.example:8443/openclaw": {
          sessionKey: "agent:test_old:main",
          lastActiveSessionKey: "agent:test_old:main",
        },
        "wss://gateway-b.example:8443/openclaw": {
          sessionKey: "agent:test_new:main",
          lastActiveSessionKey: "agent:test_new:main",
        },
      },
    };

    localStorage.setItem("openclaw.control.settings.v1", JSON.stringify(persisted));
    const { loadSettings } = await import("./storage.ts");

    expect(loadSettings()).toMatchObject({
      gatewayUrl: "wss://gateway-a.example:8443/openclaw",
      sessionKey: "agent:test_old:main",
      lastActiveSessionKey: "agent:test_old:main",
    });

    localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({ ...persisted, gatewayUrl: "wss://gateway-b.example:8443/openclaw" }),
    );

    expect(loadSettings()).toMatchObject({
      gatewayUrl: "wss://gateway-b.example:8443/openclaw",
      sessionKey: "agent:test_new:main",
      lastActiveSessionKey: "agent:test_new:main",
    });
  });

  it("caps persisted session scopes to the most recent gateways when saving", async () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const existingSessionsByGateway = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [
        `wss://gateway-${i}.example:8443/openclaw`,
        {
          sessionKey: `agent:test_${i}:main`,
          lastActiveSessionKey: `agent:test_${i}:main`,
        },
      ]),
    );

    localStorage.setItem(
      "openclaw.control.settings.v1:default",
      JSON.stringify({
        gatewayUrl: "wss://gateway-9.example:8443/openclaw",
        theme: "claw",
        themeMode: "system",
        chatFocusMode: false,
        chatShowThinking: true,
        chatShowToolCalls: true,
        splitRatio: 0.6,
        navCollapsed: false,
        navWidth: 220,
        navGroupsCollapsed: {},
        sessionsByGateway: existingSessionsByGateway,
      }),
    );

    const { saveSettings } = await import("./storage.ts");
    saveSettings({
      gatewayUrl: "wss://gateway-10.example:8443/openclaw",
      token: "",
      sessionKey: "agent:test_10:main",
      lastActiveSessionKey: "agent:test_10:main",
      theme: "claw",
      themeMode: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
    });

    const persisted = JSON.parse(
      localStorage.getItem(settingsKeyForGateway("wss://gateway-10.example:8443/openclaw")) ?? "{}",
    );
    const scopes = Object.keys(persisted.sessionsByGateway ?? {});

    expect(scopes).toHaveLength(10);
    expect(scopes).not.toContain("wss://gateway-0.example:8443/openclaw");
    expect(scopes).toContain("wss://gateway-10.example:8443/openclaw");
  });
});
