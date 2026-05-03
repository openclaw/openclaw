import type { SessionsUsageResult } from "./usage-types.ts";

export type UsageCacheStatus = SessionsUsageResult["cacheStatus"];

export function getUsageCacheRefreshTitle(cacheStatus: UsageCacheStatus): string | null {
  if (
    !cacheStatus ||
    (cacheStatus.status !== "refreshing" &&
      cacheStatus.status !== "stale" &&
      cacheStatus.status !== "partial")
  ) {
    return null;
  }
  return `${cacheStatus.status}: ${cacheStatus.pendingFiles} pending, ${cacheStatus.staleFiles} stale, ${cacheStatus.cachedFiles} cached`;
}
