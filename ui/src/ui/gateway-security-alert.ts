type SecurityCloseCounter = {
  count: number;
  windowStartedAtMs: number;
};

const SECURITY_CLOSE_ALERT_WINDOW_MS = 60_000;
const SECURITY_CLOSE_ALERT_THRESHOLD = 3;
const SECURITY_CLOSE_COUNTER_MAX = 512;

const securityCloseCounters = new Map<string, SecurityCloseCounter>();

function isSecurityCloseReason(code: number, reason: string): boolean {
  if (code !== 4008) {
    return false;
  }
  const normalizedReason = reason.trim().toLowerCase();
  if (!normalizedReason) {
    return false;
  }
  return normalizedReason.includes("insecure ws:// gateway url");
}

function pruneSecurityCloseCounters(nowMs: number) {
  if (securityCloseCounters.size < SECURITY_CLOSE_COUNTER_MAX) {
    return;
  }
  for (const [key, value] of securityCloseCounters) {
    if (nowMs - value.windowStartedAtMs >= SECURITY_CLOSE_ALERT_WINDOW_MS) {
      securityCloseCounters.delete(key);
    }
  }
}

export function recordGatewaySecurityClose(params: {
  url: string;
  code: number;
  reason: string;
  nowMs?: number;
}): { count: number; shouldAlert: boolean } | null {
  if (!isSecurityCloseReason(params.code, params.reason)) {
    return null;
  }
  const nowMs = params.nowMs ?? Date.now();
  pruneSecurityCloseCounters(nowMs);

  const current = securityCloseCounters.get(params.url);
  const windowExpired =
    !current || nowMs - current.windowStartedAtMs >= SECURITY_CLOSE_ALERT_WINDOW_MS;
  const next: SecurityCloseCounter = windowExpired
    ? { count: 1, windowStartedAtMs: nowMs }
    : { count: current.count + 1, windowStartedAtMs: current.windowStartedAtMs };

  securityCloseCounters.set(params.url, next);
  return {
    count: next.count,
    shouldAlert: next.count === SECURITY_CLOSE_ALERT_THRESHOLD,
  };
}

export function resetGatewaySecurityCloseCountersForTest() {
  securityCloseCounters.clear();
}
