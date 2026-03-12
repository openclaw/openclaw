import { describe, expect, it } from "vitest";
import { buildAggregatesFromSessions, buildPeakErrorHours } from "./usage-metrics.ts";
import type { UsageSessionEntry } from "./usageTypes.ts";

function makeSession(
  usage: NonNullable<UsageSessionEntry["usage"]>,
  overrides: Partial<UsageSessionEntry> = {},
): UsageSessionEntry {
  return {
    key: overrides.key ?? "session-1",
    label: overrides.label ?? "Session 1",
    updatedAt: overrides.updatedAt ?? 0,
    agentId: overrides.agentId ?? "main",
    channel: overrides.channel ?? "web",
    usage,
    ...overrides,
  } as UsageSessionEntry;
}

describe("buildAggregatesFromSessions", () => {
  it("falls back to dailyMessageCounts when messageCounts is missing", () => {
    const aggregates = buildAggregatesFromSessions([
      makeSession({
        totalTokens: 2400,
        totalCost: 0,
        input: 1200,
        output: 1200,
        cacheRead: 0,
        cacheWrite: 0,
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        missingCostEntries: 0,
        dailyMessageCounts: [
          {
            date: "2026-03-01",
            total: 7,
            user: 3,
            assistant: 2,
            toolCalls: 2,
            toolResults: 1,
            errors: 1,
          },
          {
            date: "2026-03-02",
            total: 5,
            user: 1,
            assistant: 1,
            toolCalls: 1,
            toolResults: 2,
            errors: 0,
          },
        ],
      }),
    ]);

    expect(aggregates.messages.total).toBe(12);
    expect(aggregates.messages.user).toBe(4);
    expect(aggregates.messages.assistant).toBe(3);
    expect(aggregates.messages.toolCalls).toBe(3);
    expect(aggregates.messages.toolResults).toBe(3);
    expect(aggregates.messages.errors).toBe(1);
  });

  it("prefers messageCounts when both messageCounts and dailyMessageCounts exist", () => {
    const aggregates = buildAggregatesFromSessions([
      makeSession({
        totalTokens: 1000,
        totalCost: 0,
        input: 400,
        output: 600,
        cacheRead: 0,
        cacheWrite: 0,
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        missingCostEntries: 0,
        messageCounts: {
          total: 4,
          user: 2,
          assistant: 2,
          toolCalls: 1,
          toolResults: 3,
          errors: 1,
        },
        dailyMessageCounts: [
          {
            date: "2026-03-01",
            total: 9,
            user: 0,
            assistant: 0,
            toolCalls: 5,
            toolResults: 0,
            errors: 4,
          },
        ],
      }),
    ]);

    expect(aggregates.messages.total).toBe(4);
    expect(aggregates.messages.user).toBe(2);
    expect(aggregates.messages.assistant).toBe(2);
    expect(aggregates.messages.toolCalls).toBe(1);
    expect(aggregates.messages.toolResults).toBe(3);
    expect(aggregates.messages.errors).toBe(1);
  });
});

describe("buildPeakErrorHours", () => {
  it("uses dailyMessageCounts fallback when messageCounts is missing", () => {
    const peakHours = buildPeakErrorHours(
      [
        makeSession({
          totalTokens: 1000,
          totalCost: 0,
          input: 400,
          output: 600,
          cacheRead: 0,
          cacheWrite: 0,
          inputCost: 0,
          outputCost: 0,
          cacheReadCost: 0,
          cacheWriteCost: 0,
          missingCostEntries: 0,
          firstActivity: Date.UTC(2026, 2, 1, 10, 0, 0),
          lastActivity: Date.UTC(2026, 2, 1, 10, 30, 0),
          dailyMessageCounts: [
            {
              date: "2026-03-01",
              total: 10,
              user: 3,
              assistant: 4,
              toolCalls: 2,
              toolResults: 1,
              errors: 2,
            },
          ],
        }),
      ],
      "utc",
    );

    expect(peakHours).toHaveLength(1);
    expect(peakHours[0]?.value).toBe("20.00%");
    expect(peakHours[0]?.sub).toContain("2");
    expect(peakHours[0]?.sub).toContain("10");
  });
});
