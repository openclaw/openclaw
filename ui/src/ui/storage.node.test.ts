import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiSettings } from "./storage.ts";

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

function setViteDevScript(enabled: boolean) {
  if (
    typeof document === "undefined" ||
    typeof (document as Partial<Document>).querySelectorAll !== "function" ||
    typeof (document as Partial<Document>).createElement !== "function"
  ) {
    vi.stubGlobal("document", {
      querySelector: (selector: string) =>
        enabled && selector.includes("/@vite/client") ? ({} as Element) : null,
      querySelectorAll: () => [],
      createElement: () => ({ setAttribute() {}, remove() {} }) as unknown as HTMLScriptElement,
      head: { append() {} },
    } as Document);
    return;
  }
  document
    .querySelectorAll('script[data-test-vite-client="true"]')
    .forEach((node) => node.remove());
  if (!enabled) {
    return;
  }
  const script = document.createElement("script");
  script.setAttribute("data-test-vite-client", "true");
  script.setAttribute("src", "/@vite/client");
  document.head.append(script);
}

function expectedGatewayUrl(basePath: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${basePath}`;
}

function createSettings(overrides: Partial<UiSettings> = {}): UiSettings {
  return {
    gatewayUrl: "wss://gateway.example:8443/openclaw",
    token: "",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "claw",
    themeMode: "system",
    chatFocusMode: false,
    chatShowThinking: true,
    splitRatio: 0.6,
    navCollapsed: false,
    navWidth: 220,
    navGroupsCollapsed: {},
    ...overrides,
  };
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
    setViteDevScript(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setControlUiBasePath(undefined);
    setViteDevScript(false);
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

  it("defaults vite dev pages to the local gateway port", async () => {
    setTestLocation({
      protocol: "http:",
      host: "127.0.0.1:5174",
      pathname: "/chat",
    });
    setViteDevScript(true);

    const { loadSettings } = await import("./storage.ts");
    expect(loadSettings().gatewayUrl).toBe("ws://127.0.0.1:18789");
  });

  it("migrates persisted vite dev gateway URLs to the local gateway port", async () => {
    setTestLocation({
      protocol: "http:",
      host: "127.0.0.1:5174",
      pathname: "/chat",
    });
    setViteDevScript(true);
    localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({
        gatewayUrl: "ws://127.0.0.1:5174",
        sessionKey: "main",
        lastActiveSessionKey: "main",
        theme: "system",
        chatFocusMode: false,
        chatShowThinking: true,
        splitRatio: 0.6,
        navCollapsed: false,
        navGroupsCollapsed: {},
      }),
    );

    const { loadSettings } = await import("./storage.ts");
    expect(loadSettings().gatewayUrl).toBe("ws://127.0.0.1:18789");
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
      sessionKey: "agent",
      lastActiveSessionKey: "agent",
      theme: "claw",
      themeMode: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
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
    saveSettings(createSettings({ token: "session-token" }));

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
    saveSettings(createSettings({ token: "gateway-a-token" }));

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
    saveSettings(createSettings({ token: "memory-only-token" }));
    expect(loadSettings()).toMatchObject({
      gatewayUrl: "wss://gateway.example:8443/openclaw",
      token: "memory-only-token",
    });

    expect(JSON.parse(localStorage.getItem("openclaw.control.settings.v1") ?? "{}")).toEqual({
      gatewayUrl: "wss://gateway.example:8443/openclaw",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
    });
    expect(sessionStorage.length).toBe(1);
  });

  it("persists theme mode and nav width", async () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const { loadSettings, saveSettings } = await import("./storage.ts");
    saveSettings(
      createSettings({
        theme: "dash",
        themeMode: "light",
        navWidth: 360,
      }),
    );

    expect(loadSettings()).toMatchObject({
      theme: "dash",
      themeMode: "light",
      navWidth: 360,
    });
  });

  it("clears the current-tab token when saving an empty token", async () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const { loadSettings, saveSettings } = await import("./storage.ts");
    saveSettings(createSettings({ token: "stale-token" }));
    saveSettings(createSettings());

    expect(loadSettings().token).toBe("");
    expect(sessionStorage.length).toBe(0);
  });
});
