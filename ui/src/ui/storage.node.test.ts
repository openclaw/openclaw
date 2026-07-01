// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createImportedCustomThemeFixture } from "../test-helpers/custom-theme.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  loadLocalUserIdentity,
  loadSettings,
  saveLocalUserIdentity,
  saveSettings,
} from "./storage.ts";

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
    delete window["__OPENCLAW_CONTROL_UI_BASE_PATH__"];
    return;
  }
  Object.defineProperty(window, "__OPENCLAW_CONTROL_UI_BASE_PATH__", {
    value,
    writable: true,
    configurable: true,
  });
}

function setViteDevPage() {
  vi.stubGlobal("document", {
    querySelector: (selector: string) =>
      selector === 'script[src*="/@vite/client"]' ? ({ src: "/@vite/client" } as unknown as Element) : null,
  } as Document);
}

function expectedGatewayUrl(basePath: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${basePath}`;
}

describe("loadSettings default gateway URL derivation", () => {
  beforeEach(() => {
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

  it("uses configured base path and normalizes trailing slash", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/ignored/path",
    });
    setControlUiBasePath(" /openclaw/ ");

    expect(loadSettings().gatewayUrl).toBe(expectedGatewayUrl("/openclaw"));
  });

  it("defaults chat auto-scroll to near-bottom", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    expect(loadSettings().chatAutoScroll).toBe("near-bottom");
  });

  it("infers base path from nested pathname when configured base path is not set", () => {
    setTestLocation({
      protocol: "http:",
      host: "gateway.example:18789",
      pathname: "/apps/openclaw/chat",
    });

    expect(loadSettings().gatewayUrl).toBe(expectedGatewayUrl("/apps/openclaw"));
  });

  it("skips node sessionStorage accessors that warn without a storage file", () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });
    setControlUiBasePath(undefined);
    const warningSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    const settings = loadSettings();
    expect(settings.gatewayUrl).toBe(expectedGatewayUrl(""));
    expect(settings.token).toBe("");
    expect(
      warningSpy.mock.calls.some(
        ([message]) => message === "`--localstorage-file` was provided without a valid path",
      ),
    ).toBe(false);
  });

  it("ignores and scrubs legacy persisted tokens", () => {
    // Use a pathname that shares the same basePath as the stored gatewayUrl so
    // the fallback is accepted.  The test verifies that the persisted token is
    // scrubbed even when the rest of the settings are migrated.
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/openclaw/chat",
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

    const settings = loadSettings();
    expect(settings.gatewayUrl).toBe("wss://gateway.example:8443/openclaw");
    expect(settings.token).toBe("");
    expect(settings.sessionKey).toBe("agent");
    const scopedKey = "openclaw.control.settings.v1:wss://gateway.example:8443/openclaw";
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}")).toEqual({
      gatewayUrl: "wss://gateway.example:8443/openclaw",
      theme: "claw",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      chatPersistCommentary: false,
      chatAutoScroll: "near-bottom",
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
      recentSessionsCollapsed: false,
      borderRadius: 50,
      textScale: 100,
      sessionsByGateway: {
        "wss://gateway.example:8443/openclaw": {
          sessionKey: "agent",
          lastActiveSessionKey: "agent",
        },
      },
    });
    expect(sessionStorage.length).toBe(0);
  });

  it("loads the current-tab token from sessionStorage", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    saveSettings({
      gatewayUrl: gwUrl,
      token: "session-token",
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
      borderRadius: 50,
      textScale: 100,
    });

    const settings = loadSettings();
    expect(settings.gatewayUrl).toBe(gwUrl);
    expect(settings.token).toBe("session-token");
  });

  it("does not reuse a session token for a different gatewayUrl", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    const otherUrl = "wss://other-gateway.example:8443";
    saveSettings({
      gatewayUrl: gwUrl,
      token: "gateway-a-token",
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
      borderRadius: 50,
    });

    saveSettings({
      gatewayUrl: otherUrl,
      token: "",
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
      borderRadius: 50,
    });

    const settings = loadSettings();
    // The last-saved gateway URL is persisted through a page reload; the page
    // now points at otherUrl, not the earlier gwUrl.
    expect(settings.gatewayUrl).toBe(otherUrl);
    // The session token from gwUrl must not be transferred to otherUrl —
    // each gateway manages its own independent token.
    expect(settings.token).toBe("");
  });

  it("does not persist gateway tokens when saving settings", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    saveSettings({
      gatewayUrl: gwUrl,
      token: "memory-only-token",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
      borderRadius: 50,
    });
    const settings = loadSettings();
    expect(settings.gatewayUrl).toBe(gwUrl);
    expect(settings.token).toBe("memory-only-token");

    const scopedKey = `openclaw.control.settings.v1:${gwUrl}`;
    expect(JSON.parse(localStorage.getItem(scopedKey) ?? "{}")).toEqual({
      gatewayUrl: gwUrl,
      theme: "claw",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      chatPersistCommentary: false,
      chatAutoScroll: "near-bottom",
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
      recentSessionsCollapsed: false,
      borderRadius: 50,
      textScale: 100,
      sessionsByGateway: {
        [gwUrl]: {
          sessionKey: "main",
          lastActiveSessionKey: "main",
        },
      },
    });
    expect(sessionStorage.length).toBe(1);
  });

  it("persists recent sessions collapse state across save and load", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    saveSettings({
      gatewayUrl: gwUrl,
      token: "",
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
      recentSessionsCollapsed: true,
      borderRadius: 50,
      textScale: 100,
    });

    expect(loadSettings().recentSessionsCollapsed).toBe(true);

    saveSettings({
      gatewayUrl: gwUrl,
      token: "",
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
    });

    const scopedKey = `openclaw.control.settings.v1:${gwUrl}`;
    const persisted = JSON.parse(localStorage.getItem(scopedKey) ?? "{}") as Record<
      string,
      unknown
    >;
    expect(persisted.recentSessionsCollapsed).toBe(false);
    expect(loadSettings().recentSessionsCollapsed).toBe(false);
  });

  it("normalizes persisted text scale to the nearest supported stop", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    localStorage.setItem(
      `openclaw.control.settings.v1:${gwUrl}`,
      JSON.stringify({
        gatewayUrl: gwUrl,
        textScale: 123,
      }),
    );

    expect(loadSettings().textScale).toBe(125);
  });

  it("loads valid chat auto-scroll modes and normalizes invalid values", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    localStorage.setItem(
      `openclaw.control.settings.v1:${gwUrl}`,
      JSON.stringify({
        gatewayUrl: gwUrl,
        chatAutoScroll: "off",
      }),
    );
    expect(loadSettings().chatAutoScroll).toBe("off");

    localStorage.setItem(
      `openclaw.control.settings.v1:${gwUrl}`,
      JSON.stringify({
        gatewayUrl: gwUrl,
        chatAutoScroll: "disabled",
      }),
    );
    expect(loadSettings().chatAutoScroll).toBe("near-bottom");
  });

  it("clears the current-tab token when saving an empty token", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    saveSettings({
      gatewayUrl: gwUrl,
      token: "stale-token",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
      borderRadius: 50,
    });
    saveSettings({
      gatewayUrl: gwUrl,
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
      borderRadius: 50,
    });

    expect(loadSettings().token).toBe("");
    expect(sessionStorage.length).toBe(0);
  });

  it("persists themeMode and navWidth alongside the selected theme", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    saveSettings({
      gatewayUrl: gwUrl,
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "dash",
      themeMode: "light",
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 320,
      navGroupsCollapsed: {},
      borderRadius: 50,
    });

    const scopedKey = `openclaw.control.settings.v1:${gwUrl}`;
    const persisted = JSON.parse(localStorage.getItem(scopedKey) ?? "{}") as Record<
      string,
      unknown
    >;
    expect(persisted.theme).toBe("dash");
    expect(persisted.themeMode).toBe("light");
    expect(persisted.navWidth).toBe(320);
  });

  it("persists the browser-local custom theme payload when present", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    const customTheme = createImportedCustomThemeFixture();
    saveSettings({
      gatewayUrl: gwUrl,
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "custom",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
      borderRadius: 50,
      customTheme,
    });

    const settings = loadSettings();
    expect(settings.theme).toBe("custom");
    expect(settings.customTheme?.label).toBe("Light Green");
    expect(settings.customTheme?.themeId).toBe("cmlhfpjhw000004l4f4ax3m7z");
  });

  it("falls back to claw when persisted custom theme data is invalid", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    localStorage.setItem(
      `openclaw.control.settings.v1:${gwUrl}`,
      JSON.stringify({
        gatewayUrl: gwUrl,
        theme: "custom",
        themeMode: "dark",
        chatShowThinking: true,
        chatShowToolCalls: true,
        splitRatio: 0.6,
        navCollapsed: false,
        navWidth: 220,
        navGroupsCollapsed: {},
        borderRadius: 50,
        customTheme: {
          sourceUrl: "https://tweakcn.com/themes/broken",
          themeId: "broken",
          label: "Broken",
          importedAt: "2026-04-22T00:00:00.000Z",
          light: {},
          dark: {},
        },
        sessionsByGateway: {
          [gwUrl]: {
            sessionKey: "main",
            lastActiveSessionKey: "main",
          },
        },
      }),
    );

    const settings = loadSettings();
    expect(settings.theme).toBe("claw");
    expect(settings.themeMode).toBe("dark");
  });

  it("scopes persisted session selection per gateway", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway-a.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    saveSettings({
      gatewayUrl: gwUrl,
      token: "",
      sessionKey: "agent:test_old:main",
      lastActiveSessionKey: "agent:test_old:main",
      theme: "claw",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
      borderRadius: 50,
    });

    const settings = loadSettings();
    expect(settings.gatewayUrl).toBe(gwUrl);
    expect(settings.sessionKey).toBe("agent:test_old:main");
    expect(settings.lastActiveSessionKey).toBe("agent:test_old:main");
  });

  it("caps persisted session scopes to the most recent gateways", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    const scopedKey = `openclaw.control.settings.v1:wss://gateway.example:8443`;

    // Pre-seed sessionsByGateway with 11 stale gateway entries so the next
    // saveSettings call pushes the total to 12 and triggers the cap (10).
    const staleEntries: Record<string, { sessionKey: string; lastActiveSessionKey: string }> = {};
    for (let i = 0; i < 11; i += 1) {
      staleEntries[`wss://stale-${i}.example:8443`] = {
        sessionKey: `agent:stale_${i}:main`,
        lastActiveSessionKey: `agent:stale_${i}:main`,
      };
    }
    localStorage.setItem(scopedKey, JSON.stringify({ sessionsByGateway: staleEntries }));

    saveSettings({
      gatewayUrl: gwUrl,
      token: "",
      sessionKey: "agent:current:main",
      lastActiveSessionKey: "agent:current:main",
      theme: "claw",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
      borderRadius: 50,
    });

    const persisted = JSON.parse(localStorage.getItem(scopedKey) ?? "{}");

    const scopedSessions = persisted.sessionsByGateway as Record<
      string,
      { sessionKey: string; lastActiveSessionKey: string }
    >;
    expect(scopedSessions["wss://gateway.example:8443"]).toEqual({
      sessionKey: "agent:current:main",
      lastActiveSessionKey: "agent:current:main",
    });
    expect(Object.keys(scopedSessions)).toEqual([
      "wss://stale-2.example:8443",
      "wss://stale-3.example:8443",
      "wss://stale-4.example:8443",
      "wss://stale-5.example:8443",
      "wss://stale-6.example:8443",
      "wss://stale-7.example:8443",
      "wss://stale-8.example:8443",
      "wss://stale-9.example:8443",
      "wss://stale-10.example:8443",
      "wss://gateway.example:8443",
    ]);
  });

  it("does not adopt the gateway URL from a sibling gateway sharing the same origin", () => {
    // Reproduces issue #97636: two gateways under the same origin with different
    // basePaths must not share localStorage state through the legacy unscoped key.
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/gateway-b/chat",
    });

    // Simulate gateway-a having previously written to the legacy unscoped key.
    localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({
        gatewayUrl: "wss://gateway.example:8443/gateway-a",
        theme: "dash",
        sessionKey: "gw-a-session",
      }),
    );

    const settings = loadSettings();
    // Gateway B must use its own basePath-derived URL, not gateway A's.
    expect(settings.gatewayUrl).toBe(expectedGatewayUrl("/gateway-b"));
    expect(settings.theme).toBe("claw");
    expect(settings.sessionKey).toBe("main");
    expect(JSON.parse(localStorage.getItem("openclaw.control.settings.v1") ?? "{}")).toMatchObject({
      gatewayUrl: "wss://gateway.example:8443/gateway-a",
      sessionKey: "gw-a-session",
    });
    console.log(
      `[gateway-proof] same-origin legacy fallback rejected: stored=wss://gateway.example:8443/gateway-a loaded=${settings.gatewayUrl}`,
    );
  });

  it("does not adopt a legacy sibling gateway URL when the current page is root-mounted", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({
        gatewayUrl: "wss://gateway.example:8443/gateway-a",
        theme: "dash",
        sessionKey: "gw-a-session",
      }),
    );

    const settings = loadSettings();
    expect(settings.gatewayUrl).toBe(expectedGatewayUrl(""));
    expect(settings.theme).toBe("claw");
    expect(settings.sessionKey).toBe("main");
    expect(JSON.parse(localStorage.getItem("openclaw.control.settings.v1") ?? "{}")).toMatchObject({
      gatewayUrl: "wss://gateway.example:8443/gateway-a",
      sessionKey: "gw-a-session",
    });
    console.log(
      `[gateway-proof] root same-origin legacy fallback rejected: stored=wss://gateway.example:8443/gateway-a loaded=${settings.gatewayUrl}`,
    );
  });

  it("preserves a legacy custom remote gatewayUrl on first load after upgrade", () => {
    setTestLocation({
      protocol: "https:",
      host: "control.example:8443",
      pathname: "/",
    });

    // Pre-upgrade profiles only have the legacy unscoped key.  A custom remote
    // gateway URL should still be migrated even though its scope differs from
    // the page-derived Control UI URL.
    localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({
        gatewayUrl: "wss://remote-gateway.example.com",
        theme: "dash",
        themeMode: "dark",
        chatShowThinking: false,
        sessionKey: "remote-session",
        lastActiveSessionKey: "remote-session",
      }),
    );

    const settings = loadSettings();
    expect(settings.gatewayUrl).toBe("wss://remote-gateway.example.com");
    expect(settings.theme).toBe("dash");
    expect(settings.themeMode).toBe("dark");
    expect(settings.chatShowThinking).toBe(false);
    expect(settings.sessionKey).toBe("remote-session");
    console.log(
      `[gateway-proof] remote legacy fallback preserved: loaded=${settings.gatewayUrl} session=${settings.sessionKey}`,
    );
  });

  it("does not let stale unscoped remote settings override a valid current scoped record", () => {
    setTestLocation({
      protocol: "https:",
      host: "control.example:8443",
      pathname: "/",
    });

    localStorage.setItem(
      "openclaw.control.settings.v1:wss://control.example:8443",
      JSON.stringify({
        gatewayUrl: "wss://control.example:8443",
        theme: "claw",
        sessionKey: "stale-default",
      }),
    );
    localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({
        gatewayUrl: "wss://remote-gateway.example.com",
        theme: "dash",
        themeMode: "dark",
        chatShowThinking: false,
        sessionKey: "remote-session",
        lastActiveSessionKey: "remote-session",
      }),
    );

    const settings = loadSettings();
    expect(settings.gatewayUrl).toBe("wss://control.example:8443");
    expect(settings.theme).toBe("claw");
    expect(settings.sessionKey).toBe("stale-default");
    expect(
      localStorage.getItem("openclaw.control.currentGateway.v1:wss://control.example:8443"),
    ).toBeNull();
  });

  it("does not let invalid legacy settings mask a valid current scoped record", () => {
    setTestLocation({
      protocol: "https:",
      host: "control.example:8443",
      pathname: "/",
    });

    localStorage.setItem(
      "openclaw.control.settings.v1:wss://control.example:8443",
      JSON.stringify({
        gatewayUrl: "wss://control.example:8443",
        theme: "dash",
        themeMode: "dark",
        sessionKey: "current-session",
        lastActiveSessionKey: "current-session",
      }),
    );
    localStorage.setItem("openclaw.control.settings.v1", "{}");

    const settings = loadSettings();
    expect(settings.gatewayUrl).toBe("wss://control.example:8443");
    expect(settings.theme).toBe("dash");
    expect(settings.sessionKey).toBe("current-session");
  });

  it("does not adopt a sibling gateway from the default fallback key", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/gateway-b/chat",
    });

    localStorage.setItem(
      "openclaw.control.settings.v1:default",
      JSON.stringify({
        gatewayUrl: "wss://gateway.example:8443/gateway-a",
        theme: "dash",
        sessionKey: "gw-a-session",
      }),
    );

    const settings = loadSettings();
    expect(settings.gatewayUrl).toBe(expectedGatewayUrl("/gateway-b"));
    expect(settings.theme).toBe("claw");
    expect(settings.sessionKey).toBe("main");
  });

  it("uses the default fallback key when the unscoped legacy key belongs to a sibling", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/gateway-b/chat",
    });

    localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({
        gatewayUrl: "wss://gateway.example:8443/gateway-a",
        theme: "dash",
        sessionKey: "gw-a-session",
      }),
    );
    localStorage.setItem(
      "openclaw.control.settings.v1:default",
      JSON.stringify({
        gatewayUrl: "wss://gateway.example:8443/gateway-b",
        theme: "dash",
        sessionKey: "gw-b-default",
      }),
    );

    const settings = loadSettings();
    expect(settings.gatewayUrl).toBe(expectedGatewayUrl("/gateway-b"));
    expect(settings.theme).toBe("dash");
    expect(settings.sessionKey).toBe("gw-b-default");
  });

  it("uses the default fallback key when the unscoped legacy key is corrupt", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    localStorage.setItem("openclaw.control.settings.v1", "{");
    localStorage.setItem(
      "openclaw.control.settings.v1:default",
      JSON.stringify({
        gatewayUrl: "wss://gateway.example:8443",
        theme: "dash",
        sessionKey: "default-session",
      }),
    );

    const settings = loadSettings();
    expect(settings.gatewayUrl).toBe(expectedGatewayUrl(""));
    expect(settings.theme).toBe("dash");
    expect(settings.sessionKey).toBe("default-session");
  });

  it("preserves a legacy same-origin root WebSocket endpoint on first load after upgrade", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/openclaw/chat",
    });

    localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({
        gatewayUrl: "/ws",
        theme: "dash",
        themeMode: "dark",
        sessionKey: "custom-ws-session",
        lastActiveSessionKey: "custom-ws-session",
      }),
    );

    const settings = loadSettings();
    expect(settings.gatewayUrl).toBe("/ws");
    expect(settings.theme).toBe("dash");
    expect(settings.themeMode).toBe("dark");
    expect(settings.sessionKey).toBe("custom-ws-session");
    expect(
      JSON.parse(
        localStorage.getItem("openclaw.control.settings.v1:https://gateway.example:8443/ws") ??
          "{}",
      ),
    ).toMatchObject({
      gatewayUrl: "/ws",
      theme: "dash",
      themeMode: "dark",
    });
    expect(
      localStorage.getItem(
        "openclaw.control.currentGateway.v1:wss://gateway.example:8443/openclaw",
      ),
    ).toBe("/ws");
    expect(
      localStorage.getItem("openclaw.control.settings.v1:wss://gateway.example:8443/openclaw"),
    ).toBeNull();
    expect(localStorage.getItem("openclaw.control.settings.v1")).toBeNull();
    console.log(
      `[gateway-proof] same-origin root websocket endpoint preserved: loaded=${settings.gatewayUrl} session=${settings.sessionKey}`,
    );
  });

  it("does not preserve legacy sibling base-path WebSocket endpoint URLs", () => {
    for (const legacyGatewayUrl of ["/gateway-a/ws", "wss://gateway.example:8443/gateway-a/ws"]) {
      localStorage.clear();
      sessionStorage.clear();
      setTestLocation({
        protocol: "https:",
        host: "gateway.example:8443",
        pathname: "/gateway-b/chat",
      });
      localStorage.setItem(
        "openclaw.control.settings.v1",
        JSON.stringify({
          gatewayUrl: legacyGatewayUrl,
          theme: "dash",
          sessionKey: "gw-a-session",
          lastActiveSessionKey: "gw-a-session",
        }),
      );

      const settings = loadSettings();
      expect(settings.gatewayUrl).toBe(expectedGatewayUrl("/gateway-b"));
      expect(settings.theme).toBe("claw");
      expect(settings.sessionKey).toBe("main");
      expect(
        JSON.parse(localStorage.getItem("openclaw.control.settings.v1") ?? "{}"),
      ).toMatchObject({
        gatewayUrl: legacyGatewayUrl,
        sessionKey: "gw-a-session",
      });
      console.log(
        `[gateway-proof] sibling websocket endpoint rejected: stored=${legacyGatewayUrl} loaded=${settings.gatewayUrl}`,
      );
    }
  });

  it("preserves legacy current-base WebSocket endpoint URLs", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/gateway-b/chat",
    });
    localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({
        gatewayUrl: "wss://gateway.example:8443/gateway-b/ws",
        theme: "dash",
        themeMode: "dark",
        sessionKey: "gw-b-ws-session",
        lastActiveSessionKey: "gw-b-ws-session",
      }),
    );

    const settings = loadSettings();
    expect(settings.gatewayUrl).toBe("wss://gateway.example:8443/gateway-b/ws");
    expect(settings.theme).toBe("dash");
    expect(settings.themeMode).toBe("dark");
    expect(settings.sessionKey).toBe("gw-b-ws-session");
    expect(
      localStorage.getItem(
        "openclaw.control.currentGateway.v1:wss://gateway.example:8443/gateway-b",
      ),
    ).toBe("wss://gateway.example:8443/gateway-b/ws");
    expect(localStorage.getItem("openclaw.control.settings.v1")).toBeNull();
  });

  it("does not write to the legacy unscoped settings key when saving", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    saveSettings({
      gatewayUrl: gwUrl,
      token: "",
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
    });

    // The unscoped legacy key must remain absent so it cannot contaminate
    // sibling gateways on the same origin.
    expect(localStorage.getItem("openclaw.control.settings.v1")).toBeNull();
  });

  it("persists local user identity separately from gateway settings", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    saveLocalUserIdentity({ name: "Buns", avatar: "🦞" });

    expect(loadLocalUserIdentity()).toEqual({
      name: "Buns",
      avatar: "🦞",
    });
    expect(JSON.parse(localStorage.getItem("openclaw.control.user.v1") ?? "{}")).toEqual({
      name: "Buns",
      avatar: "🦞",
    });
  });

  it("normalizes invalid local user identity values on load", () => {
    localStorage.setItem(
      "openclaw.control.user.v1",
      JSON.stringify({
        name: "  ",
        avatar: "https://example.com/avatar.png",
      }),
    );

    expect(loadLocalUserIdentity()).toEqual({
      name: null,
      avatar: null,
    });
  });

  it("removes the persisted local user identity when cleared", () => {
    saveLocalUserIdentity({ name: "Buns", avatar: "data:image/png;base64,AAA" });
    saveLocalUserIdentity({ name: null, avatar: null });

    expect(loadLocalUserIdentity()).toEqual({
      name: null,
      avatar: null,
    });
    expect(localStorage.getItem("openclaw.control.user.v1")).toBeNull();
  });

  it("persists a custom remote gatewayUrl so it survives a page reload", () => {
    // Regression for #97636: when the user overrides the gateway URL to a
    // remote host, the settings payload is scoped to that remote URL. The
    // page-scoped selection points this Control UI basePath back to the remote
    // payload on reload without sharing a payload key with sibling basePaths.
    setTestLocation({
      protocol: "https:",
      host: "control.example:8443",
      pathname: "/",
    });
    localStorage.setItem(
      "openclaw.control.settings.v1:wss://control.example:8443",
      JSON.stringify({
        gatewayUrl: "wss://control.example:8443",
        theme: "claw",
        themeMode: "system",
        sessionKey: "default-session",
        lastActiveSessionKey: "default-session",
      }),
    );

    const customUrl = "wss://remote-gateway.example.com";
    saveSettings({
      gatewayUrl: customUrl,
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "dash",
      themeMode: "dark",
      chatShowThinking: false,
      chatShowToolCalls: true,
      chatAutoScroll: "off",
      splitRatio: 0.5,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
      borderRadius: 25,
      textScale: 110,
    });

    // Simulate a page reload: loadSettings follows the page-derived selection.
    const settings = loadSettings();
    expect(settings.gatewayUrl).toBe(customUrl);
    expect(settings.theme).toBe("dash");
    expect(settings.themeMode).toBe("dark");
    expect(settings.chatShowThinking).toBe(false);
    expect(settings.chatAutoScroll).toBe("off");
    expect(settings.splitRatio).toBe(0.5);
    expect(
      localStorage.getItem("openclaw.control.currentGateway.v1:wss://control.example:8443"),
    ).toBe(customUrl);
    expect(
      JSON.parse(
        localStorage.getItem("openclaw.control.settings.v1:wss://control.example:8443") ?? "{}",
      ),
    ).toMatchObject({
      gatewayUrl: "wss://control.example:8443",
      theme: "claw",
      sessionKey: "default-session",
    });
  });

  it("prefers the page-scoped dev-server gateway override over stale default settings", () => {
    setTestLocation({
      protocol: "http:",
      host: "127.0.0.1:5173",
      pathname: "/openclaw/chat",
    });
    setViteDevPage();

    localStorage.setItem(
      "openclaw.control.settings.v1:ws://127.0.0.1:18789",
      JSON.stringify({
        gatewayUrl: "ws://127.0.0.1:18789",
        theme: "claw",
        sessionKey: "stale-default",
      }),
    );

    const customUrl = "wss://remote-gateway.example.com";
    saveSettings({
      gatewayUrl: customUrl,
      token: "",
      sessionKey: "remote-session",
      lastActiveSessionKey: "remote-session",
      theme: "dash",
      themeMode: "dark",
      chatShowThinking: false,
      chatShowToolCalls: true,
      chatAutoScroll: "off",
      splitRatio: 0.5,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
      borderRadius: 25,
      textScale: 110,
    });

    const settings = loadSettings();
    expect(settings.gatewayUrl).toBe(customUrl);
    expect(settings.sessionKey).toBe("remote-session");
    expect(settings.theme).toBe("dash");
    expect(settings.chatAutoScroll).toBe("off");
  });

  it("keeps remote gateway payload when the page selection switches back to the default gateway", () => {
    setTestLocation({
      protocol: "https:",
      host: "control.example:8443",
      pathname: "/",
    });

    const remoteUrl = "wss://remote-gateway.example.com";
    saveSettings({
      gatewayUrl: remoteUrl,
      token: "",
      sessionKey: "remote-session",
      lastActiveSessionKey: "remote-session",
      theme: "dash",
      themeMode: "dark",
      chatShowThinking: false,
      chatShowToolCalls: true,
      chatAutoScroll: "off",
      splitRatio: 0.5,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
      borderRadius: 25,
      textScale: 110,
    });

    const defaultUrl = "wss://control.example:8443";
    saveSettings({
      gatewayUrl: defaultUrl,
      token: "",
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
      borderRadius: 50,
      textScale: 100,
    });

    expect(
      JSON.parse(
        localStorage.getItem("openclaw.control.settings.v1:wss://remote-gateway.example.com") ??
          "{}",
      ),
    ).toMatchObject({
      gatewayUrl: remoteUrl,
      theme: "dash",
      sessionsByGateway: {
        "wss://remote-gateway.example.com": {
          sessionKey: "remote-session",
          lastActiveSessionKey: "remote-session",
        },
      },
    });
    expect(
      localStorage.getItem("openclaw.control.currentGateway.v1:wss://control.example:8443"),
    ).toBe(defaultUrl);
    expect(loadSettings().gatewayUrl).toBe(defaultUrl);
  });

  it("keeps per-basePath settings isolated when sibling gateways have distinct configurations", () => {
    // Regression scenario for #97636: two gateways sharing an origin but
    // serving different basePaths must maintain fully independent settings.
    // Gateway-a represents a deployment with managed-provider warnings
    // dismissed (theme=dash, chatShowThinking=false) while gateway-b represents
    // a native-search-active deployment with default UI settings (theme=claw,
    // chatShowThinking=true).  Neither gateway must bleed its state into the
    // other on reload.

    // --- Save gateway-a settings ---
    setTestLocation({
      protocol: "https:",
      host: "multi.example:8443",
      pathname: "/gateway-a/chat",
    });
    saveSettings({
      gatewayUrl: "wss://multi.example:8443/gateway-a",
      token: "",
      sessionKey: "managed-session",
      lastActiveSessionKey: "managed-session",
      theme: "dash",
      themeMode: "light",
      chatShowThinking: false,
      chatShowToolCalls: false,
      chatAutoScroll: "off",
      splitRatio: 0.65,
      navCollapsed: true,
      navWidth: 220,
      navGroupsCollapsed: {},
      borderRadius: 0,
      textScale: 100,
    });

    // --- Save gateway-b settings ---
    setTestLocation({
      protocol: "https:",
      host: "multi.example:8443",
      pathname: "/gateway-b/chat",
    });
    saveSettings({
      gatewayUrl: "wss://multi.example:8443/gateway-b",
      token: "",
      sessionKey: "native-session",
      lastActiveSessionKey: "native-session",
      theme: "claw",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      chatAutoScroll: "near-bottom",
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 300,
      navGroupsCollapsed: {},
      borderRadius: 50,
      textScale: 100,
    });

    // --- Reload as gateway-a: must see its own isolated settings ---
    setTestLocation({
      protocol: "https:",
      host: "multi.example:8443",
      pathname: "/gateway-a/chat",
    });
    const settingsA = loadSettings();
    expect(settingsA.gatewayUrl).toBe("wss://multi.example:8443/gateway-a");
    expect(settingsA.theme).toBe("dash");
    expect(settingsA.chatShowThinking).toBe(false);
    expect(settingsA.chatShowToolCalls).toBe(false);
    expect(settingsA.chatAutoScroll).toBe("off");
    expect(settingsA.navCollapsed).toBe(true);

    // --- Reload as gateway-b: must see its own settings, not gateway-a's ---
    setTestLocation({
      protocol: "https:",
      host: "multi.example:8443",
      pathname: "/gateway-b/chat",
    });
    const settingsB = loadSettings();
    expect(settingsB.gatewayUrl).toBe("wss://multi.example:8443/gateway-b");
    expect(settingsB.theme).toBe("claw");
    expect(settingsB.chatShowThinking).toBe(true);
    expect(settingsB.chatShowToolCalls).toBe(true);
    expect(settingsB.chatAutoScroll).toBe("near-bottom");
    expect(settingsB.navCollapsed).toBe(false);
    expect(settingsB.navWidth).toBe(300);
    console.log(
      `[gateway-proof] same-origin isolation: basePath A=/gateway-a -> ${settingsA.gatewayUrl}, basePath B=/gateway-b -> ${settingsB.gatewayUrl}`,
    );
  });
});
