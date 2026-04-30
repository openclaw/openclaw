import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __test, buildPeakErrorHours } from "./usage-metrics.ts";
import { renderUsage } from "./usage.ts";
import type { UsageColumnId, UsageSessionEntry } from "./usageTypes.ts";

const ORIGINAL_TZ = process.env.TZ;

function makeSession(startIso: string, endIso: string): UsageSessionEntry {
  const firstActivity = new Date(startIso).getTime();
  const lastActivity = new Date(endIso).getTime();
  return {
    key: `${startIso}-${endIso}`,
    updatedAt: lastActivity,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 100,
      totalCost: 1,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
      firstActivity,
      lastActivity,
      durationMs: lastActivity - firstActivity,
      messageCounts: {
        total: 100,
        user: 50,
        assistant: 50,
        toolCalls: 0,
        toolResults: 0,
        errors: 10,
      },
    },
  };
}

function makeUsageProps(sessions: UsageSessionEntry[], selectedHours: number[] = []) {
  const totals = sessions.reduce(
    (acc, session) => {
      const usage = session.usage;
      if (!usage) {
        return acc;
      }
      acc.input += usage.input;
      acc.output += usage.output;
      acc.cacheRead += usage.cacheRead;
      acc.cacheWrite += usage.cacheWrite;
      acc.totalTokens += usage.totalTokens;
      acc.totalCost += usage.totalCost;
      acc.inputCost += usage.inputCost;
      acc.outputCost += usage.outputCost;
      acc.cacheReadCost += usage.cacheReadCost;
      acc.cacheWriteCost += usage.cacheWriteCost;
      acc.missingCostEntries += usage.missingCostEntries;
      return acc;
    },
    {
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
    },
  );

  return {
    data: {
      loading: false,
      error: null,
      sessions,
      sessionsLimitReached: false,
      totals,
      aggregates: {
        messages: {
          total: 100,
          user: 50,
          assistant: 50,
          toolCalls: 0,
          toolResults: 0,
          errors: 10,
        },
        tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
        byModel: [],
        byProvider: [],
        byAgent: [],
        byChannel: [],
        daily: [],
      },
      costDaily: [],
    },
    filters: {
      startDate: "2026-04-05",
      endDate: "2026-04-05",
      selectedSessions: [],
      selectedDays: [],
      selectedHours,
      query: "",
      queryDraft: "",
      timeZone: "local" as const,
    },
    display: {
      chartMode: "tokens" as const,
      dailyChartMode: "total" as const,
      sessionSort: "tokens" as const,
      sessionSortDir: "desc" as const,
      recentSessions: [],
      sessionsTab: "all" as const,
      visibleColumns: [
        "channel",
        "agent",
        "provider",
        "model",
        "messages",
        "tools",
        "errors",
        "duration",
      ] as UsageColumnId[],
      contextExpanded: false,
      headerPinned: false,
    },
    detail: {
      timeSeriesMode: "cumulative" as const,
      timeSeriesBreakdownMode: "total" as const,
      timeSeries: null,
      timeSeriesLoading: false,
      timeSeriesCursorStart: null,
      timeSeriesCursorEnd: null,
      sessionLogs: null,
      sessionLogsLoading: false,
      sessionLogsExpanded: false,
      logFilters: {
        roles: [],
        tools: [],
        hasTools: false,
        query: "",
      },
    },
    callbacks: {
      filters: {
        onStartDateChange() {},
        onEndDateChange() {},
        onRefresh() {},
        onTimeZoneChange() {},
        onToggleHeaderPinned() {},
        onSelectDay() {},
        onSelectHour() {},
        onClearDays() {},
        onClearHours() {},
        onClearSessions() {},
        onClearFilters() {},
        onQueryDraftChange() {},
        onApplyQuery() {},
        onClearQuery() {},
      },
      display: {
        onChartModeChange() {},
        onDailyChartModeChange() {},
        onSessionSortChange() {},
        onSessionSortDirChange() {},
        onSessionsTabChange() {},
        onToggleColumn() {},
      },
      details: {
        onToggleContextExpanded() {},
        onToggleSessionLogsExpanded() {},
        onLogFilterRolesChange() {},
        onLogFilterToolsChange() {},
        onLogFilterHasToolsChange() {},
        onLogFilterQueryChange() {},
        onLogFilterClear() {},
        onSelectSession() {},
        onTimeSeriesModeChange() {},
        onTimeSeriesBreakdownChange() {},
        onTimeSeriesCursorRangeChange() {},
      },
    },
  };
}

describe("usage DST hour boundaries", () => {
  beforeEach(() => {
    process.env.TZ = "Australia/Sydney";
  });

  afterEach(() => {
    if (ORIGINAL_TZ === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = ORIGINAL_TZ;
    }
  });

  it("moves forward through the repeated hour at DST fallback", () => {
    const current = new Date("2026-04-05T02:00:00+10:00");
    const next = __test.getNextHourStart(current, "local");

    expect(next.getTime()).toBeGreaterThan(current.getTime());
    expect(next.getTime()).toBe(new Date("2026-04-05T03:00:00+10:00").getTime());
  });

  it("skips the missing hour at DST spring forward", () => {
    const current = new Date("2026-10-04T01:30:00+10:00");
    const next = __test.getNextHourStart(current, "local");

    expect(next.getTime()).toBe(new Date("2026-10-04T03:00:00+11:00").getTime());
  });

  it(
    "builds peak error stats for sessions that span the fallback rollover",
    { timeout: 1_000 },
    () => {
      const stats = buildPeakErrorHours(
        [makeSession("2026-04-05T02:30:00+11:00", "2026-04-05T02:30:00+10:00")],
        "local",
      );

      // Vitest runs this file in a worker thread, so runtime TZ changes are not
      // guaranteed to alter the worker's local timezone on every host. The same
      // instant range can appear as one Sydney repeated-hour bucket or two
      // ordinary buckets elsewhere, but every bucket must preserve the rate.
      expect(stats.length).toBeGreaterThan(0);
      expect(stats.length).toBeLessThanOrEqual(2);
      expect(stats.every((entry) => entry.value === "10.00%")).toBe(true);
    },
  );

  it(
    "renders the usage view with an hour filter across the fallback rollover",
    { timeout: 1_000 },
    () => {
      const result = renderUsage(
        makeUsageProps(
          [makeSession("2026-04-05T02:30:00+11:00", "2026-04-05T02:30:00+10:00")],
          [2],
        ),
      );

      expect(result).toBeTruthy();
    },
  );
});
