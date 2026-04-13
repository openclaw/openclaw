import { describe, expect, it } from "vitest";
import { buildAggregatesFromSessions, buildUsageInsightStats } from "./usage-metrics.ts";
import type { UsageAggregates, UsageSessionEntry, UsageTotals } from "./usageTypes.ts";

function createTotals(overrides: Partial<UsageTotals> = {}): UsageTotals {
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
    ...overrides,
  };
}

function createAggregates(): UsageAggregates {
  return {
    messages: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
    tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
    byModel: [],
    byProvider: [],
    byAgent: [],
    byChannel: [],
    daily: [],
  };
}

function createSession(
  key: string,
  agentId: string,
  channel: string,
  usageOverrides: Partial<NonNullable<UsageSessionEntry["usage"]>> = {},
): UsageSessionEntry {
  return {
    key,
    agentId,
    channel,
    usage: {
      ...createTotals(),
      durationMs: 60_000,
      firstActivity: 1,
      lastActivity: 60_001,
      messageCounts: { total: 1, user: 0, assistant: 1, toolCalls: 0, toolResults: 0, errors: 0 },
      ...usageOverrides,
    },
  };
}

describe("usage metrics helpers", () => {
  it("ranks agents by tokens when all aggregate costs are zero", () => {
    const aggregates = buildAggregatesFromSessions([
      createSession("alpha", "alpha", "webchat", { totalTokens: 10, totalCost: 0 }),
      createSession("beta", "beta", "feishu", { totalTokens: 100, totalCost: 0 }),
    ]);

    expect(aggregates.byAgent.map((entry) => entry.agentId)).toEqual(["beta", "alpha"]);
  });

  it("uses the provided overview duration scope for throughput calculations", () => {
    const sessions = [
      createSession("session-1", "main", "webchat", {
        totalTokens: 600,
        totalCost: 6,
        durationMs: 60_000,
      }),
    ];

    const stats = buildUsageInsightStats(
      sessions,
      createTotals({ totalTokens: 600, totalCost: 6 }),
      createAggregates(),
      {
        durationCount: 2,
        durationSumMs: 120_000,
      },
    );

    expect(stats.durationCount).toBe(2);
    expect(stats.durationSumMs).toBe(120_000);
    expect(stats.avgDurationMs).toBe(60_000);
    expect(stats.throughputTokensPerMin).toBe(300);
    expect(stats.throughputCostPerMin).toBe(3);
  });
});