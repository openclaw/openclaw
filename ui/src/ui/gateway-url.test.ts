import { describe, expect, it } from "vitest";
import { defaultGatewayUrlFromLocation, normalizeGatewayUrl } from "./gateway-url.ts";

describe("gateway URL helpers", () => {
  it("builds ws default URL from http location", () => {
    const url = defaultGatewayUrlFromLocation({
      protocol: "http:",
      host: "localhost:28789",
    });
    expect(url).toBe("ws://localhost:28789");
  });

  it("builds wss default URL from https location", () => {
    const url = defaultGatewayUrlFromLocation({
      protocol: "https:",
      host: "example.com",
    });
    expect(url).toBe("wss://example.com");
  });

  it("normalizes http URL to ws URL", () => {
    const normalized = normalizeGatewayUrl("http://localhost:18789", "ws://fallback:1");
    expect(normalized).toBe("ws://localhost:18789/");
  });

  it("normalizes https URL to wss URL", () => {
    const normalized = normalizeGatewayUrl("https://example.com/gateway", "ws://fallback:1");
    expect(normalized).toBe("wss://example.com/gateway");
  });

  it("accepts host-only shorthand", () => {
    const normalized = normalizeGatewayUrl("localhost:18789", "ws://fallback:1");
    expect(normalized).toBe("ws://localhost:18789");
  });

  it("falls back for invalid values", () => {
    const normalized = normalizeGatewayUrl("not a url !!!", "ws://fallback:1");
    expect(normalized).toBe("ws://fallback:1");
  });
});
