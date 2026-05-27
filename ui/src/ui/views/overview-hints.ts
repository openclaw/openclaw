import { ConnectErrorDetailCodes } from "../../../../src/gateway/protocol/connect-error-details.js";

const AUTH_REQUIRED_CODES = new Set<string>([
  ConnectErrorDetailCodes.AUTH_REQUIRED,
  ConnectErrorDetailCodes.AUTH_TOKEN_MISSING,
  ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING,
  ConnectErrorDetailCodes.AUTH_TOKEN_NOT_CONFIGURED,
  ConnectErrorDetailCodes.AUTH_PASSWORD_NOT_CONFIGURED,
]);

const AUTH_FAILURE_CODES = new Set<string>([
  ...AUTH_REQUIRED_CODES,
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

const INSECURE_CONTEXT_CODES = new Set<string>([
  ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
  ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED,
]);

type AuthHintKind = "required" | "failed";

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
    if (!AUTH_FAILURE_CODES.has(params.lastErrorCode)) {
      return null;
    }
    return AUTH_REQUIRED_CODES.has(params.lastErrorCode) ? "required" : "failed";
  }

  const lower = params.lastError.toLowerCase();
  if (!lower.includes("unauthorized")) {
    return null;
  }
  return !params.hasToken && !params.hasPassword ? "required" : "failed";
}

export function shouldShowInsecureContextHint(
  connected: boolean,
  lastError: string | null,
  lastErrorCode?: string | null,
): boolean {
  if (connected || !lastError) {
    return false;
  }
  if (lastErrorCode) {
    return INSECURE_CONTEXT_CODES.has(lastErrorCode);
  }
  const lower = lastError.toLowerCase();
  return lower.includes("secure context") || lower.includes("device identity required");
}
