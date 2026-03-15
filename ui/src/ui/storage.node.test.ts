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
  if (typeof window !== "undefined" && window.history?.replaceState) {
    window.history.replaceState({}, "", params.pathname);
    return;
  }
  vi.stubGlobal("location", {
    protocol: params.protocol,
    host: params.host,
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
    sessionStorage.setItem("openclaw.control.token.v1", "legacy-session-token");
    localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({
        gatewayUrl: "wss://gateway.example:8443/openclaw",
        token: "persisted-token",
        sessionKey: "agent",
      }),
    );

    const { loadSettings } = await import("./storage.ts");
    expect(loadSettings()).toMatchObject({
      gatewayUrl: "wss://gateway.example:8443/openclaw",
      token: "",
      sessionKey: "agent",
    });
    expect(JSON.parse(localStorage.getItem("openclaw.control.settings.v1") ?? "{}")).toEqual({
      gatewayUrl: "wss://gateway.example:8443/openclaw",
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
        "wss://gateway.example:8443/openclaw": {
          sessionKey: "agent",
          lastActiveSessionKey: "agent",
        },
      },
    });
    expect(sessionStorage.length).toBe(0);
  });

  it("loads the current-tab token from sessionStorage", async () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const { loadSettings, saveSettings } = await import("./storage.ts");
    saveSettings({
      gatewayUrl: "wss://gateway.example:8443/openclaw",
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

    expect(loadSettings()).toMatchObject({
      gatewayUrl: "wss://gateway.example:8443/openclaw",
      token: "session-token",
    });
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

    const { loadSettings, saveSettings } = await import("./storage.ts");
    saveSettings({
      gatewayUrl: "wss://gateway.example:8443/openclaw",
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
    expect(loadSettings()).toMatchObject({
      gatewayUrl: "wss://gateway.example:8443/openclaw",
      token: "memory-only-token",
    });

    expect(JSON.parse(localStorage.getItem("openclaw.control.settings.v1") ?? "{}")).toEqual({
      gatewayUrl: "wss://gateway.example:8443/openclaw",
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
        "wss://gateway.example:8443/openclaw": {
          sessionKey: "main",
          lastActiveSessionKey: "main",
        },
      },
    });
    expect(sessionStorage.length).toBe(1);
  });

  it("clears the current-tab token when saving an empty token", async () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const { loadSettings, saveSettings } = await import("./storage.ts");
    saveSettings({
      gatewayUrl: "wss://gateway.example:8443/openclaw",
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
      gatewayUrl: "wss://gateway.example:8443/openclaw",
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
    expect(sessionStorage.length).toBe(0);
  });

  it("persists themeMode and navWidth alongside the selected theme", async () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const { saveSettings } = await import("./storage.ts");
    saveSettings({
      gatewayUrl: "wss://gateway.example:8443/openclaw",
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

    expect(JSON.parse(localStorage.getItem("openclaw.control.settings.v1") ?? "{}")).toMatchObject({
      theme: "dash",
      themeMode: "light",
      navWidth: 320,
    });
  });

  it("isolates settings by basePath", async () => {
    // Setup: Save settings for gateway-a
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/gateway-a/chat",
    });

    const { loadSettings: loadA, saveSettings: saveA } = await import("./storage.ts");
    saveA({
      gatewayUrl: "wss://gateway-a.example:8001",
      token: "token-a",
      sessionKey: "session-a",
      lastActiveSessionKey: "session-a",
      theme: "claw",
      themeMode: "dark",
      chatFocusMode: false,
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.5,
      navCollapsed: false,
      navWidth: 240,
      navGroupsCollapsed: {},
    });

    // Verify gateway-a settings are stored with basePath-specific key
    expect(localStorage.getItem("openclaw.control.settings.v1:/gateway-a")).toBeTruthy();
    expect(loadA()).toMatchObject({
      gatewayUrl: "wss://gateway-a.example:8001",
      sessionKey: "session-a",
      splitRatio: 0.5,
    });

    // Switch to gateway-b
    vi.resetModules();
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/gateway-b/chat",
    });

    const { loadSettings: loadB, saveSettings: saveB } = await import("./storage.ts");
    saveB({
      gatewayUrl: "wss://gateway-b.example:8002",
      token: "token-b",
      sessionKey: "session-b",
      lastActiveSessionKey: "session-b",
      theme: "dash",
      themeMode: "light",
      chatFocusMode: true,
      chatShowThinking: false,
      chatShowToolCalls: true,
      splitRatio: 0.7,
      navCollapsed: true,
      navWidth: 300,
      navGroupsCollapsed: {},
    });

    // Verify gateway-b settings are stored separately
    expect(localStorage.getItem("openclaw.control.settings.v1:/gateway-b")).toBeTruthy();
    expect(loadB()).toMatchObject({
      gatewayUrl: "wss://gateway-b.example:8002",
      sessionKey: "session-b",
      splitRatio: 0.7,
    });

    // Verify gateway-a settings are still intact
    vi.resetModules();
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/gateway-a/overview",
    });

    const { loadSettings: loadA2 } = await import("./storage.ts");
    expect(loadA2()).toMatchObject({
      gatewayUrl: "wss://gateway-a.example:8001",
      sessionKey: "session-a",
      splitRatio: 0.5,
    });
  });

  it("migrates legacy settings when accessing non-root basePath", async () => {
    // Setup: legacy data in old key
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/apps/openclaw/chat",
    });

    localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({
        gatewayUrl: "wss://gateway.example:8443/legacy",
        sessionKey: "legacy-session",
        theme: "claw",
        themeMode: "system",
        chatFocusMode: false,
        chatShowThinking: true,
        splitRatio: 0.6,
        navCollapsed: false,
        navWidth: 220,
        navGroupsCollapsed: {},
      }),
    );

    const { loadSettings } = await import("./storage.ts");
    const settings = loadSettings();

    // Verify settings were migrated
    expect(settings).toMatchObject({
      sessionKey: "legacy-session",
    });

    // Verify new key exists
    expect(localStorage.getItem("openclaw.control.settings.v1:/apps/openclaw")).toBeTruthy();

    // Verify old key was preserved (for root-path deployments)
    expect(localStorage.getItem("openclaw.control.settings.v1")).toBeTruthy();
  });

  it("does not migrate when basePath is empty (root path)", async () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({
        gatewayUrl: "wss://gateway.example:8443",
        sessionKey: "root-session",
        theme: "claw",
        themeMode: "system",
        chatFocusMode: false,
        chatShowThinking: true,
        splitRatio: 0.6,
        navCollapsed: false,
        navWidth: 220,
        navGroupsCollapsed: {},
      }),
    );

    const { loadSettings } = await import("./storage.ts");
    const settings = loadSettings();

    // Verify settings were loaded
    expect(settings.sessionKey).toBe("root-session");

    // Verify key remains unchanged (no migration)
    expect(localStorage.getItem("openclaw.control.settings.v1")).toBeTruthy();
  });

  it("respects window.__OPENCLAW_CONTROL_UI_BASE_PATH__ global for storage key", async () => {
    // Setup: pathname is "/" (root) but global is set to "/gateway-a"
    setTestLocation({
      protocol: "https:",
      host: "example.com",
      pathname: "/",
    });
    setControlUiBasePath("/gateway-a");

    const { loadSettings, saveSettings } = await import("./storage.ts");

    // Save settings
    saveSettings({
      gatewayUrl: "wss://example.com/gateway-a",
      token: "token-a",
      sessionKey: "session-a",
      lastActiveSessionKey: "session-a",
      theme: "claw",
      themeMode: "dark",
      chatFocusMode: false,
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.5,
      navCollapsed: false,
      navWidth: 240,
      navGroupsCollapsed: {},
    });

    // Verify storage key uses the global basePath, not the pathname
    expect(localStorage.getItem("openclaw.control.settings.v1:/gateway-a")).toBeTruthy();
    expect(localStorage.getItem("openclaw.control.settings.v1")).toBeNull();

    // Verify loading also uses the same key
    const loaded = loadSettings();
    expect(loaded.sessionKey).toBe("session-a");
    expect(loaded.splitRatio).toBe(0.5);
  });

  it("prefers window.__OPENCLAW_CONTROL_UI_BASE_PATH__ over pathname-inferred basePath", async () => {
    // Setup: pathname suggests /some/path but global overrides to /gateway-b
    setTestLocation({
      protocol: "https:",
      host: "example.com",
      pathname: "/some/path/chat",
    });
    setControlUiBasePath("/gateway-b");

    const { loadSettings, saveSettings } = await import("./storage.ts");

    saveSettings({
      gatewayUrl: "wss://example.com/gateway-b",
      token: "token-b",
      sessionKey: "session-b",
      lastActiveSessionKey: "session-b",
      theme: "dash",
      themeMode: "light",
      chatFocusMode: true,
      chatShowThinking: false,
      chatShowToolCalls: true,
      splitRatio: 0.7,
      navCollapsed: true,
      navWidth: 300,
      navGroupsCollapsed: {},
    });

    // Verify global basePath wins (not pathname-inferred /some/path)
    expect(localStorage.getItem("openclaw.control.settings.v1:/gateway-b")).toBeTruthy();
    expect(localStorage.getItem("openclaw.control.settings.v1:/some/path")).toBeNull();

    // Verify load uses the same key
    const loaded = loadSettings();
    expect(loaded.sessionKey).toBe("session-b");
    expect(loaded.splitRatio).toBe(0.7);
  });

  it("preserves root settings during non-root migration", async () => {
    // Setup: root-path deployment saves settings
    setTestLocation({
      protocol: "https:",
      host: "example.com",
      pathname: "/",
    });
    setControlUiBasePath(undefined);

    const { saveSettings: saveRoot } = await import("./storage.ts");
    saveRoot({
      gatewayUrl: "wss://example.com",
      token: "root-token",
      sessionKey: "root-session",
      lastActiveSessionKey: "root-session",
      theme: "claw",
      themeMode: "dark",
      chatFocusMode: false,
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 240,
      navGroupsCollapsed: {},
    });

    // Verify root settings saved to legacy key
    expect(localStorage.getItem("openclaw.control.settings.v1")).toBeTruthy();

    // Switch to non-root basePath
    vi.resetModules();
    setTestLocation({
      protocol: "https:",
      host: "example.com",
      pathname: "/gateway-a/chat",
    });
    setControlUiBasePath(undefined);

    const { loadSettings: loadNonRoot } = await import("./storage.ts");
    loadNonRoot(); // Trigger migration

    // Verify migration created new key
    expect(localStorage.getItem("openclaw.control.settings.v1:/gateway-a")).toBeTruthy();

    // Verify root settings were preserved (not deleted)
    expect(localStorage.getItem("openclaw.control.settings.v1")).toBeTruthy();

    // Switch back to root path
    vi.resetModules();
    setTestLocation({
      protocol: "https:",
      host: "example.com",
      pathname: "/",
    });
    setControlUiBasePath(undefined);

    const { loadSettings: loadRoot } = await import("./storage.ts");
    const rootSettings = loadRoot();

    // Verify root settings still work
    expect(rootSettings.sessionKey).toBe("root-session");
    expect(rootSettings.splitRatio).toBe(0.6);
  });

  it("migrates legacy settings to first-accessed non-root basePath only", async () => {
    // Setup: legacy data in old key
    setTestLocation({
      protocol: "https:",
      host: "example.com",
      pathname: "/",
    });
    setControlUiBasePath(undefined);

    localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({
        gatewayUrl: "wss://example.com",
        sessionKey: "legacy-session",
        theme: "claw",
        themeMode: "dark",
        chatFocusMode: false,
        chatShowThinking: true,
        chatShowToolCalls: true,
        splitRatio: 0.5,
        navCollapsed: false,
        navWidth: 200,
        navGroupsCollapsed: {},
      }),
    );

    // First non-root basePath access: /gateway-a/
    vi.resetModules();
    setTestLocation({
      protocol: "https:",
      host: "example.com",
      pathname: "/gateway-a/chat",
    });
    setControlUiBasePath(undefined);

    const { loadSettings: loadA } = await import("./storage.ts");
    const settingsA = loadA();

    // Verify migration happened to /gateway-a/
    expect(localStorage.getItem("openclaw.control.settings.v1:/gateway-a")).toBeTruthy();
    expect(settingsA.sessionKey).toBe("legacy-session");
    expect(settingsA.splitRatio).toBe(0.5);

    // Second non-root basePath access: /gateway-b/
    vi.resetModules();
    setTestLocation({
      protocol: "https:",
      host: "example.com",
      pathname: "/gateway-b/chat",
    });
    setControlUiBasePath(undefined);

    const { loadSettings: loadB } = await import("./storage.ts");
    const settingsB = loadB();

    // Verify migration did NOT happen to /gateway-b/ (already migrated once)
    expect(localStorage.getItem("openclaw.control.settings.v1:/gateway-b")).toBeNull();
    expect(settingsB.sessionKey).toBe("main"); // default
    expect(settingsB.splitRatio).toBe(0.6); // default
  });

  it("scopes persisted session selection per gateway", async () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const { loadSettings, saveSettings } = await import("./storage.ts");

    saveSettings({
      gatewayUrl: "wss://gateway-a.example:8443/openclaw",
      token: "",
      sessionKey: "agent:test_old:main",
      lastActiveSessionKey: "agent:test_old:main",
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
      gatewayUrl: "wss://gateway-b.example:8443/openclaw",
      token: "",
      sessionKey: "agent:test_new:main",
      lastActiveSessionKey: "agent:test_new:main",
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
        ...JSON.parse(localStorage.getItem("openclaw.control.settings.v1") ?? "{}"),
        gatewayUrl: "wss://gateway-a.example:8443/openclaw",
      }),
    );

    expect(loadSettings()).toMatchObject({
      gatewayUrl: "wss://gateway-a.example:8443/openclaw",
      sessionKey: "agent:test_old:main",
      lastActiveSessionKey: "agent:test_old:main",
    });

    localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({
        ...JSON.parse(localStorage.getItem("openclaw.control.settings.v1") ?? "{}"),
        gatewayUrl: "wss://gateway-b.example:8443/openclaw",
      }),
    );

    expect(loadSettings()).toMatchObject({
      gatewayUrl: "wss://gateway-b.example:8443/openclaw",
      sessionKey: "agent:test_new:main",
      lastActiveSessionKey: "agent:test_new:main",
    });
  });

  it("caps persisted session scopes to the most recent gateways", async () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const { saveSettings } = await import("./storage.ts");

    for (let i = 0; i < 12; i += 1) {
      saveSettings({
        gatewayUrl: `wss://gateway-${i}.example:8443/openclaw`,
        token: "",
        sessionKey: `agent:test_${i}:main`,
        lastActiveSessionKey: `agent:test_${i}:main`,
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
    }

    const persisted = JSON.parse(localStorage.getItem("openclaw.control.settings.v1") ?? "{}");
    const scopes = Object.keys(persisted.sessionsByGateway ?? {});

    expect(scopes).toHaveLength(10);
    expect(scopes).not.toContain("wss://gateway-0.example:8443/openclaw");
    expect(scopes).not.toContain("wss://gateway-1.example:8443/openclaw");
    expect(scopes).toContain("wss://gateway-11.example:8443/openclaw");
  });
});
