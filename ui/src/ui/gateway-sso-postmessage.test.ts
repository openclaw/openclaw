// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./app-settings.ts", () => ({
  applySettings: vi.fn((host: { settings: unknown }, next: unknown) => {
    host.settings = next;
  }),
}));

import {
  applyGatewayTokenFromSso,
  GATEWAY_SSO_POST_MESSAGE_ACK,
  GATEWAY_SSO_POST_MESSAGE_TYPE,
  installGatewaySsoPostMessageListener,
  isAllowedGatewaySsoParentOrigin,
} from "./gateway-sso-postmessage.ts";
import type { UiSettings } from "./storage.ts";

function createSettings(): UiSettings {
  return {
    gatewayUrl: "wss://demo.clusterclaw.ai/openclaw",
    token: "",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "claw",
    themeMode: "system",
    borderRadius: 50,
  };
}

describe("isAllowedGatewaySsoParentOrigin", () => {
  it("allows clusterclaw admin origins and localhost dev", () => {
    expect(isAllowedGatewaySsoParentOrigin("https://www.clusterclaw.ai")).toBe(true);
    expect(isAllowedGatewaySsoParentOrigin("https://preview.clusterclaw.ai")).toBe(true);
    expect(isAllowedGatewaySsoParentOrigin("http://localhost:3000")).toBe(true);
    expect(isAllowedGatewaySsoParentOrigin("http://127.0.0.1:3000")).toBe(true);
  });

  it("rejects untrusted origins", () => {
    expect(isAllowedGatewaySsoParentOrigin("https://evil.example")).toBe(false);
    expect(isAllowedGatewaySsoParentOrigin("javascript:alert(1)")).toBe(false);
  });
});

describe("applyGatewayTokenFromSso", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    vi.stubGlobal("document", {
      documentElement: { style: { setProperty: vi.fn() }, dataset: {} },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies token and resets session to main", () => {
    const host = {
      settings: createSettings(),
      sessionKey: "agent:old:main",
    };
    expect(applyGatewayTokenFromSso(host, "secret-token")).toBe("applied");
    expect(host.settings.token).toBe("secret-token");
    expect(host.sessionKey).toBe("main");
  });

  it("returns unchanged when token already applied", () => {
    const host = {
      settings: { ...createSettings(), token: "same" },
      sessionKey: "main",
    };
    expect(applyGatewayTokenFromSso(host, "same")).toBe("unchanged");
  });
});

describe("installGatewaySsoPostMessageListener", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    vi.stubGlobal("document", {
      documentElement: { style: { setProperty: vi.fn() }, dataset: {} },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("acks trusted parent postMessage and applies token", () => {
    const host = {
      settings: createSettings(),
      sessionKey: "main",
      connected: false,
    };
    const reconnect = vi.fn();
    const cleanup = installGatewaySsoPostMessageListener(host, { reconnect });
    const postMessage = vi.fn();
    const event = new MessageEvent("message", {
      origin: "https://www.clusterclaw.ai",
      data: { type: GATEWAY_SSO_POST_MESSAGE_TYPE, token: "handoff-token", v: 1 },
      source: { postMessage } as unknown as Window,
    });

    window.dispatchEvent(event);

    expect(host.settings.token).toBe("handoff-token");
    expect(reconnect).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      { type: GATEWAY_SSO_POST_MESSAGE_ACK, v: 1 },
      "https://www.clusterclaw.ai",
    );
    cleanup();
  });

  it("reconnects when token changes after an existing connection", () => {
    const host = {
      settings: createSettings(),
      sessionKey: "main",
      connected: true,
    };
    const reconnect = vi.fn();
    const cleanup = installGatewaySsoPostMessageListener(host, { reconnect });
    const postMessage = vi.fn();
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://preview.clusterclaw.ai",
        data: { type: GATEWAY_SSO_POST_MESSAGE_TYPE, token: "fresh-token", v: 1 },
        source: { postMessage } as unknown as Window,
      }),
    );

    expect(reconnect).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("ignores messages from disallowed origins", () => {
    const host = {
      settings: createSettings(),
      sessionKey: "main",
      connected: false,
    };
    const cleanup = installGatewaySsoPostMessageListener(host);
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://evil.example",
        data: { type: GATEWAY_SSO_POST_MESSAGE_TYPE, token: "nope", v: 1 },
        source: { postMessage: vi.fn() } as unknown as Window,
      }),
    );
    expect(host.settings.token).toBe("");
    cleanup();
  });
});
