/* @vitest-environment jsdom */

import { render } from "lit";
import type { TemplateResult } from "lit";
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

function renderUsageIntoContainer(template: TemplateResult) {
  const container = document.createElement("div");
  render(template, container);
  return container;
}

function getHeaderMetricTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".usage-header-metrics .usage-metric-badge")).map(
    (badge) => badge.textContent?.replace(/\s+/g, " ").trim() ?? "",
  );
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
    expect(agentSelect!.options[0]?.textContent).toBe("Default agent");
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

  it("computes selected-day totals from scoped session quarter-hour usage instead of unscoped costDaily", () => {
    const sessionTimestamp = Date.UTC(2026, 4, 14, 12, 0, 0);
    const container = renderUsageIntoContainer(
      renderUsage(
        createUsageProps({
          data: {
            loading: false,
            error: null,
            sessions: [
              {
                key: "agent:opus:main",
                label: "Opus session",
                agentId: "opus",
                updatedAt: sessionTimestamp,
                usage: {
                  input: 700,
                  output: 500,
                  cacheRead: 200,
                  cacheWrite: 100,
                  totalTokens: 1500,
                  totalCost: 8.88,
                  inputCost: 0,
                  outputCost: 0,
                  cacheReadCost: 0,
                  cacheWriteCost: 0,
                  missingCostEntries: 0,
                  activityDates: ["2026-05-14"],
                  dailyBreakdown: [{ date: "2026-05-14", tokens: 1500, cost: 8.88 }],
                  utcQuarterHourTokenUsage: [
                    {
                      date: "2026-05-14",
                      quarterIndex: 48,
                      input: 700,
                      output: 500,
                      cacheRead: 200,
                      cacheWrite: 100,
                      totalTokens: 1500,
                      totalCost: 8.88,
                    },
                  ],
                  messageCounts: {
                    total: 3,
                    user: 1,
                    assistant: 2,
                    toolCalls: 0,
                    toolResults: 0,
                    errors: 0,
                  },
                },
              },
            ],
            sessionsLimitReached: false,
            totals: {
              input: 9999,
              output: 9999,
              cacheRead: 9999,
              cacheWrite: 9999,
              totalTokens: 39996,
              totalCost: 99.99,
              inputCost: 0,
              outputCost: 0,
              cacheReadCost: 0,
              cacheWriteCost: 0,
              missingCostEntries: 0,
            },
            aggregates: {
              messages: {
                total: 3,
                user: 1,
                assistant: 2,
                toolCalls: 0,
                toolResults: 0,
                errors: 0,
              },
              tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
              byModel: [],
              byProvider: [],
              byAgent: [],
              byChannel: [],
              daily: [
                {
                  date: "2026-05-14",
                  tokens: 1500,
                  cost: 8.88,
                  messages: 3,
                  toolCalls: 0,
                  errors: 0,
                },
              ],
            },
            costDaily: [
              {
                date: "2026-05-14",
                input: 5000,
                output: 4000,
                cacheRead: 3000,
                cacheWrite: 2000,
                totalTokens: 14000,
                totalCost: 44.44,
                inputCost: 0,
                outputCost: 0,
                cacheReadCost: 0,
                cacheWriteCost: 0,
                missingCostEntries: 0,
              },
            ],
            cacheStatus: undefined,
            allAgentIds: ["main", "opus"],
          },
          filters: {
            startDate: "2026-05-14",
            endDate: "2026-05-14",
            scope: "family",
            usageAgentId: "opus",
            selectedSessions: [],
            selectedDays: ["2026-05-14"],
            selectedHours: [],
            query: "",
            queryDraft: "",
            timeZone: "utc",
          },
        }),
      ),
    );

    expect(getHeaderMetricTexts(container)).toEqual([
      "1.5K Tokens",
      "$8.88 Cost",
      "1 session",
    ]);
    expect(container.textContent).not.toContain("$44.44");
    expect(container.textContent).toContain("700");
    expect(container.textContent).toContain("500");
    expect(container.textContent).toContain("200");
    expect(container.textContent).toContain("100");
  });
});
