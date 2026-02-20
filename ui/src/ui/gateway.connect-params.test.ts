import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GatewayBrowserClient connect params", () => {
  it("sends Protocol v3 connect params matching ConnectParamsSchema shape", async () => {
    // Force the insecure (no device identity) codepath so we don't need to mock
    // IndexedDB/localStorage-based device identity helpers.
    const realCrypto = globalThis.crypto as unknown as {
      randomUUID?: () => string;
      getRandomValues?: (arr: Uint8Array) => Uint8Array;
    };

    vi.stubGlobal("crypto", {
      randomUUID: realCrypto?.randomUUID?.bind(realCrypto),
      getRandomValues: realCrypto?.getRandomValues?.bind(realCrypto),
      subtle: undefined,
    });

    const sent: unknown[] = [];

    const { GatewayBrowserClient } = await import("./gateway.ts");

    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "token-test",
      password: "",
      clientVersion: "2026.2.20-test",
      platform: "web-test",
      // Intentionally omit clientName/mode so defaults are exercised.
    });

    // Inject a fake ws transport so we can observe the outbound connect frame.
    (client as any).ws = {
      readyState: WebSocket.OPEN,
      send: (data: string) => {
        sent.push(JSON.parse(data));
      },
      close: vi.fn(),
    };

    await (client as any).sendConnect();

    expect(sent).toHaveLength(1);
    const frame = sent[0] as any;

    expect(frame.type).toBe("req");
    expect(frame.method).toBe("connect");
    expect(typeof frame.id).toBe("string");
    expect(frame.id.length).toBeGreaterThan(0);

    const params = frame.params as any;

    // ConnectParamsSchema forbids root-level nonce.
    expect("nonce" in params).toBe(false);

    // Required protocol range.
    expect(typeof params.minProtocol).toBe("number");
    expect(typeof params.maxProtocol).toBe("number");

    // Required client info (id/mode/version/platform).
    expect(params.client).toBeTruthy();
    expect(params.client.id).toBe("gateway-client");
    expect(params.client.mode).toBe("ui");
    expect(params.client.version).toBe("2026.2.20-test");
    expect(params.client.platform).toBe("web-test");

    // In insecure mode, device identity should be omitted.
    expect(params.device).toBeUndefined();

    // Make sure we are not using legacy top-level fields.
    expect("clientId" in params).toBe(false);
    expect("clientMode" in params).toBe(false);
  });
});
