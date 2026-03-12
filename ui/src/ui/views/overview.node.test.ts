import { describe, expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../../src/gateway/protocol/connect-error-details.js";
import type { UiSettings } from "../storage.ts";
import { shouldShowPairingHint } from "./overview-hints.ts";
import { updateOverviewGatewayUrl } from "./overview-settings.ts";

function createSettings(overrides: Partial<UiSettings> = {}): UiSettings {
  return {
    gatewayUrl: "ws://127.0.0.1:18789",
    token: "abc123",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "system",
    chatFocusMode: false,
    chatShowThinking: true,
    splitRatio: 0.6,
    navCollapsed: false,
    navGroupsCollapsed: {},
    ...overrides,
  };
}

describe("shouldShowPairingHint", () => {
  it("returns true for 'pairing required' close reason", () => {
    expect(shouldShowPairingHint(false, "disconnected (1008): pairing required")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(shouldShowPairingHint(false, "Pairing Required")).toBe(true);
  });

  it("returns false when connected", () => {
    expect(shouldShowPairingHint(true, "disconnected (1008): pairing required")).toBe(false);
  });

  it("returns false when lastError is null", () => {
    expect(shouldShowPairingHint(false, null)).toBe(false);
  });

  it("returns false for unrelated errors", () => {
    expect(shouldShowPairingHint(false, "disconnected (1006): no reason")).toBe(false);
  });

  it("returns false for auth errors", () => {
    expect(shouldShowPairingHint(false, "disconnected (4008): unauthorized")).toBe(false);
  });

  it("returns true for structured pairing code", () => {
    expect(
      shouldShowPairingHint(
        false,
        "disconnected (4008): connect failed",
        ConnectErrorDetailCodes.PAIRING_REQUIRED,
      ),
    ).toBe(true);
  });
});

describe("updateOverviewGatewayUrl", () => {
  it("preserves the current token while editing the gateway URL", () => {
    expect(
      updateOverviewGatewayUrl(createSettings(), "wss://other-gateway.example/openclaw"),
    ).toMatchObject({
      gatewayUrl: "wss://other-gateway.example/openclaw",
      token: "abc123",
    });
  });
});
