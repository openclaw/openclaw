import { ConnectErrorDetailCodes } from "../../../../src/gateway/protocol/connect-error-details.js";

/** Whether the overview should show device-pairing guidance for this error. */
export function shouldShowPairingHint(
  connected: boolean,
  lastError: string | null,
  lastErrorCode?: string | null,
): boolean {
  if (connected || !lastError) {
    return false;
  }
  if (lastErrorCode === ConnectErrorDetailCodes.PAIRING_REQUIRED) {
    return true;
  }
  return lastError.toLowerCase().includes("pairing required");
}

type AuthHintKind = "required" | "failed";

const authRequiredCodes = new Set<string>([
  ConnectErrorDetailCodes.AUTH_REQUIRED,
  ConnectErrorDetailCodes.AUTH_TOKEN_MISSING,
  ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING,
  ConnectErrorDetailCodes.AUTH_TOKEN_NOT_CONFIGURED,
  ConnectErrorDetailCodes.AUTH_PASSWORD_NOT_CONFIGURED,
]);

const authFailureCodes = new Set<string>([
  ...authRequiredCodes,
  ConnectErrorDetailCodes.AUTH_UNAUTHORIZED,
  ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH,
  ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH,
  ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH,
  ConnectErrorDetailCodes.AUTH_RATE_LIMITED,
  ConnectErrorDetailCodes.AUTH_TAILSCALE_IDENTITY_MISSING,
  ConnectErrorDetailCodes.AUTH_TAILSCALE_PROXY_MISSING,
  ConnectErrorDetailCodes.AUTH_TAILSCALE_WHOIS_FAILED,
  ConnectErrorDetailCodes.AUTH_TAILSCALE_IDENTITY_MISMATCH,
]);

/**
 * Return the overview auth hint to show, if any.
 *
 * Keep fallback string matching narrow so generic "connect failed" close reasons
 * do not get misclassified as token/password problems.
 */
export function resolveAuthHintKind(params: {
  connected: boolean;
  lastError: string | null;
  lastErrorCode?: string | null;
  hasToken: boolean;
  hasPassword: boolean;
}): AuthHintKind | null {
  if (params.connected || !params.lastError) {
    return null;
  }
  if (params.lastErrorCode) {
    if (!authFailureCodes.has(params.lastErrorCode)) {
      return null;
    }
    return authRequiredCodes.has(params.lastErrorCode) ? "required" : "failed";
  }

  const lower = params.lastError.toLowerCase();
  const authFailed = lower.includes("unauthorized");
  if (!authFailed) {
    return null;
  }
  return !params.hasToken && !params.hasPassword ? "required" : "failed";
}
