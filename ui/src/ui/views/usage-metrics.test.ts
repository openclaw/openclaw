import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildAggregatesFromSessions,
  buildPeakErrorHours,
  buildUsageMosaicStats,
  getHourAndWeekdayForUtcQuarterBucket,
  sessionTouchesSelectedHours,
} from "./usage-metrics.ts";
import type { UsageSessionEntry } from "./usageTypes.ts";

/**
 * Helper: build a minimal UsageSessionEntry with utcQuarterHourMessageCounts
 * using the new UTC quarter-hour bucket format.
 */
function makeSessionWithQuarterHourly(
  buckets: Array<{
    date: string;
    quarterIndex: number;
    total: number;
    errors: number;
  }>,
): UsageSessionEntry {
  return {
    key: "test-session",
    usage: {
      totalTokens: 100,
      totalCost: 0.01,
      input: 50,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
      firstActivity: Date.now() - 3600_000,
      lastActivity: Date.now(),
      messageCounts: {
        total: buckets.reduce((sum, b) => sum + b.total, 0),
        user: 0,
        assistant: 0,
        toolCalls: 0,
        toolResults: 0,
        errors: buckets.reduce((sum, b) => sum + b.errors, 0),
      },
      utcQuarterHourMessageCounts: buckets.map((b) => ({
        date: b.date,
        quarterIndex: b.quarterIndex,
        total: b.total,
        user: 0,
        assistant: 0,
        toolCalls: 0,
        toolResults: 0,
        errors: b.errors,
      })),
    },
  } as unknown as UsageSessionEntry;
}

function peakErrorSummaries(result: ReturnType<typeof buildPeakErrorHours>) {
  return result.map(({ value, sub }) => ({ value, sub }));
}

describe("buildPeakErrorHours", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps UTC quarter-hour buckets to correct hours in UTC mode", () => {
    // quarterIndex 0  → 00:00-00:14 UTC → hour 0
    // quarterIndex 4  → 01:00-01:14 UTC → hour 1
    // quarterIndex 36 → 09:00-09:14 UTC → hour 9
    // quarterIndex 95 → 23:45-23:59 UTC → hour 23
    const session = makeSessionWithQuarterHourly([
      { date: "2026-03-15", quarterIndex: 0, total: 10, errors: 5 },
      { date: "2026-03-15", quarterIndex: 4, total: 20, errors: 2 },
      { date: "2026-03-15", quarterIndex: 36, total: 15, errors: 3 },
      { date: "2026-03-15", quarterIndex: 95, total: 8, errors: 4 },
    ]);

    const result = buildPeakErrorHours([session], "utc");

    // hour 0: 5/10 = 50%, hour 23: 4/8 = 50%, hour 9: 3/15 = 20%, hour 1: 2/20 = 10%
    expect(peakErrorSummaries(result)).toStrictEqual([
      { value: "50.00%", sub: "5 errors · 10 msgs" },
      { value: "50.00%", sub: "4 errors · 8 msgs" },
      { value: "20.00%", sub: "3 errors · 15 msgs" },
      { value: "10.00%", sub: "2 errors · 20 msgs" },
    ]);
  });

  it("aggregates multiple quarter-hour buckets into the same hour in UTC mode", () => {
    // quarterIndex 0 (00:00) and quarterIndex 3 (00:45) both map to hour 0
    const session = makeSessionWithQuarterHourly([
      { date: "2026-03-15", quarterIndex: 0, total: 10, errors: 2 },
      { date: "2026-03-15", quarterIndex: 3, total: 5, errors: 3 },
    ]);

    const result = buildPeakErrorHours([session], "utc");
    // Aggregated: 5 errors / 15 total = 33.33%
    expect(peakErrorSummaries(result)).toStrictEqual([
      { value: "33.33%", sub: "5 errors · 15 msgs" },
    ]);
  });

  it("shifts UTC quarter-hour buckets to local timezone in local mode", () => {
    // Simulate UTC+5: UTC hour 0 → local hour 5, UTC hour 10 → local hour 15
    vi.spyOn(Date.prototype, "getHours").mockImplementation(function (this: Date) {
      return (this.getUTCHours() + 5) % 24;
    });

    // quarterIndex 0 → UTC 00:00 → local 05:00
    // quarterIndex 40 → UTC 10:00 → local 15:00
    const session = makeSessionWithQuarterHourly([
      { date: "2026-03-15", quarterIndex: 0, total: 10, errors: 3 },
      { date: "2026-03-15", quarterIndex: 40, total: 20, errors: 4 },
    ]);

    const result = buildPeakErrorHours([session], "local");

    expect(peakErrorSummaries(result)).toStrictEqual([
      { value: "30.00%", sub: "3 errors · 10 msgs" }, // local hour 5
      { value: "20.00%", sub: "4 errors · 20 msgs" }, // local hour 15
    ]);
  });

  it("wraps correctly for negative local timezone (UTC-8)", () => {
    // Simulate UTC-8: UTC hour 0 → local hour 16 (previous day)
    vi.spyOn(Date.prototype, "getHours").mockImplementation(function (this: Date) {
      return (this.getUTCHours() - 8 + 24) % 24;
    });

    // quarterIndex 0 → UTC 00:00 → local 16:00
    const session = makeSessionWithQuarterHourly([
      { date: "2026-03-15", quarterIndex: 0, total: 10, errors: 5 },
    ]);

    const result = buildPeakErrorHours([session], "local");
    expect(peakErrorSummaries(result)).toStrictEqual([
      { value: "50.00%", sub: "5 errors · 10 msgs" },
    ]);
  });

  it("wraps correctly for positive local timezone near midnight (UTC+8, late quarter)", () => {
    // Simulate UTC+8: UTC hour 17 → local hour 1 (next day)
    vi.spyOn(Date.prototype, "getHours").mockImplementation(function (this: Date) {
      return (this.getUTCHours() + 8) % 24;
    });

    // quarterIndex 68 → UTC 17:00 → local 01:00 (next day)
    const session = makeSessionWithQuarterHourly([
      { date: "2026-03-15", quarterIndex: 68, total: 12, errors: 6 },
    ]);

    const result = buildPeakErrorHours([session], "local");
    expect(peakErrorSummaries(result)).toStrictEqual([
      { value: "50.00%", sub: "6 errors · 12 msgs" },
    ]);
  });

  it("returns empty array when no sessions have errors", () => {
    const session = makeSessionWithQuarterHourly([
      { date: "2026-03-15", quarterIndex: 10, total: 50, errors: 0 },
    ]);

    const result = buildPeakErrorHours([session], "utc");
    expect(result).toStrictEqual([]);
  });

  it("returns empty array when sessions have no message counts", () => {
    const session: UsageSessionEntry = {
      key: "empty",
      usage: {
        totalTokens: 0,
        totalCost: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        missingCostEntries: 0,
        messageCounts: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
      },
    } as unknown as UsageSessionEntry;

    const result = buildPeakErrorHours([session], "utc");
    expect(result).toStrictEqual([]);
  });

  it("limits results to at most 5 entries sorted by error rate", () => {
    // Create 8 different hours with errors
    const buckets = Array.from({ length: 8 }, (_, i) => ({
      date: "2026-03-15",
      quarterIndex: i * 8, // hours 0,2,4,6,8,10,12,14
      total: 100,
      errors: (i + 1) * 2, // increasing error counts
    }));
    const session = makeSessionWithQuarterHourly(buckets);

    const result = buildPeakErrorHours([session], "utc");

    // Should be sorted by rate descending — highest rate first
    expect(peakErrorSummaries(result)).toStrictEqual([
      { value: "16.00%", sub: "16 errors · 100 msgs" },
      { value: "14.00%", sub: "14 errors · 100 msgs" },
      { value: "12.00%", sub: "12 errors · 100 msgs" },
      { value: "10.00%", sub: "10 errors · 100 msgs" },
      { value: "8.00%", sub: "8 errors · 100 msgs" },
    ]);
  });

  it("aggregates across multiple sessions", () => {
    const session1 = makeSessionWithQuarterHourly([
      { date: "2026-03-15", quarterIndex: 20, total: 10, errors: 3 },
    ]);
    const session2 = makeSessionWithQuarterHourly([
      { date: "2026-03-16", quarterIndex: 20, total: 20, errors: 7 },
    ]);

    const result = buildPeakErrorHours([session1, session2], "utc");
    // quarterIndex 20 → hour 5: aggregated 10 errors / 30 msgs = 33.33%
    expect(peakErrorSummaries(result)).toStrictEqual([
      { value: "33.33%", sub: "10 errors · 30 msgs" },
    ]);
  });

  it("falls back to proportional allocation when utcQuarterHourMessageCounts is absent", () => {
    // Session without utcQuarterHourMessageCounts should use forEachSessionHourSlice
    const session: UsageSessionEntry = {
      key: "fallback-session",
      updatedAt: Date.parse("2026-03-15T10:30:00.000Z"),
      usage: {
        totalTokens: 100,
        totalCost: 0.01,
        input: 50,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        missingCostEntries: 0,
        firstActivity: Date.parse("2026-03-15T10:00:00.000Z"),
        lastActivity: Date.parse("2026-03-15T10:30:00.000Z"),
        messageCounts: {
          total: 10,
          user: 5,
          assistant: 5,
          toolCalls: 0,
          toolResults: 0,
          errors: 3,
        },
        // No utcQuarterHourMessageCounts -> fallback path
      },
    } as unknown as UsageSessionEntry;

    const result = buildPeakErrorHours([session], "utc");
    expect(peakErrorSummaries(result)).toStrictEqual([
      { value: "30.00%", sub: "3 errors · 10 msgs" },
    ]);
  });
});

describe("usage mosaic token buckets", () => {
  const makeSessionWithTokenBuckets = (
    buckets: Array<{
      date: string;
      quarterIndex: number;
      totalTokens: number;
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
    }>,
  ): UsageSessionEntry =>
    ({
      key: "token-bucket-session",
      usage: {
        totalTokens: buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0),
        totalCost: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        missingCostEntries: 0,
        firstActivity: Date.parse("2026-02-01T10:00:00.000Z"),
        lastActivity: Date.parse("2026-02-01T12:00:00.000Z"),
        utcQuarterHourTokenUsage: buckets.map((bucket) => ({
          date: bucket.date,
          quarterIndex: bucket.quarterIndex,
          input: bucket.input ?? 0,
          output: bucket.output ?? bucket.totalTokens,
          cacheRead: bucket.cacheRead ?? 0,
          cacheWrite: bucket.cacheWrite ?? 0,
          totalTokens: bucket.totalTokens,
          totalCost: 0,
        })),
      },
    }) as unknown as UsageSessionEntry;

  it("maps UTC quarter-hour buckets and rejects invalid bucket coordinates", () => {
    expect(getHourAndWeekdayForUtcQuarterBucket("2026-02-01", 40, "utc")).toEqual({
      hour: 10,
      weekday: 0,
    });
    expect(getHourAndWeekdayForUtcQuarterBucket("2026-02-01", -1, "utc")).toBeNull();
    expect(getHourAndWeekdayForUtcQuarterBucket("2026-02-01", 96, "utc")).toBeNull();
    expect(getHourAndWeekdayForUtcQuarterBucket("2026-13-01", 40, "utc")).toBeNull();
    expect(getHourAndWeekdayForUtcQuarterBucket("not-a-date", 40, "utc")).toBeNull();
  });

  it("uses local timezone mapping for UTC quarter-hour buckets", () => {
    vi.spyOn(Date.prototype, "getHours").mockImplementation(function (this: Date) {
      return (this.getUTCHours() + 8) % 24;
    });
    vi.spyOn(Date.prototype, "getDay").mockReturnValue(1);

    expect(getHourAndWeekdayForUtcQuarterBucket("2026-02-01", 68, "local")).toEqual({
      hour: 1,
      weekday: 1,
    });
  });

  it("uses precise token buckets instead of spreading session totals across the session span", () => {
    const session = makeSessionWithTokenBuckets([
      { date: "2026-02-01", quarterIndex: 40, totalTokens: 10_000 },
    ]);

    const stats = buildUsageMosaicStats([session], "utc");

    expect(stats.totalTokens).toBe(10_000);
    expect(stats.hourTotals[10]).toBe(10_000);
    expect(stats.hourTotals[11]).toBe(0);
  });

  it("filters selected hours by precise token buckets before falling back to session span", () => {
    const session = makeSessionWithTokenBuckets([
      { date: "2026-02-01", quarterIndex: 40, totalTokens: 10_000 },
    ]);

    expect(sessionTouchesSelectedHours(session, [10], "utc")).toBe(true);
    expect(sessionTouchesSelectedHours(session, [11], "utc")).toBe(false);
  });

  it("preserves legacy session-span hour filtering when token buckets are absent", () => {
    const session = {
      key: "legacy-span-session",
      usage: {
        totalTokens: 100,
        totalCost: 0,
        input: 0,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        missingCostEntries: 0,
        firstActivity: Date.parse("2026-02-01T10:00:00.000Z"),
        lastActivity: Date.parse("2026-02-01T11:00:00.000Z"),
      },
    } as unknown as UsageSessionEntry;

    expect(sessionTouchesSelectedHours(session, [10], "utc")).toBe(true);
    expect(sessionTouchesSelectedHours(session, [11], "utc")).toBe(true);
    expect(sessionTouchesSelectedHours(session, [12], "utc")).toBe(false);
  });

  it("falls back to session span when token buckets contain no valid positive tokens", () => {
    const session = {
      key: "empty-token-bucket-session",
      usage: {
        totalTokens: 100,
        totalCost: 0,
        input: 0,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        missingCostEntries: 0,
        firstActivity: Date.parse("2026-02-01T11:00:00.000Z"),
        lastActivity: Date.parse("2026-02-01T11:00:00.000Z"),
        utcQuarterHourTokenUsage: [
          {
            date: "2026-02-01",
            quarterIndex: 40,
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            totalCost: 0,
          },
        ],
      },
    } as unknown as UsageSessionEntry;

    expect(sessionTouchesSelectedHours(session, [11], "utc")).toBe(true);
  });
});

describe("buildAggregatesFromSessions", () => {
  function makeSession(params: {
    key?: string;
    agentId?: string;
    channel?: string;
    messageCounts?: {
      total: number;
      user: number;
      assistant: number;
      toolCalls: number;
      toolResults: number;
      errors: number;
    };
    modelUsage?: Array<{
      provider?: string;
      model?: string;
      count: number;
      totals: {
        totalTokens: number;
        totalCost: number;
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        inputCost: number;
        outputCost: number;
        cacheReadCost: number;
        cacheWriteCost: number;
        missingCostEntries: number;
      };
    }>;
    dailyBreakdown?: Array<{ date: string; tokens: number; cost: number }>;
    dailyMessageCounts?: Array<{
      date: string;
      total: number;
      user: number;
      assistant: number;
      toolCalls: number;
      toolResults: number;
      errors: number;
    }>;
    dailyModelUsage?: Array<{
      date: string;
      provider?: string;
      model?: string;
      tokens: number;
      cost: number;
      count: number;
    }>;
    dailyLatency?: Array<{
      date: string;
      count: number;
      avgMs: number;
      minMs: number;
      maxMs: number;
      p95Ms: number;
    }>;
    latency?: { count: number; avgMs: number; minMs: number; maxMs: number; p95Ms: number };
    toolUsage?: {
      totalCalls: number;
      uniqueTools: number;
      tools: Array<{ name: string; count: number }>;
    };
  }): UsageSessionEntry {
    return {
      key: params.key ?? "test-session",
      agentId: params.agentId,
      channel: params.channel,
      usage: {
        totalTokens: 100,
        totalCost: 0.01,
        input: 50,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        inputCost: 0,
        outputCost: 0.01,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        missingCostEntries: 0,
        messageCounts: params.messageCounts,
        modelUsage: params.modelUsage,
        dailyBreakdown: params.dailyBreakdown,
        dailyMessageCounts: params.dailyMessageCounts,
        dailyModelUsage: params.dailyModelUsage,
        dailyLatency: params.dailyLatency,
        latency: params.latency,
        toolUsage: params.toolUsage,
      },
    } as unknown as UsageSessionEntry;
  }

  it("aggregates all session data when no selectedDays provided", () => {
    const session = makeSession({
      messageCounts: { total: 10, user: 5, assistant: 5, toolCalls: 2, toolResults: 2, errors: 1 },
      modelUsage: [
        {
          provider: "openai",
          model: "gpt-4",
          count: 5,
          totals: {
            totalTokens: 100,
            totalCost: 0.01,
            input: 50,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
            inputCost: 0,
            outputCost: 0.01,
            cacheReadCost: 0,
            cacheWriteCost: 0,
            missingCostEntries: 0,
          },
        },
      ],
      dailyBreakdown: [
        { date: "2026-06-01", tokens: 60, cost: 0.006 },
        { date: "2026-06-02", tokens: 40, cost: 0.004 },
      ],
      dailyMessageCounts: [
        {
          date: "2026-06-01",
          total: 6,
          user: 3,
          assistant: 3,
          toolCalls: 1,
          toolResults: 1,
          errors: 0,
        },
        {
          date: "2026-06-02",
          total: 4,
          user: 2,
          assistant: 2,
          toolCalls: 1,
          toolResults: 1,
          errors: 1,
        },
      ],
      dailyModelUsage: [
        {
          date: "2026-06-01",
          provider: "openai",
          model: "gpt-4",
          tokens: 60,
          cost: 0.006,
          count: 3,
        },
        {
          date: "2026-06-02",
          provider: "openai",
          model: "gpt-4",
          tokens: 40,
          cost: 0.004,
          count: 2,
        },
      ],
    });

    const result = buildAggregatesFromSessions([session]);

    expect(result.messages.total).toBe(10);
    expect(result.byModel).toHaveLength(1);
    expect(result.byModel[0].totals.totalTokens).toBe(100);
    expect(result.daily).toHaveLength(2);
    expect(result.modelDaily).toHaveLength(2);
  });

  it("filters aggregates by selectedDays using daily breakdowns", () => {
    const session = makeSession({
      agentId: "agent-1",
      channel: "telegram",
      messageCounts: { total: 10, user: 5, assistant: 5, toolCalls: 2, toolResults: 2, errors: 1 },
      modelUsage: [
        {
          provider: "openai",
          model: "gpt-4",
          count: 5,
          totals: {
            totalTokens: 100,
            totalCost: 0.01,
            input: 50,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
            inputCost: 0,
            outputCost: 0.01,
            cacheReadCost: 0,
            cacheWriteCost: 0,
            missingCostEntries: 0,
          },
        },
      ],
      dailyBreakdown: [
        { date: "2026-06-01", tokens: 60, cost: 0.006 },
        { date: "2026-06-02", tokens: 40, cost: 0.004 },
      ],
      dailyMessageCounts: [
        {
          date: "2026-06-01",
          total: 6,
          user: 3,
          assistant: 3,
          toolCalls: 1,
          toolResults: 1,
          errors: 0,
        },
        {
          date: "2026-06-02",
          total: 4,
          user: 2,
          assistant: 2,
          toolCalls: 1,
          toolResults: 1,
          errors: 1,
        },
      ],
      dailyModelUsage: [
        {
          date: "2026-06-01",
          provider: "openai",
          model: "gpt-4",
          tokens: 60,
          cost: 0.006,
          count: 3,
        },
        {
          date: "2026-06-02",
          provider: "openai",
          model: "gpt-4",
          tokens: 40,
          cost: 0.004,
          count: 2,
        },
      ],
      dailyLatency: [
        { date: "2026-06-01", count: 3, avgMs: 100, minMs: 50, maxMs: 150, p95Ms: 140 },
        { date: "2026-06-02", count: 2, avgMs: 200, minMs: 100, maxMs: 300, p95Ms: 280 },
      ],
    });

    const result = buildAggregatesFromSessions([session], undefined, ["2026-06-02"]);

    // Messages should only count 2026-06-02
    expect(result.messages.total).toBe(4);
    expect(result.messages.user).toBe(2);
    expect(result.messages.assistant).toBe(2);
    expect(result.messages.errors).toBe(1);

    // Model usage should only count 2026-06-02
    expect(result.byModel).toHaveLength(1);
    expect(result.byModel[0].count).toBe(2);
    expect(result.byModel[0].totals.totalTokens).toBe(40);
    expect(result.byModel[0].totals.totalCost).toBe(0.004);

    // Daily arrays should only contain selected day
    expect(result.daily).toHaveLength(1);
    expect(result.daily[0].date).toBe("2026-06-02");
    expect(result.daily[0].tokens).toBe(40);

    expect(result.modelDaily).toHaveLength(1);
    expect(result.modelDaily[0].date).toBe("2026-06-02");

    // Agent/channel should only count selected day
    expect(result.byAgent).toHaveLength(1);
    expect(result.byAgent[0].totals.totalTokens).toBe(40);
    expect(result.byAgent[0].totals.totalCost).toBe(0.004);

    expect(result.byChannel).toHaveLength(1);
    expect(result.byChannel[0].totals.totalTokens).toBe(40);

    // Latency should only count selected day
    expect(result.latency).toBeDefined();
    expect(result.latency!.count).toBe(2);
    expect(result.latency!.avgMs).toBe(200);

    expect(result.dailyLatency).toHaveLength(1);
    expect(result.dailyLatency![0].date).toBe("2026-06-02");
  });

  it("aggregates across multiple sessions with selectedDays", () => {
    const session1 = makeSession({
      key: "session-1",
      dailyModelUsage: [
        {
          date: "2026-06-01",
          provider: "openai",
          model: "gpt-4",
          tokens: 100,
          cost: 0.01,
          count: 5,
        },
      ],
      dailyMessageCounts: [
        {
          date: "2026-06-01",
          total: 5,
          user: 3,
          assistant: 2,
          toolCalls: 1,
          toolResults: 1,
          errors: 0,
        },
      ],
      dailyBreakdown: [{ date: "2026-06-01", tokens: 100, cost: 0.01 }],
    });

    const session2 = makeSession({
      key: "session-2",
      dailyModelUsage: [
        {
          date: "2026-06-01",
          provider: "openai",
          model: "gpt-4",
          tokens: 50,
          cost: 0.005,
          count: 2,
        },
        {
          date: "2026-06-02",
          provider: "anthropic",
          model: "claude-sonnet",
          tokens: 80,
          cost: 0.008,
          count: 3,
        },
      ],
      dailyMessageCounts: [
        {
          date: "2026-06-01",
          total: 2,
          user: 1,
          assistant: 1,
          toolCalls: 0,
          toolResults: 0,
          errors: 0,
        },
        {
          date: "2026-06-02",
          total: 3,
          user: 2,
          assistant: 1,
          toolCalls: 1,
          toolResults: 1,
          errors: 0,
        },
      ],
      dailyBreakdown: [
        { date: "2026-06-01", tokens: 50, cost: 0.005 },
        { date: "2026-06-02", tokens: 80, cost: 0.008 },
      ],
    });

    const result = buildAggregatesFromSessions([session1, session2], undefined, ["2026-06-01"]);

    // Only 2026-06-01 counts across both sessions
    expect(result.messages.total).toBe(7); // 5 + 2
    expect(result.byModel).toHaveLength(1); // only openai/gpt-4 on 06-01
    expect(result.byModel[0].totals.totalTokens).toBe(150); // 100 + 50
    expect(result.daily).toHaveLength(1);
    expect(result.daily[0].date).toBe("2026-06-01");
    expect(result.daily[0].tokens).toBe(150);
  });

  it("returns fallback when sessions array is empty", () => {
    const fallback = {
      messages: { total: 99, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
      tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
      byModel: [],
      byProvider: [],
      byAgent: [],
      byChannel: [],
      daily: [],
    };

    const result = buildAggregatesFromSessions([], fallback, ["2026-06-01"]);
    expect(result.messages.total).toBe(99);
  });

  it("falls back to session-wide data when daily arrays are missing", () => {
    const session = makeSession({
      messageCounts: { total: 10, user: 5, assistant: 5, toolCalls: 2, toolResults: 2, errors: 1 },
      modelUsage: [
        {
          provider: "openai",
          model: "gpt-4",
          count: 5,
          totals: {
            totalTokens: 100,
            totalCost: 0.01,
            input: 50,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
            inputCost: 0,
            outputCost: 0.01,
            cacheReadCost: 0,
            cacheWriteCost: 0,
            missingCostEntries: 0,
          },
        },
      ],
      // No daily arrays — should fall back to session-wide totals
    });

    const result = buildAggregatesFromSessions([session], undefined, ["2026-06-01"]);

    // Falls back to session-wide since no daily arrays exist
    expect(result.messages.total).toBe(10);
    expect(result.byModel[0].totals.totalTokens).toBe(100);
  });

  it("filters multiple selected days correctly", () => {
    const session = makeSession({
      dailyModelUsage: [
        {
          date: "2026-06-01",
          provider: "openai",
          model: "gpt-4",
          tokens: 10,
          cost: 0.001,
          count: 1,
        },
        {
          date: "2026-06-02",
          provider: "openai",
          model: "gpt-4",
          tokens: 20,
          cost: 0.002,
          count: 1,
        },
        {
          date: "2026-06-03",
          provider: "openai",
          model: "gpt-4",
          tokens: 30,
          cost: 0.003,
          count: 1,
        },
      ],
      dailyMessageCounts: [
        {
          date: "2026-06-01",
          total: 1,
          user: 1,
          assistant: 0,
          toolCalls: 0,
          toolResults: 0,
          errors: 0,
        },
        {
          date: "2026-06-02",
          total: 2,
          user: 1,
          assistant: 1,
          toolCalls: 0,
          toolResults: 0,
          errors: 0,
        },
        {
          date: "2026-06-03",
          total: 3,
          user: 2,
          assistant: 1,
          toolCalls: 0,
          toolResults: 0,
          errors: 0,
        },
      ],
      dailyBreakdown: [
        { date: "2026-06-01", tokens: 10, cost: 0.001 },
        { date: "2026-06-02", tokens: 20, cost: 0.002 },
        { date: "2026-06-03", tokens: 30, cost: 0.003 },
      ],
    });

    const result = buildAggregatesFromSessions([session], undefined, ["2026-06-01", "2026-06-03"]);

    expect(result.messages.total).toBe(4); // 1 + 3
    expect(result.byModel[0].totals.totalTokens).toBe(40); // 10 + 30
    expect(result.daily).toHaveLength(2);
    expect(result.daily.map((d) => d.date)).toEqual(["2026-06-01", "2026-06-03"]);
  });
});
