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

describe("loadSettings default gateway URL derivation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses configured base path and normalizes trailing slash", async () => {
    vi.stubGlobal("location", {
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/ignored/path",
    } as Location);
    vi.stubGlobal("window", { __OPENCLAW_CONTROL_UI_BASE_PATH__: " /openclaw/ " } as Window &
      typeof globalThis);

    const { loadSettings } = await import("./storage.ts");
    expect(loadSettings().gatewayUrl).toBe("wss://gateway.example:8443/openclaw");
  });

  it("infers base path from nested pathname when configured base path is not set", async () => {
    vi.stubGlobal("location", {
      protocol: "http:",
      host: "gateway.example:18789",
      pathname: "/apps/openclaw/chat",
    } as Location);
    vi.stubGlobal("window", {} as Window & typeof globalThis);

    const { loadSettings } = await import("./storage.ts");
    expect(loadSettings().gatewayUrl).toBe("ws://gateway.example:18789/apps/openclaw");
  });

  it("keeps saved private gateway URLs when page host changed", async () => {
    vi.stubGlobal("location", {
      protocol: "https:",
      host: "dashboard.example.com",
      pathname: "/",
    } as Location);
    vi.stubGlobal("window", {} as Window & typeof globalThis);
    localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({
        gatewayUrl: "ws://10.0.0.82:18789",
      }),
    );

    const { loadSettings } = await import("./storage.ts");
    expect(loadSettings().gatewayUrl).toBe("ws://10.0.0.82:18789");
  });

  it("keeps saved gateway URL when both saved and current hosts are private", async () => {
    vi.stubGlobal("location", {
      protocol: "http:",
      host: "10.0.0.90:18789",
      pathname: "/",
    } as Location);
    vi.stubGlobal("window", {} as Window & typeof globalThis);
    localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({
        gatewayUrl: "ws://10.0.0.82:18789",
      }),
    );

    const { loadSettings } = await import("./storage.ts");
    expect(loadSettings().gatewayUrl).toBe("ws://10.0.0.82:18789");
  });

  it("upgrades saved ws URL to secure default when host is unchanged and dashboard is https", async () => {
    vi.stubGlobal("location", {
      protocol: "https:",
      host: "dashboard.example.com",
      pathname: "/",
    } as Location);
    vi.stubGlobal("window", {} as Window & typeof globalThis);
    localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({
        gatewayUrl: "ws://dashboard.example.com",
      }),
    );

    const { loadSettings } = await import("./storage.ts");
    expect(loadSettings().gatewayUrl).toBe("wss://dashboard.example.com");
  });

  it("keeps saved ws URL on https dashboards when host differs", async () => {
    vi.stubGlobal("location", {
      protocol: "https:",
      host: "dashboard.example.com",
      pathname: "/",
    } as Location);
    vi.stubGlobal("window", {} as Window & typeof globalThis);
    localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({
        gatewayUrl: "ws://127.0.0.1:18789",
      }),
    );

    const { loadSettings } = await import("./storage.ts");
    expect(loadSettings().gatewayUrl).toBe("ws://127.0.0.1:18789");
  });

  it("falls back to default for non-websocket saved URLs", async () => {
    vi.stubGlobal("location", {
      protocol: "https:",
      host: "dashboard.example.com",
      pathname: "/",
    } as Location);
    vi.stubGlobal("window", {} as Window & typeof globalThis);
    localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({
        gatewayUrl: "https://dashboard.example.com",
      }),
    );

    const { loadSettings } = await import("./storage.ts");
    expect(loadSettings().gatewayUrl).toBe("wss://dashboard.example.com");
  });

  it("falls back to default for invalid saved gateway URLs", async () => {
    vi.stubGlobal("location", {
      protocol: "https:",
      host: "dashboard.example.com",
      pathname: "/",
    } as Location);
    vi.stubGlobal("window", {} as Window & typeof globalThis);
    localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({
        gatewayUrl: "dashboard.example.com",
      }),
    );

    const { loadSettings } = await import("./storage.ts");
    expect(loadSettings().gatewayUrl).toBe("wss://dashboard.example.com");
  });
});
