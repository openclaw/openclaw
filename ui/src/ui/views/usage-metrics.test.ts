import { describe, expect, it } from "vitest";
import { buildAggregatesFromSessions, buildUsageInsightStats } from "./usage-metrics.ts";
import type { UsageSessionEntry, UsageTotals } from "./usageTypes.ts";

function createEmptyTotals(): UsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    totalCost: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
  };
}

function makeSession(params: {
  key: string;
  start: number;
  end: number;
  totalTokens: number;
  totalCost: number;
  messages?: number;
  errors?: number;
}): UsageSessionEntry {
  const totals = createEmptyTotals();
  totals.totalTokens = params.totalTokens;
  totals.totalCost = params.totalCost;
  totals.input = params.totalTokens;
  totals.inputCost = params.totalCost;

  return {
    key: params.key,
    updatedAt: params.end,
    usage: {
      ...totals,
      firstActivity: params.start,
      lastActivity: params.end,
      durationMs: Math.max(params.end - params.start, 0),
      activityDates: [],
      dailyBreakdown: [],
      dailyMessageCounts: [],
      messageCounts: {
        total: params.messages ?? 1,
        user: params.messages ?? 1,
        assistant: 0,
        toolCalls: 0,
        toolResults: 0,
        errors: params.errors ?? 0,
      },
    },
  };
}

describe("buildUsageInsightStats", () => {
  it("clips active time to the selected hours and hides throughput when totals do not match the slice", () => {
    const sessions = [
      makeSession({
        key: "session-a",
        start: Date.UTC(2026, 2, 16, 9, 30),
        end: Date.UTC(2026, 2, 16, 11, 30),
        totalTokens: 120,
        totalCost: 6,
      }),
      makeSession({
        key: "session-b",
        start: Date.UTC(2026, 2, 16, 12, 15),
        end: Date.UTC(2026, 2, 16, 12, 45),
        totalTokens: 40,
        totalCost: 2,
      }),
    ];
    const totals = createEmptyTotals();
    totals.totalTokens = 160;
    totals.totalCost = 8;
    const aggregates = buildAggregatesFromSessions(sessions);

    const stats = buildUsageInsightStats(sessions, totals, aggregates, {
      selectedDays: [],
      selectedHours: [10],
      timeZone: "utc",
      throughputTotalsAligned: false,
    });

    expect(stats.durationSumMs).toBe(60 * 60 * 1000);
    expect(stats.durationCount).toBe(1);
    expect(stats.avgDurationMs).toBe(60 * 60 * 1000);
    expect(stats.throughputTotalsAligned).toBe(false);
    expect(stats.throughputTokensPerMin).toBeUndefined();
    expect(stats.throughputCostPerMin).toBeUndefined();
  });

  it("clips cross-day sessions to the selected calendar day", () => {
    const session = makeSession({
      key: "overnight",
      start: Date.UTC(2026, 2, 15, 23, 30),
      end: Date.UTC(2026, 2, 16, 0, 30),
      totalTokens: 60,
      totalCost: 3,
    });
    const totals = createEmptyTotals();
    totals.totalTokens = 60;
    totals.totalCost = 3;
    const aggregates = buildAggregatesFromSessions([session]);

    const stats = buildUsageInsightStats([session], totals, aggregates, {
      selectedDays: ["2026-03-16"],
      selectedHours: [],
      timeZone: "utc",
      throughputTotalsAligned: false,
    });

    expect(stats.durationSumMs).toBe(30 * 60 * 1000);
    expect(stats.durationCount).toBe(1);
    expect(stats.avgDurationMs).toBe(30 * 60 * 1000);
  });

  it("keeps throughput when totals align with the selected window", () => {
    const session = makeSession({
      key: "session-a",
      start: Date.UTC(2026, 2, 16, 10, 0),
      end: Date.UTC(2026, 2, 16, 10, 30),
      totalTokens: 60,
      totalCost: 3,
    });
    const totals = createEmptyTotals();
    totals.totalTokens = 60;
    totals.totalCost = 3;
    const aggregates = buildAggregatesFromSessions([session]);

    const stats = buildUsageInsightStats([session], totals, aggregates, {
      selectedDays: ["2026-03-16"],
      selectedHours: [],
      timeZone: "utc",
      throughputTotalsAligned: true,
    });

    expect(stats.throughputTotalsAligned).toBe(true);
    expect(stats.throughputTokensPerMin).toBeCloseTo(2);
    expect(stats.throughputCostPerMin).toBeCloseTo(0.1);
  });
});
