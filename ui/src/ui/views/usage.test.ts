/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderUsage } from "./usage.ts";
import type { UsageProps } from "./usageTypes.ts";

const noop = vi.fn();

function createUsageProps(overrides: Partial<UsageProps> = {}): UsageProps {
  return {
    data: {
      loading: false,
      error: null,
      sessions: [],
      sessionsLimitReached: false,
      totals: null,
      aggregates: null,
      costDaily: [],
      cacheStatus: undefined,
      allAgentIds: [],
    },
    filters: {
      startDate: "2026-05-14",
      endDate: "2026-05-14",
      scope: "family",
      usageAgentId: undefined,
      selectedSessions: [],
      selectedDays: [],
      selectedHours: [],
      query: "",
      queryDraft: "",
      timeZone: "local",
    },
    display: {
      chartMode: "tokens",
      dailyChartMode: "total",
      sessionSort: "tokens",
      sessionSortDir: "desc",
      recentSessions: [],
      sessionsTab: "all",
      visibleColumns: [],
      contextExpanded: false,
      headerPinned: false,
    },
    detail: {
      timeSeriesMode: "cumulative",
      timeSeriesBreakdownMode: "total",
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
        onStartDateChange: noop,
        onEndDateChange: noop,
        onScopeChange: noop,
        onRefresh: noop,
        onAgentChange: noop,
        onTimeZoneChange: noop,
        onToggleHeaderPinned: noop,
        onSelectDay: noop,
        onSelectHour: noop,
        onClearDays: noop,
        onClearHours: noop,
        onClearSessions: noop,
        onClearFilters: noop,
        onQueryDraftChange: noop,
        onApplyQuery: noop,
        onClearQuery: noop,
      },
      display: {
        onChartModeChange: noop,
        onDailyChartModeChange: noop,
        onSessionSortChange: noop,
        onSessionSortDirChange: noop,
        onSessionsTabChange: noop,
        onToggleColumn: noop,
      },
      details: {
        onToggleContextExpanded: noop,
        onToggleSessionLogsExpanded: noop,
        onLogFilterRolesChange: noop,
        onLogFilterToolsChange: noop,
        onLogFilterHasToolsChange: noop,
        onLogFilterQueryChange: noop,
        onLogFilterClear: noop,
        onSelectSession: noop,
        onTimeSeriesModeChange: noop,
        onTimeSeriesBreakdownChange: noop,
        onTimeSeriesCursorRangeChange: noop,
      },
    },
    ...overrides,
  };
}

describe("renderUsage", () => {
  it("omits the duplicate inner page heading because the shell owns tab headings", () => {
    const container = document.createElement("div");

    render(renderUsage(createUsageProps()), container);

    expect(container.querySelector(".usage-page-header")).toBeNull();
    expect(container.querySelector(".usage-page-title")).toBeNull();
    expect(container.querySelector(".usage-header")).not.toBeNull();
  });

  it("renders agent selector dropdown from configured allAgentIds", () => {
    const container = document.createElement("div");

    render(
      renderUsage(
        createUsageProps({
          data: {
            loading: false,
            error: null,
            sessions: [],
            sessionsLimitReached: false,
            totals: null,
            aggregates: null,
            costDaily: [],
            cacheStatus: undefined,
            allAgentIds: ["main", "opus"],
          },
        }),
      ),
      container,
    );

    const agentSelect = container.querySelector(
      'select[aria-label="Agent"]',
    ) as HTMLSelectElement | null;
    expect(agentSelect).not.toBeNull();
    const optionValues = Array.from(agentSelect!.options).map((o) => o.value);
    expect(optionValues).toContain("");
    expect(optionValues).toContain("main");
    expect(optionValues).toContain("opus");
    expect(agentSelect!.value).toBe("");
  });

  it("shows selected usageAgentId in agent selector", () => {
    const container = document.createElement("div");

    render(
      renderUsage(
        createUsageProps({
          filters: {
            startDate: "2026-05-14",
            endDate: "2026-05-14",
            scope: "family",
            usageAgentId: "opus",
            selectedSessions: [],
            selectedDays: [],
            selectedHours: [],
            query: "",
            queryDraft: "",
            timeZone: "local",
          },
          data: {
            loading: false,
            error: null,
            sessions: [],
            sessionsLimitReached: false,
            totals: null,
            aggregates: null,
            costDaily: [],
            cacheStatus: undefined,
            allAgentIds: ["main", "opus"],
          },
        }),
      ),
      container,
    );

    const agentSelect = container.querySelector(
      'select[aria-label="Agent"]',
    ) as HTMLSelectElement | null;
    expect(agentSelect).not.toBeNull();
    expect(agentSelect!.value).toBe("opus");
  });
});
