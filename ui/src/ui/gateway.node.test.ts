import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDeviceAuthToken, storeDeviceAuthToken } from "./device-auth.ts";
import type { DeviceIdentity } from "./device-identity.ts";

const wsInstances = vi.hoisted((): MockWebSocket[] => []);
const loadOrCreateDeviceIdentityMock = vi.hoisted(() =>
  vi.fn(
    async (): Promise<DeviceIdentity> => ({
      deviceId: "device-1",
      privateKey: "private-key", // pragma: allowlist secret
      publicKey: "public-key", // pragma: allowlist secret
    }),
  ),
);
const signDevicePayloadMock = vi.hoisted(() =>
  vi.fn(async (_privateKeyBase64Url: string, _payload: string) => "signature"),
);

type HandlerMap = {
  close: MockWebSocketHandler[];
  error: MockWebSocketHandler[];
  message: MockWebSocketHandler[];
  open: MockWebSocketHandler[];
};

type MockWebSocketHandler = (ev?: { code?: number; data?: string; reason?: string }) => void;

class MockWebSocket {
  static OPEN = 1;

  readonly handlers: HandlerMap = {
    close: [],
    error: [],
    message: [],
    open: [],
  };

  readonly sent: string[] = [];
  readyState = MockWebSocket.OPEN;

  constructor(_url: string) {
    wsInstances.push(this);
  }

  addEventListener(type: keyof HandlerMap, handler: MockWebSocketHandler) {
    this.handlers[type].push(handler);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  emitClose(code = 1000, reason = "") {
    for (const handler of this.handlers.close) {
      handler({ code, reason });
    }
  }

  emitOpen() {
    for (const handler of this.handlers.open) {
      handler();
    }
  }

  emitMessage(data: unknown) {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    for (const handler of this.handlers.message) {
      handler({ data: payload });
    }
  }
}

vi.mock("./device-identity.ts", () => ({
  loadOrCreateDeviceIdentity: loadOrCreateDeviceIdentityMock,
  signDevicePayload: signDevicePayloadMock,
}));

const { GatewayBrowserClient } = await import("./gateway.ts");

function getLatestWebSocket(): MockWebSocket {
  const ws = wsInstances.at(-1);
  if (!ws) {
    throw new Error("missing websocket instance");
  }
  return ws;
}

describe("GatewayBrowserClient", () => {
  beforeEach(() => {
    wsInstances.length = 0;
    loadOrCreateDeviceIdentityMock.mockReset();
    signDevicePayloadMock.mockClear();
    loadOrCreateDeviceIdentityMock.mockResolvedValue({
      deviceId: "device-1",
      privateKey: "private-key", // pragma: allowlist secret
      publicKey: "public-key", // pragma: allowlist secret
    });

    window.localStorage.clear();
    vi.stubGlobal("WebSocket", MockWebSocket);

    storeDeviceAuthToken({
      deviceId: "device-1",
      role: "operator",
      token: "stored-device-token",
      scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("prefers explicit shared auth over cached device tokens", async () => {
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
    });

    client.start();
    const ws = getLatestWebSocket();
    ws.emitOpen();
    ws.emitMessage({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-1" },
    });
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));

    const connectFrame = JSON.parse(ws.sent.at(-1) ?? "{}") as {
      id?: string;
      method?: string;
      params?: { auth?: { token?: string } };
    };
    expect(typeof connectFrame.id).toBe("string");
    expect(connectFrame.method).toBe("connect");
    expect(connectFrame.params?.auth?.token).toBe("shared-auth-token");
    expect(signDevicePayloadMock).toHaveBeenCalledWith("private-key", expect.any(String));
    const signedPayload = signDevicePayloadMock.mock.calls[0]?.[1];
    expect(signedPayload).toContain("|shared-auth-token|nonce-1");
    expect(signedPayload).not.toContain("stored-device-token");
  });

  it("uses cached device tokens only when no explicit shared auth is provided", async () => {
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
    });

    client.start();
    const ws = getLatestWebSocket();
    ws.emitOpen();
    ws.emitMessage({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-1" },
    });
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));

    const connectFrame = JSON.parse(ws.sent.at(-1) ?? "{}") as {
      id?: string;
      method?: string;
      params?: { auth?: { token?: string } };
    };
    expect(typeof connectFrame.id).toBe("string");
    expect(connectFrame.method).toBe("connect");
    expect(connectFrame.params?.auth?.token).toBe("stored-device-token");
    expect(signDevicePayloadMock).toHaveBeenCalledWith("private-key", expect.any(String));
    const signedPayload = signDevicePayloadMock.mock.calls[0]?.[1];
    expect(signedPayload).toContain("|stored-device-token|nonce-1");
  });

  it("retries once with device token after token mismatch when shared token is explicit", async () => {
    vi.useFakeTimers();
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
    });

    client.start();
    const ws1 = getLatestWebSocket();
    ws1.emitOpen();
    ws1.emitMessage({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-1" },
    });
    await vi.waitFor(() => expect(ws1.sent.length).toBeGreaterThan(0));
    const firstConnect = JSON.parse(ws1.sent.at(-1) ?? "{}") as {
      id: string;
      params?: { auth?: { token?: string; deviceToken?: string } };
    };
    expect(firstConnect.params?.auth?.token).toBe("shared-auth-token");
    expect(firstConnect.params?.auth?.deviceToken).toBeUndefined();

    ws1.emitMessage({
      type: "res",
      id: firstConnect.id,
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "unauthorized",
        details: { code: "AUTH_TOKEN_MISMATCH", canRetryWithDeviceToken: true },
      },
    });
    await vi.waitFor(() => expect(ws1.readyState).toBe(3));
    ws1.emitClose(4008, "connect failed");

    await vi.advanceTimersByTimeAsync(800);
    const ws2 = getLatestWebSocket();
    expect(ws2).not.toBe(ws1);
    ws2.emitOpen();
    ws2.emitMessage({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-2" },
    });
    await vi.waitFor(() => expect(ws2.sent.length).toBeGreaterThan(0));
    const secondConnect = JSON.parse(ws2.sent.at(-1) ?? "{}") as {
      id: string;
      params?: { auth?: { token?: string; deviceToken?: string } };
    };
    expect(secondConnect.params?.auth?.token).toBe("shared-auth-token");
    expect(secondConnect.params?.auth?.deviceToken).toBe("stored-device-token");

    ws2.emitMessage({
      type: "res",
      id: secondConnect.id,
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "unauthorized",
        details: { code: "AUTH_TOKEN_MISMATCH" },
      },
    });
    await vi.waitFor(() => expect(ws2.readyState).toBe(3));
    ws2.emitClose(4008, "connect failed");
    expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator" })?.token).toBe(
      "stored-device-token",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(wsInstances).toHaveLength(2);

    vi.useRealTimers();
  });

  it("treats IPv6 loopback as trusted for bounded device-token retry", async () => {
    vi.useFakeTimers();
    const client = new GatewayBrowserClient({
      url: "ws://[::1]:18789",
      token: "shared-auth-token",
    });

    client.start();
    const ws1 = getLatestWebSocket();
    ws1.emitOpen();
    ws1.emitMessage({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-1" },
    });
    await vi.waitFor(() => expect(ws1.sent.length).toBeGreaterThan(0));
    const firstConnect = JSON.parse(ws1.sent.at(-1) ?? "{}") as {
      id: string;
      params?: { auth?: { token?: string; deviceToken?: string } };
    };
    expect(firstConnect.params?.auth?.token).toBe("shared-auth-token");
    expect(firstConnect.params?.auth?.deviceToken).toBeUndefined();

    ws1.emitMessage({
      type: "res",
      id: firstConnect.id,
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "unauthorized",
        details: { code: "AUTH_TOKEN_MISMATCH", canRetryWithDeviceToken: true },
      },
    });
    await vi.waitFor(() => expect(ws1.readyState).toBe(3));
    ws1.emitClose(4008, "connect failed");

    await vi.advanceTimersByTimeAsync(800);
    const ws2 = getLatestWebSocket();
    expect(ws2).not.toBe(ws1);
    ws2.emitOpen();
    ws2.emitMessage({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-2" },
    });
    await vi.waitFor(() => expect(ws2.sent.length).toBeGreaterThan(0));
    const secondConnect = JSON.parse(ws2.sent.at(-1) ?? "{}") as {
      params?: { auth?: { token?: string; deviceToken?: string } };
    };
    expect(secondConnect.params?.auth?.token).toBe("shared-auth-token");
    expect(secondConnect.params?.auth?.deviceToken).toBe("stored-device-token");

    client.stop();
    vi.useRealTimers();
  });

  it("continues reconnecting on first token mismatch when no retry was attempted", async () => {
    vi.useFakeTimers();
    window.localStorage.clear();

    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
    });

    client.start();
    const ws1 = getLatestWebSocket();
    ws1.emitOpen();
    ws1.emitMessage({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-1" },
    });
    await vi.waitFor(() => expect(ws1.sent.length).toBeGreaterThan(0));
    const firstConnect = JSON.parse(ws1.sent.at(-1) ?? "{}") as { id: string };

    ws1.emitMessage({
      type: "res",
      id: firstConnect.id,
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "unauthorized",
        details: { code: "AUTH_TOKEN_MISMATCH" },
      },
    });
    await vi.waitFor(() => expect(ws1.readyState).toBe(3));
    ws1.emitClose(4008, "connect failed");

    await vi.advanceTimersByTimeAsync(800);
    expect(wsInstances).toHaveLength(2);

    client.stop();
    vi.useRealTimers();
  });

  it("does not auto-reconnect on AUTH_TOKEN_MISSING", async () => {
    vi.useFakeTimers();
    window.localStorage.clear();

    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
    });

    client.start();
    const ws1 = getLatestWebSocket();
    ws1.emitOpen();
    ws1.emitMessage({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-1" },
    });
    await vi.waitFor(() => expect(ws1.sent.length).toBeGreaterThan(0));
    const connect = JSON.parse(ws1.sent.at(-1) ?? "{}") as { id: string };

    ws1.emitMessage({
      type: "res",
      id: connect.id,
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "unauthorized",
        details: { code: "AUTH_TOKEN_MISSING" },
      },
    });
    await vi.waitFor(() => expect(ws1.readyState).toBe(3));
    ws1.emitClose(4008, "connect failed");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(wsInstances).toHaveLength(1);

    vi.useRealTimers();
  });
});
