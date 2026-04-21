/* @vitest-environment node */

import { describe, expect, it } from "vitest";
import {
  resolveLoopbackGatewayBootstrapToken,
  resolvePreferredGatewayAccessToken,
} from "./gateway-bootstrap-token.ts";

describe("resolveLoopbackGatewayBootstrapToken", () => {
  it("returns the bootstrap token for the same loopback gateway instance", () => {
    expect(
      resolveLoopbackGatewayBootstrapToken({
        pageUrl: "http://127.0.0.1:18789/",
        gatewayUrl: "ws://localhost:18789",
        bootstrapGatewayToken: "bootstrap-token",
      }),
    ).toBe("bootstrap-token");
  });

  it("does not return the bootstrap token for a different loopback gateway port", () => {
    expect(
      resolveLoopbackGatewayBootstrapToken({
        pageUrl: "http://127.0.0.1:18789/",
        gatewayUrl: "ws://127.0.0.1:28789",
        bootstrapGatewayToken: "bootstrap-token",
      }),
    ).toBeUndefined();
  });

  it("does not return the bootstrap token for non-loopback gateways", () => {
    expect(
      resolveLoopbackGatewayBootstrapToken({
        pageUrl: "http://127.0.0.1:18789/",
        gatewayUrl: "wss://gateway.example/openclaw",
        bootstrapGatewayToken: "bootstrap-token",
      }),
    ).toBeUndefined();
  });

  it("does not treat hostnames with a 127. prefix as loopback", () => {
    expect(
      resolveLoopbackGatewayBootstrapToken({
        pageUrl: "http://127.0.0.1:18789/",
        gatewayUrl: "ws://127.evil.com:18789",
        bootstrapGatewayToken: "bootstrap-token",
      }),
    ).toBeUndefined();
  });
});

describe("resolvePreferredGatewayAccessToken", () => {
  it("prefers the loopback bootstrap token over a stored token", () => {
    expect(
      resolvePreferredGatewayAccessToken({
        pageUrl: "http://127.0.0.1:18789/",
        gatewayUrl: "ws://localhost:18789",
        bootstrapGatewayToken: "bootstrap-token",
        storedToken: "stale-token",
      }),
    ).toBe("bootstrap-token");
  });

  it("falls back to the stored token when bootstrap auth is not valid for this page/gateway pair", () => {
    expect(
      resolvePreferredGatewayAccessToken({
        pageUrl: "https://control.example/openclaw",
        gatewayUrl: "wss://gateway.example/openclaw",
        bootstrapGatewayToken: "bootstrap-token",
        storedToken: "session-token",
      }),
    ).toBe("session-token");
  });
});
