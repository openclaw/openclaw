function parseGatewaySocketUrl(rawUrl: string): URL | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isLoopbackIPv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts[0] !== "127") {
    return false;
  }
  return parts.every((part) => {
    if (!/^\d+$/.test(part)) {
      return false;
    }
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

function normalizeHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalizeHostname(normalized.slice(1, -1));
  }
  if (normalized.startsWith("::ffff:")) {
    return normalizeHostname(normalized.slice("::ffff:".length));
  }
  return normalized;
}

export function isLoopbackGatewayHost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    return false;
  }
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  return isLoopbackIPv4(normalized);
}

export function isSecureGatewaySocketUrl(rawUrl: string): boolean {
  const parsed = parseGatewaySocketUrl(rawUrl);
  if (!parsed) {
    return false;
  }
  if (parsed.protocol === "wss:") {
    return true;
  }
  return isLoopbackGatewayHost(parsed.hostname);
}

export function getGatewaySocketUrlSecurityError(rawUrl: string): string | null {
  const parsed = parseGatewaySocketUrl(rawUrl);
  if (!parsed) {
    return "invalid gateway URL (expected ws:// or wss://)";
  }
  if (!isSecureGatewaySocketUrl(rawUrl)) {
    return "refusing insecure ws:// gateway URL for non-loopback host; use wss:// or localhost tunnel";
  }
  return null;
}

function isSameGatewayHost(hostname: string, currentHostname: string): boolean {
  const left = normalizeHostname(hostname);
  const right = normalizeHostname(currentHostname);
  return left.length > 0 && left === right;
}

export function sanitizeGatewayUrlForUrlOverride(
  rawUrl: string,
  currentHostname: string,
): string | null {
  const parsed = parseGatewaySocketUrl(rawUrl);
  if (!parsed) {
    return null;
  }
  if (parsed.username || parsed.password) {
    return null;
  }
  if (parsed.search || parsed.hash) {
    return null;
  }
  const isLoopback = isLoopbackGatewayHost(parsed.hostname);
  if (!isLoopback && !isSameGatewayHost(parsed.hostname, currentHostname)) {
    return null;
  }
  if (parsed.protocol === "ws:" && !isLoopback) {
    return null;
  }
  return parsed.toString();
}
