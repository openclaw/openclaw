import { describe, expect, it } from "vitest";
import {
  getGatewaySocketUrlSecurityError,
  isLoopbackGatewayHost,
  isSecureGatewaySocketUrl,
  sanitizeGatewayUrlForUrlOverride,
} from "./gateway-url-security.ts";

describe("isLoopbackGatewayHost", () => {
  it.each(["localhost", "LOCALHOST", "127.0.0.1", "127.10.20.30", "::1", "[::1]"])(
    "accepts %s",
    (value) => {
      expect(isLoopbackGatewayHost(value)).toBe(true);
    },
  );

  it.each(["", "0.0.0.0", "10.0.0.1", "example.com", "::ffff:10.0.0.1"])("rejects %s", (value) => {
    expect(isLoopbackGatewayHost(value)).toBe(false);
  });
});

describe("isSecureGatewaySocketUrl", () => {
  it("accepts wss endpoints", () => {
    expect(isSecureGatewaySocketUrl("wss://gateway.example.com:18789/ws")).toBe(true);
  });

  it("accepts loopback ws endpoints", () => {
    expect(isSecureGatewaySocketUrl("ws://127.0.0.1:18789/ws")).toBe(true);
  });

  it("rejects plaintext ws on non-loopback", () => {
    expect(isSecureGatewaySocketUrl("ws://gateway.example.com:18789/ws")).toBe(false);
  });
});

describe("getGatewaySocketUrlSecurityError", () => {
  it("rejects malformed URLs", () => {
    expect(getGatewaySocketUrlSecurityError("https://gateway.example.com")).toBe(
      "invalid gateway URL (expected ws:// or wss://)",
    );
  });

  it("rejects insecure plaintext ws URLs", () => {
    expect(getGatewaySocketUrlSecurityError("ws://gateway.example.com:18789")).toBe(
      "refusing insecure ws:// gateway URL for non-loopback host; use wss:// or localhost tunnel",
    );
  });

  it("accepts secure websocket URLs", () => {
    expect(getGatewaySocketUrlSecurityError("wss://gateway.example.com:18789")).toBeNull();
    expect(getGatewaySocketUrlSecurityError("ws://127.0.0.1:18789")).toBeNull();
  });
});

describe("sanitizeGatewayUrlForUrlOverride", () => {
  const currentHost = "control.example.com";

  it("accepts same-host secure overrides", () => {
    expect(sanitizeGatewayUrlForUrlOverride("wss://control.example.com/ws", currentHost)).toBe(
      "wss://control.example.com/ws",
    );
  });

  it("accepts loopback plaintext overrides", () => {
    expect(sanitizeGatewayUrlForUrlOverride("ws://127.0.0.1:18789/ws", currentHost)).toBe(
      "ws://127.0.0.1:18789/ws",
    );
  });

  it("rejects cross-host overrides", () => {
    expect(sanitizeGatewayUrlForUrlOverride("wss://attacker.example/ws", currentHost)).toBeNull();
  });

  it("rejects non-loopback plaintext overrides", () => {
    expect(sanitizeGatewayUrlForUrlOverride("ws://control.example.com/ws", currentHost)).toBeNull();
  });

  it("rejects credentials, query, and fragments", () => {
    expect(
      sanitizeGatewayUrlForUrlOverride("wss://user:pass@control.example.com/ws", currentHost),
    ).toBeNull();
    expect(sanitizeGatewayUrlForUrlOverride("wss://control.example.com/ws?x=1", currentHost)).toBe(
      null,
    );
    expect(sanitizeGatewayUrlForUrlOverride("wss://control.example.com/ws#frag", currentHost)).toBe(
      null,
    );
  });
});
