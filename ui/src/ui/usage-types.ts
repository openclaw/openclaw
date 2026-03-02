import type { SessionsUsageResult as SharedSessionsUsageResult } from "../../../src/shared/usage-types.js";

export type SessionsUsageEntry = SharedSessionsUsageResult["sessions"][number];
export type SessionsUsageTotals = SharedSessionsUsageResult["totals"];
export type SessionsUsageResult = SharedSessionsUsageResult;

export type CostUsageDailyEntry = SessionsUsageTotals & { date: string };

export type CostUsageSummary = {
  updatedAt: number;
  days: number;
  daily: CostUsageDailyEntry[];
  totals: SessionsUsageTotals;
};

export type SessionUsageTimePoint = {
  timestamp: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  cumulativeTokens: number;
  cumulativeCost: number;
};

export type SessionUsageTimeSeries = {
  sessionId?: string;
  points: SessionUsageTimePoint[];
};
