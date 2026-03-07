import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wsInstances = vi.hoisted((): MockWebSocket[] => []);
const buildDeviceAuthPayloadMock = vi.hoisted(() => vi.fn(() => "signed-payload"));
const clearDeviceAuthTokenMock = vi.hoisted(() => vi.fn());
const loadDeviceAuthTokenMock = vi.hoisted(() => vi.fn());
const storeDeviceAuthTokenMock = vi.hoisted(() => vi.fn());
const loadOrCreateDeviceIdentityMock = vi.hoisted(() => vi.fn());
const signDevicePayloadMock = vi.hoisted(() => vi.fn(async () => "signature"));
const generateUUIDMock = vi.hoisted(() => vi.fn(() => "req-1"));

type HandlerMap = {
  close: ((ev: { code: number; reason: string }) => void)[];
  error: (() => void)[];
  message: ((ev: { data: string }) => void)[];
  open: (() => void)[];
};

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

  addEventListener<K extends keyof HandlerMap>(type: K, handler: HandlerMap[K][number]) {
    this.handlers[type].push(handler);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
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

vi.mock("../../../src/gateway/device-auth.js", () => ({
  buildDeviceAuthPayload: (...args: unknown[]) => buildDeviceAuthPayloadMock(...args),
}));

vi.mock("./device-auth.ts", () => ({
  clearDeviceAuthToken: (...args: unknown[]) => clearDeviceAuthTokenMock(...args),
  loadDeviceAuthToken: (...args: unknown[]) => loadDeviceAuthTokenMock(...args),
  storeDeviceAuthToken: (...args: unknown[]) => storeDeviceAuthTokenMock(...args),
}));

vi.mock("./device-identity.ts", () => ({
  loadOrCreateDeviceIdentity: (...args: unknown[]) => loadOrCreateDeviceIdentityMock(...args),
  signDevicePayload: (...args: unknown[]) => signDevicePayloadMock(...args),
}));

vi.mock("./uuid.ts", () => ({
  generateUUID: (...args: unknown[]) => generateUUIDMock(...args),
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
    buildDeviceAuthPayloadMock.mockClear();
    clearDeviceAuthTokenMock.mockClear();
    loadDeviceAuthTokenMock.mockReset();
    storeDeviceAuthTokenMock.mockClear();
    loadOrCreateDeviceIdentityMock.mockReset();
    signDevicePayloadMock.mockClear();
    generateUUIDMock.mockClear();

    loadDeviceAuthTokenMock.mockReturnValue({ token: "stored-device-token" });
    loadOrCreateDeviceIdentityMock.mockResolvedValue({
      deviceId: "device-1",
      privateKey: "private-key",
      publicKey: "public-key",
    });

    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("crypto", { subtle: {} });
    vi.stubGlobal("navigator", {
      language: "en-GB",
      platform: "test-platform",
      userAgent: "test-agent",
    });
    vi.stubGlobal("window", {
      clearTimeout: vi.fn(),
      setTimeout: vi.fn(() => 1),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps shared auth token separate from cached device token", async () => {
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
    await Promise.resolve();

    const connectFrame = JSON.parse(ws.sent.at(-1) ?? "{}") as {
      method?: string;
      params?: { auth?: { token?: string } };
    };
    expect(connectFrame.method).toBe("connect");
    expect(connectFrame.params?.auth?.token).toBe("shared-auth-token");
    expect(buildDeviceAuthPayloadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "stored-device-token",
      }),
    );
  });
});
