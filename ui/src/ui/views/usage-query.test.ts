import { describe, expect, it } from "vitest";
import { buildDailyCsv, buildSessionsCsv } from "./usage-query.ts";
import type { CostDailyEntry, UsageSessionEntry } from "./usageTypes.ts";

function createSession(overrides: Partial<UsageSessionEntry> = {}): UsageSessionEntry {
  return {
    key: "session-1",
    label: "Friendly label",
    agentId: "agent-1",
    channel: "discord",
    modelProvider: "openai",
    model: "gpt-5",
    updatedAt: Date.UTC(2026, 2, 13, 8, 0, 0),
    usage: {
      durationMs: 1234,
      totalCost: 1.25,
      totalTokens: 30,
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      inputCost: 0.5,
      outputCost: 0.75,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
      messageCounts: {
        total: 2,
        user: 1,
        assistant: 1,
        toolCalls: 0,
        toolResults: 0,
        errors: 0,
      },
      modelUsage: [],
      toolUsage: {
        totalCalls: 0,
        uniqueTools: 0,
        tools: [],
      },
    },
    ...overrides,
  };
}

function createDailyEntry(overrides: Partial<CostDailyEntry> = {}): CostDailyEntry {
  return {
    date: "2026-03-13",
    input: 10,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 30,
    totalCost: 1.25,
    inputCost: 0.5,
    outputCost: 0.75,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
    ...overrides,
  };
}

describe("usage query csv export", () => {
  it("neutralizes spreadsheet formula prefixes in session text fields", () => {
    const csv = buildSessionsCsv([
      createSession({
        key: "=1+1",
        label: "=SUM(1,2)",
        agentId: "@agent",
        channel: "+channel",
        modelProvider: "-provider",
        model: '\t=HYPERLINK("https://example.com")',
      }),
    ]);

    const [, row] = csv.split("\n");
    expect(row).toContain("'=1+1");
    expect(row).toContain('"\'=SUM(1,2)"');
    expect(row).toContain("'@agent");
    expect(row).toContain("'+channel");
    expect(row).toContain("'-provider");
    expect(row).toContain('\'\t=HYPERLINK(""https://example.com"")');
  });

  it("keeps numeric values unchanged when exporting daily usage", () => {
    const csv = buildDailyCsv([
      createDailyEntry({
        input: -5,
        totalTokens: -5,
        totalCost: -1.5,
      }),
    ]);

    const [, row] = csv.split("\n");
    const columns = row.split(",");
    expect(columns[1]).toBe("-5");
    expect(columns[5]).toBe("-5");
    expect(columns[10]).toBe("-1.5");
  });
});
