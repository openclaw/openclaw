import { beforeEach, describe, expect, it } from "vitest";
import {
  recordGatewaySecurityClose,
  resetGatewaySecurityCloseCountersForTest,
} from "./gateway-security-alert.ts";

describe("recordGatewaySecurityClose", () => {
  beforeEach(() => {
    resetGatewaySecurityCloseCountersForTest();
  });

  it("ignores non-security close reasons", () => {
    expect(
      recordGatewaySecurityClose({
        url: "wss://gateway.example.com/ws",
        code: 1005,
        reason: "no reason",
        nowMs: 1_000,
      }),
    ).toBeNull();

    expect(
      recordGatewaySecurityClose({
        url: "wss://gateway.example.com/ws",
        code: 4008,
        reason: "connect failed",
        nowMs: 1_000,
      }),
    ).toBeNull();
  });

  it("alerts on the third security close event within the window", () => {
    const url = "ws://127.0.0.1:18789";
    const reason = "refusing insecure ws:// gateway URL for non-loopback host";

    const first = recordGatewaySecurityClose({ url, code: 4008, reason, nowMs: 1_000 });
    const second = recordGatewaySecurityClose({ url, code: 4008, reason, nowMs: 2_000 });
    const third = recordGatewaySecurityClose({ url, code: 4008, reason, nowMs: 3_000 });

    expect(first).toEqual({ count: 1, shouldAlert: false });
    expect(second).toEqual({ count: 2, shouldAlert: false });
    expect(third).toEqual({ count: 3, shouldAlert: true });
  });

  it("resets the alert window after 60 seconds", () => {
    const url = "ws://127.0.0.1:18789";
    const reason = "refusing insecure ws:// gateway URL for non-loopback host";

    const first = recordGatewaySecurityClose({ url, code: 4008, reason, nowMs: 1_000 });
    const second = recordGatewaySecurityClose({ url, code: 4008, reason, nowMs: 62_000 });

    expect(first).toEqual({ count: 1, shouldAlert: false });
    expect(second).toEqual({ count: 1, shouldAlert: false });
  });
});
