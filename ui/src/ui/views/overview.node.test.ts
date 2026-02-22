import { describe, expect, it } from "vitest";
import { shouldShowPairingHint } from "./overview-hints.ts";

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
});
