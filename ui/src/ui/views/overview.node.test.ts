// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../../../src/gateway/protocol/connect-error-details.js";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { resolveGatewayTokenForUrlEdit } from "../storage.ts";
import {
  resolveAuthHintKind,
  resolvePairingHint,
  shouldShowPairingHint,
} from "./overview-hints.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveGatewayTokenForUrlEdit", () => {
  it("preserves the current token for same normalized gateway endpoint edits", () => {
    expect(
      resolveGatewayTokenForUrlEdit(
        "wss://gateway.example/openclaw",
        " wss://gateway.example/openclaw/ ",
        "abc123",
      ),
    ).toBe("abc123");
  });

  it("loads a scoped token when the normalized gateway endpoint changes", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    sessionStorage.setItem(
      "openclaw.control.token.v1:wss://other-gateway.example/openclaw",
      "other-token",
    );

    expect(
      resolveGatewayTokenForUrlEdit(
        "wss://gateway.example/openclaw",
        "wss://other-gateway.example/openclaw/",
        "abc123",
      ),
    ).toBe("other-token");
  });

  it("clears the token when the changed gateway endpoint has no scoped token", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());

    expect(
      resolveGatewayTokenForUrlEdit(
        "wss://gateway.example/openclaw",
        "wss://other-gateway.example/openclaw",
        "abc123",
      ),
    ).toBe("");
  });
});

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

describe("resolvePairingHint", () => {
  it("detects scope-upgrade pending approval and keeps the request id", () => {
    expect(
      resolvePairingHint(
        false,
        "scope upgrade pending approval (requestId: req-123)",
        ConnectErrorDetailCodes.PAIRING_REQUIRED,
      ),
    ).toEqual({
      kind: "scope-upgrade-pending",
      requestId: "req-123",
    });
  });
});

describe("resolveAuthHintKind", () => {
  it("returns required for structured auth-required codes", () => {
    expect(
      resolveAuthHintKind({
        connected: false,
        lastError: "disconnected (4008): connect failed",
        lastErrorCode: ConnectErrorDetailCodes.AUTH_TOKEN_MISSING,
        hasToken: false,
        hasPassword: false,
      }),
    ).toBe("required");
  });

  it("returns failed for structured auth mismatch codes", () => {
    expect(
      resolveAuthHintKind({
        connected: false,
        lastError: "disconnected (4008): connect failed",
        lastErrorCode: ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH,
        hasToken: true,
        hasPassword: false,
      }),
    ).toBe("failed");
  });

  it("does not treat generic connect failures as auth failures", () => {
    expect(
      resolveAuthHintKind({
        connected: false,
        lastError: "disconnected (4008): connect failed",
        lastErrorCode: ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
        hasToken: true,
        hasPassword: false,
      }),
    ).toBeNull();
  });

  it("falls back to unauthorized string matching without structured codes", () => {
    expect(
      resolveAuthHintKind({
        connected: false,
        lastError: "disconnected (4008): unauthorized",
        lastErrorCode: null,
        hasToken: true,
        hasPassword: false,
      }),
    ).toBe("failed");
  });
});
