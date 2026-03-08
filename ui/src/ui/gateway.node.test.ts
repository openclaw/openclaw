import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayBrowserClient } from "./gateway.ts";

vi.mock("./device-auth.ts", () => ({
  clearDeviceAuthToken: vi.fn(),
  loadDeviceAuthToken: vi.fn(() => null),
  storeDeviceAuthToken: vi.fn(),
}));

vi.mock("./device-identity.ts", () => ({
  loadOrCreateDeviceIdentity: vi.fn(async () => ({
    deviceId: "device-1",
    publicKey: "public-key",
    privateKey: "private-key",
  })),
  signDevicePayload: vi.fn(async () => "signature-1"),
}));

vi.mock("./uuid.ts", () => {
  let counter = 0;
  return {
    generateUUID: vi.fn(() => {
      counter += 1;
      return `req-${counter}`;
    }),
  };
});

type MockListener = (event: unknown) => void;

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly sent: string[] = [];
  readonly listeners = new Map<string, MockListener[]>();
  readyState = MockWebSocket.CONNECTING;

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: MockListener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code, reason });
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open", {});
  }

  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  static reset() {
    MockWebSocket.instances = [];
  }
}

type GatewayClientInternals = GatewayBrowserClient & {
  connectNonce: string | null;
  connectTimer: number | null;
  sendConnect: () => Promise<void>;
};

function parseSentFrame(socket: MockWebSocket) {
  const raw = socket.sent.at(-1);
  expect(raw).toBeDefined();
  return JSON.parse(raw ?? "{}") as {
    method?: string;
    params?: {
      auth?: Record<string, unknown>;
      device?: { nonce?: string };
    };
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("GatewayBrowserClient", () => {
  beforeEach(() => {
    MockWebSocket.reset();
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("omits device auth when connect runs without a nonce", async () => {
    const client = new GatewayBrowserClient({ token: "shared-token", url: "ws://gateway.test" });
    client.start();

    const socket = MockWebSocket.instances[0];
    expect(socket).toBeDefined();
    socket.open();

    const internals = client as GatewayClientInternals;
    await internals.sendConnect();
    await flushMicrotasks();

    const frame = parseSentFrame(socket);
    expect(frame.method).toBe("connect");
    expect(frame.params?.auth).toEqual({ token: "shared-token" });
    expect(frame.params?.device).toBeUndefined();
  });

  it("waits for connect challenge before sending in secure contexts", async () => {
    const client = new GatewayBrowserClient({ token: "shared-token", url: "ws://gateway.test" });
    client.start();

    const socket = MockWebSocket.instances[0];
    expect(socket).toBeDefined();
    socket.open();

    vi.advanceTimersByTime(750);
    await flushMicrotasks();
    expect(socket.sent).toHaveLength(0);

    socket.emit("message", {
      data: JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "nonce-1" },
      }),
    });
    await flushMicrotasks();

    const frame = parseSentFrame(socket);
    expect(frame.method).toBe("connect");
    expect(frame.params?.device?.nonce).toBe("nonce-1");
  });

  it("clears the pending timer when the challenge arrives", async () => {
    const client = new GatewayBrowserClient({ token: "shared-token", url: "ws://gateway.test" });
    client.start();

    const socket = MockWebSocket.instances[0];
    expect(socket).toBeDefined();
    socket.open();

    const internals = client as GatewayClientInternals;
    expect(internals.connectTimer).not.toBeNull();

    socket.emit("message", {
      data: JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "nonce-1" },
      }),
    });
    await flushMicrotasks();

    expect(internals.connectTimer).toBeNull();
    expect(socket.sent).toHaveLength(1);

    vi.advanceTimersByTime(750);
    await flushMicrotasks();
    expect(socket.sent).toHaveLength(1);
  });
});