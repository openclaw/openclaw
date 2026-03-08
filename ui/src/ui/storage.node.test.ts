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
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    localStorage.clear();
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
      sessionKey: "agent",
      lastActiveSessionKey: "agent",
      theme: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navGroupsCollapsed: {},
    });
  });

  it("does not persist gateway tokens when saving settings", async () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const { saveSettings } = await import("./storage.ts");
    saveSettings({
      gatewayUrl: "wss://gateway.example:8443/openclaw",
      token: "memory-only-token",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navGroupsCollapsed: {},
    });

    expect(JSON.parse(localStorage.getItem("openclaw.control.settings.v1") ?? "{}")).toEqual({
      gatewayUrl: "wss://gateway.example:8443/openclaw",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navGroupsCollapsed: {},
    });
  });
});
