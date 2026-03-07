import { describe, expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../../src/gateway/protocol/connect-error-details.js";
import {
  shouldShowAuthHint,
  shouldShowAuthRequiredHint,
  shouldShowInsecureContextHint,
  shouldShowPairingHint,
} from "./overview-hints.ts";

describe("overview hints", () => {
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

  describe("shouldShowAuthHint", () => {
    it("returns true for structured auth failures", () => {
      expect(
        shouldShowAuthHint(
          false,
          "disconnected (4008): connect failed",
          ConnectErrorDetailCodes.AUTH_TAILSCALE_IDENTITY_MISMATCH,
        ),
      ).toBe(true);
    });

    it("falls back to legacy close text when no detail code is present", () => {
      expect(shouldShowAuthHint(false, "disconnected (4008): unauthorized")).toBe(true);
    });

    it("returns false for non-auth errors", () => {
      expect(shouldShowAuthHint(false, "disconnected (1006): no reason")).toBe(false);
    });
  });

  describe("shouldShowAuthRequiredHint", () => {
    it("returns true for structured auth-required codes", () => {
      expect(
        shouldShowAuthRequiredHint(true, true, ConnectErrorDetailCodes.AUTH_TOKEN_MISSING),
      ).toBe(true);
    });

    it("falls back to missing credentials when detail code is absent", () => {
      expect(shouldShowAuthRequiredHint(false, false, null)).toBe(true);
      expect(shouldShowAuthRequiredHint(true, false, null)).toBe(false);
    });
  });

  describe("shouldShowInsecureContextHint", () => {
    it("returns true for structured device identity errors", () => {
      expect(
        shouldShowInsecureContextHint(
          false,
          "disconnected (4008): connect failed",
          ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
        ),
      ).toBe(true);
    });

    it("falls back to legacy close text when detail code is absent", () => {
      expect(shouldShowInsecureContextHint(false, "device identity required")).toBe(true);
    });
  });
});
