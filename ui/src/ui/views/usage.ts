import { html, nothing } from "lit";
import { extractQueryTerms, filterSessionsByQuery } from "../usage-helpers.ts";
import {
  buildAggregatesFromSessions,
  buildPeakErrorHours,
  buildUsageInsightStats,
  formatCost,
  formatIsoDate,
  formatTokens,
  getZonedHour,
  renderUsageMosaic,
  setToHourEnd,
} from "./usage-metrics.ts";
import {
  addQueryToken,
  applySuggestionToQuery,
  buildDailyCsv,
  buildQuerySuggestions,
  buildSessionsCsv,
  downloadTextFile,
  normalizeQueryText,
  removeQueryToken,
  setQueryTokensForKey,
} from "./usage-query.ts";
import { renderEmptyDetailState, renderSessionDetailPanel } from "./usage-render-details.ts";
import {
  renderCostBreakdownCompact,
  renderDailyChartCompact,
  renderFilterChips,
  renderSessionsCard,
  renderUsageInsights,
} from "./usage-render-overview.ts";
import { usageStylesString } from "./usageStyles.ts";
import {
  SessionLogEntry,
  SessionLogRole,
  UsageColumnId,
  UsageProps,
  UsageSessionEntry,
  UsageTotals,
} from "./usageTypes.ts";

export type { UsageColumnId, SessionLogEntry, SessionLogRole };

export function renderUsage(props: UsageProps) {
  // Show loading skeleton if loading and no data yet
  if (props.loading && !props.totals) {
    // Use inline styles since main stylesheet hasn't loaded yet on initial render
    return html`
      <style>
        @keyframes initial-spin {
          to { transform: rotate(360deg); }
        }
        @keyframes initial-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.7; }
        }
      </style>
      <section class="card">
        <div class="row" style="justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px;">
          <div style="flex: 1; min-width: 250px;">
            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 2px;">
              <div class="card-title" style="margin: 0;">Token Usage</div>
              <span style="
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 4px 10px;
                background: rgba(255, 77, 77, 0.1);
                border-radius: 4px;
                font-size: 12px;
                color: #ff4d4d;
              ">
                <span style="
                  width: 10px;
                  height: 10px;
                  border: 2px solid #ff4d4d;
                  border-top-color: transparent;
                  border-radius: 50%;
                  animation: initial-spin 0.6s linear infinite;
                "></span>
                Loading
              </span>
            </div>
          </div>
          <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 8px;">
            <div style="display: flex; gap: 8px; align-items: center;">
              <input type="date" .value=${props.startDate} disabled style="padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font-size: 13px; opacity: 0.6;" />
              <span style="color: var(--muted);">to</span>
              <input type="date" .value=${props.endDate} disabled style="padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font-size: 13px; opacity: 0.6;" />
            </div>
          </div>
        </div>
      </section>
    `;
  }

  const isTokenMode = props.chartMode === "tokens";
  const hasQuery = props.query.trim().length > 0;
  const hasDraftQuery = props.queryDraft.trim().length > 0;
  // (intentionally no global Clear button in the header; chips + query clear handle this)

  // Sort sessions by tokens or cost depending on mode
  const sortedSessions = [...props.sessions].toSorted((a, b) => {
    const valA = isTokenMode ? (a.usage?.totalTokens ?? 0) : (a.usage?.totalCost ?? 0);
    const valB = isTokenMode ? (b.usage?.totalTokens ?? 0) : (b.usage?.totalCost ?? 0);
    return valB - valA;
  });

  // Filter sessions by selected days
  const dayFilteredSessions =
    props.selectedDays.length > 0
      ? sortedSessions.filter((s) => {
          if (s.usage?.activityDates?.length) {
            return s.usage.activityDates.some((d) => props.selectedDays.includes(d));
          }
          if (!s.updatedAt) {
            return false;
          }
          const d = new Date(s.updatedAt);
          const sessionDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          return props.selectedDays.includes(sessionDate);
        })
      : sortedSessions;

  const sessionTouchesHours = (session: UsageSessionEntry, hours: number[]): boolean => {
    if (hours.length === 0) {
      return true;
    }
    const usage = session.usage;
    const start = usage?.firstActivity ?? session.updatedAt;
    const end = usage?.lastActivity ?? session.updatedAt;
    if (!start || !end) {
      return false;
    }
    const startMs = Math.min(start, end);
    const endMs = Math.max(start, end);
    let cursor = startMs;
    while (cursor <= endMs) {
      const date = new Date(cursor);
      const hour = getZonedHour(date, props.timeZone);
      if (hours.includes(hour)) {
        return true;
      }
      const nextHour = setToHourEnd(date, props.timeZone);
      const nextMs = Math.min(nextHour.getTime(), endMs);
      cursor = nextMs + 1;
    }
    return false;
  };

  const hourFilteredSessions =
    props.selectedHours.length > 0
      ? dayFilteredSessions.filter((s) => sessionTouchesHours(s, props.selectedHours))
      : dayFilteredSessions;

  // Filter sessions by query (client-side)
  const queryResult = filterSessionsByQuery(hourFilteredSessions, props.query);
  const filteredSessions = queryResult.sessions;
  const queryWarnings = queryResult.warnings;
  const querySuggestions = buildQuerySuggestions(
    props.queryDraft,
    sortedSessions,
    props.aggregates,
  );
  const queryTerms = extractQueryTerms(props.query);
  const selectedValuesFor = (key: string): string[] => {
    const normalized = normalizeQueryText(key);
    return queryTerms
      .filter((term) => normalizeQueryText(term.key ?? "") === normalized)
      .map((term) => term.value)
      .filter(Boolean);
  };
  const unique = (items: Array<string | undefined>) => {
    const set = new Set<string>();
    for (const item of items) {
      if (item) {
        set.add(item);
      }
    }
    return Array.from(set);
  };
  const agentOptions = unique(sortedSessions.map((s) => s.agentId)).slice(0, 12);
  const channelOptions = unique(sortedSessions.map((s) => s.channel)).slice(0, 12);
  const providerOptions = unique([
    ...sortedSessions.map((s) => s.modelProvider),
    ...sortedSessions.map((s) => s.providerOverride),
    ...(props.aggregates?.byProvider.map((entry) => entry.provider) ?? []),
  ]).slice(0, 12);
  const modelOptions = unique([
    ...sortedSessions.map((s) => s.model),
    ...(props.aggregates?.byModel.map((entry) => entry.model) ?? []),
  ]).slice(0, 12);
  const toolOptions = unique(props.aggregates?.tools.tools.map((tool) => tool.name) ?? []).slice(
    0,
    12,
  );

  // Get first selected session for detail view (timeseries, logs)
  const primarySelectedEntry =
    props.selectedSessions.length === 1
      ? (props.sessions.find((s) => s.key === props.selectedSessions[0]) ??
        filteredSessions.find((s) => s.key === props.selectedSessions[0]))
      : null;

  // Compute totals from sessions
  const computeSessionTotals = (sessions: UsageSessionEntry[]): UsageTotals => {
    return sessions.reduce(
      (acc, s) => {
        if (s.usage) {
          acc.input += s.usage.input;
          acc.output += s.usage.output;
          acc.cacheRead += s.usage.cacheRead;
          acc.cacheWrite += s.usage.cacheWrite;
          acc.totalTokens += s.usage.totalTokens;
          acc.totalCost += s.usage.totalCost;
          acc.inputCost += s.usage.inputCost ?? 0;
          acc.outputCost += s.usage.outputCost ?? 0;
          acc.cacheReadCost += s.usage.cacheReadCost ?? 0;
          acc.cacheWriteCost += s.usage.cacheWriteCost ?? 0;
          acc.missingCostEntries += s.usage.missingCostEntries ?? 0;
        }
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
  };

  // Compute totals from daily data for selected days (more accurate than session totals)
  const computeDailyTotals = (days: string[]): UsageTotals => {
    const matchingDays = props.costDaily.filter((d) => days.includes(d.date));
    return matchingDays.reduce(
      (acc, d) => {
        acc.input += d.input;
        acc.output += d.output;
        acc.cacheRead += d.cacheRead;
        acc.cacheWrite += d.cacheWrite;
        acc.totalTokens += d.totalTokens;
        acc.totalCost += d.totalCost;
        acc.inputCost += d.inputCost ?? 0;
        acc.outputCost += d.outputCost ?? 0;
        acc.cacheReadCost += d.cacheReadCost ?? 0;
        acc.cacheWriteCost += d.cacheWriteCost ?? 0;
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
  };

  // Compute display totals and count based on filters
  let displayTotals: UsageTotals | null;
  let displaySessionCount: number;
  const totalSessions = sortedSessions.length;

  if (props.selectedSessions.length > 0) {
    // Sessions selected - compute totals from selected sessions
    const selectedSessionEntries = filteredSessions.filter((s) =>
      props.selectedSessions.includes(s.key),
    );
    displayTotals = computeSessionTotals(selectedSessionEntries);
    displaySessionCount = selectedSessionEntries.length;
  } else if (props.selectedDays.length > 0 && props.selectedHours.length === 0) {
    // Days selected - use daily aggregates for accurate per-day totals
    displayTotals = computeDailyTotals(props.selectedDays);
    displaySessionCount = filteredSessions.length;
  } else if (props.selectedHours.length > 0) {
    displayTotals = computeSessionTotals(filteredSessions);
    displaySessionCount = filteredSessions.length;
  } else if (hasQuery) {
    displayTotals = computeSessionTotals(filteredSessions);
    displaySessionCount = filteredSessions.length;
  } else {
    // No filters - show all
    displayTotals = props.totals;
    displaySessionCount = totalSessions;
  }

  const aggregateSessions =
    props.selectedSessions.length > 0
      ? filteredSessions.filter((s) => props.selectedSessions.includes(s.key))
      : hasQuery || props.selectedHours.length > 0
        ? filteredSessions
        : props.selectedDays.length > 0
          ? dayFilteredSessions
          : sortedSessions;
  const activeAggregates = buildAggregatesFromSessions(aggregateSessions, props.aggregates);

  // Filter daily chart data if sessions are selected
  const filteredDaily =
    props.selectedSessions.length > 0
      ? (() => {
          const selectedEntries = filteredSessions.filter((s) =>
            props.selectedSessions.includes(s.key),
          );
          const allActivityDates = new Set<string>();
          for (const entry of selectedEntries) {
            for (const date of entry.usage?.activityDates ?? []) {
              allActivityDates.add(date);
            }
          }
          return allActivityDates.size > 0
            ? props.costDaily.filter((d) => allActivityDates.has(d.date))
            : props.costDaily;
        })()
      : props.costDaily;

  const insightStats = buildUsageInsightStats(aggregateSessions, displayTotals, activeAggregates);
  const isEmpty = !props.loading && !props.totals && props.sessions.length === 0;
  const hasMissingCost =
    (displayTotals?.missingCostEntries ?? 0) > 0 ||
    (displayTotals
      ? displayTotals.totalTokens > 0 &&
        displayTotals.totalCost === 0 &&
        displayTotals.input +
          displayTotals.output +
          displayTotals.cacheRead +
          displayTotals.cacheWrite >
          0
      : false);
  const datePresets = [
    { label: "Today", days: 1 },
    { label: "7d", days: 7 },
    { label: "30d", days: 30 },
  ];
  const applyPreset = (days: number) => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - (days - 1));
    props.onStartDateChange(formatIsoDate(start));
    props.onEndDateChange(formatIsoDate(end));
  };
  const renderFilterSelect = (key: string, label: string, options: string[]) => {
    if (options.length === 0) {
      return nothing;
    }
    const selected = selectedValuesFor(key);
    const selectedSet = new Set(selected.map((value) => normalizeQueryText(value)));
    const allSelected =
      options.length > 0 && options.every((value) => selectedSet.has(normalizeQueryText(value)));
    const selectedCount = selected.length;
    return html`
      <details
        class="usage-filter-select"
        @toggle=${(e: Event) => {
          const el = e.currentTarget as HTMLDetailsElement;
          if (!el.open) {
            return;
          }
          const onClick = (ev: MouseEvent) => {
            const path = ev.composedPath();
            if (!path.includes(el)) {
              el.open = false;
              window.removeEventListener("click", onClick, true);
            }
          };
          window.addEventListener("click", onClick, true);
        }}
      >
        <summary>
          <span>${label}</span>
          ${
            selectedCount > 0
              ? html`<span class="usage-filter-badge">${selectedCount}</span>`
              : html`
                  <span class="usage-filter-badge">All</span>
                `
          }
        </summary>
        <div class="usage-filter-popover">
          <div class="usage-filter-actions">
            <button
              class="btn btn-sm"
              @click=${(e: Event) => {
                e.preventDefault();
                e.stopPropagation();
                props.onQueryDraftChange(setQueryTokensForKey(props.queryDraft, key, options));
              }}
              ?disabled=${allSelected}
            >
              Select All
            </button>
            <button
              class="btn btn-sm"
              @click=${(e: Event) => {
                e.preventDefault();
                e.stopPropagation();
                props.onQueryDraftChange(setQueryTokensForKey(props.queryDraft, key, []));
              }}
              ?disabled=${selectedCount === 0}
            >
              Clear
            </button>
          </div>
          <div class="usage-filter-options">
            ${options.map((value) => {
              const checked = selectedSet.has(normalizeQueryText(value));
              return html`
                <label class="usage-filter-option">
                  <input
                    type="checkbox"
                    .checked=${checked}
                    @change=${(e: Event) => {
                      const target = e.target as HTMLInputElement;
                      const token = `${key}:${value}`;
                      props.onQueryDraftChange(
                        target.checked
                          ? addQueryToken(props.queryDraft, token)
                          : removeQueryToken(props.queryDraft, token),
                      );
                    }}
                  />
                  <span>${value}</span>
                </label>
              `;
            })}
          </div>
        </div>
      </details>
    `;
  };
  const exportStamp = formatIsoDate(new Date());

  return html`
    <style>${usageStylesString}</style>

    <section class="usage-page-header">
      <div class="usage-page-title">Usage</div>
      <div class="usage-page-subtitle">See where tokens go, when sessions spike, and what drives cost.</div>
    </section>

    <section class="card usage-header ${props.headerPinned ? "pinned" : ""}">
      <div class="usage-header-row">
        <div class="usage-header-title">
          <div class="card-title" style="margin: 0;">Filters</div>
          ${
            props.loading
              ? html`
                  <span class="usage-refresh-indicator">Loading</span>
                `
              : nothing
          }
          ${
            isEmpty
              ? html`
                  <span class="usage-query-hint">Select a date range and click Refresh to load usage.</span>
                `
              : nothing
          }
        </div>
        <div class="usage-header-metrics">
          ${
            displayTotals
              ? html`
                <span class="usage-metric-badge">
                  <strong>${formatTokens(displayTotals.totalTokens)}</strong> tokens
                </span>
                <span class="usage-metric-badge">
                  <strong>${formatCost(displayTotals.totalCost)}</strong> cost
                </span>
                <span class="usage-metric-badge">
                  <strong>${displaySessionCount}</strong>
                  session${displaySessionCount !== 1 ? "s" : ""}
                </span>
              `
              : nothing
          }
          <button
            class="usage-pin-btn ${props.headerPinned ? "active" : ""}"
            title=${props.headerPinned ? "Unpin filters" : "Pin filters"}
            @click=${props.onToggleHeaderPinned}
          >
            ${props.headerPinned ? "Pinned" : "Pin"}
          </button>
          <details
            class="usage-export-menu"
            @toggle=${(e: Event) => {
              const el = e.currentTarget as HTMLDetailsElement;
              if (!el.open) {
                return;
              }
              const onClick = (ev: MouseEvent) => {
                const path = ev.composedPath();
                if (!path.includes(el)) {
                  el.open = false;
                  window.removeEventListener("click", onClick, true);
                }
              };
              window.addEventListener("click", onClick, true);
            }}
          >
            <summary class="usage-export-button">Export ▾</summary>
            <div class="usage-export-popover">
              <div class="usage-export-list">
                <button
                  class="usage-export-item"
                  @click=${() =>
                    downloadTextFile(
                      `openclaw-usage-sessions-${exportStamp}.csv`,
                      buildSessionsCsv(filteredSessions),
                      "text/csv",
                    )}
                  ?disabled=${filteredSessions.length === 0}
                >
                  Sessions CSV
                </button>
                <button
                  class="usage-export-item"
                  @click=${() =>
                    downloadTextFile(
                      `openclaw-usage-daily-${exportStamp}.csv`,
                      buildDailyCsv(filteredDaily),
                      "text/csv",
                    )}
                  ?disabled=${filteredDaily.length === 0}
                >
                  Daily CSV
                </button>
                <button
                  class="usage-export-item"
                  @click=${() =>
                    downloadTextFile(
                      `openclaw-usage-${exportStamp}.json`,
                      JSON.stringify(
                        {
                          totals: displayTotals,
                          sessions: filteredSessions,
                          daily: filteredDaily,
                          aggregates: activeAggregates,
                        },
                        null,
                        2,
                      ),
                      "application/json",
                    )}
                  ?disabled=${filteredSessions.length === 0 && filteredDaily.length === 0}
                >
                  JSON
                </button>
              </div>
            </div>
          </details>
        </div>
      </div>
      <div class="usage-header-row">
        <div class="usage-controls">
          ${renderFilterChips(
            props.selectedDays,
            props.selectedHours,
            props.selectedSessions,
            props.sessions,
            props.onClearDays,
            props.onClearHours,
            props.onClearSessions,
            props.onClearFilters,
          )}
          <div class="usage-presets">
            ${datePresets.map(
              (preset) => html`
                <button class="btn btn-sm" @click=${() => applyPreset(preset.days)}>
                  ${preset.label}
                </button>
              `,
            )}
          </div>
          <input
            type="date"
            .value=${props.startDate}
            title="Start Date"
            @change=${(e: Event) => props.onStartDateChange((e.target as HTMLInputElement).value)}
          />
          <span style="color: var(--muted);">to</span>
          <input
            type="date"
            .value=${props.endDate}
            title="End Date"
            @change=${(e: Event) => props.onEndDateChange((e.target as HTMLInputElement).value)}
          />
          <select
            title="Time zone"
            .value=${props.timeZone}
            @change=${(e: Event) =>
              props.onTimeZoneChange((e.target as HTMLSelectElement).value as "local" | "utc")}
          >
            <option value="local">Local</option>
            <option value="utc">UTC</option>
          </select>
          <div class="chart-toggle">
            <button
              class="toggle-btn ${isTokenMode ? "active" : ""}"
              @click=${() => props.onChartModeChange("tokens")}
            >
              Tokens
            </button>
            <button
              class="toggle-btn ${!isTokenMode ? "active" : ""}"
              @click=${() => props.onChartModeChange("cost")}
            >
              Cost
            </button>
          </div>
          <button
            class="btn btn-sm usage-action-btn usage-primary-btn"
            @click=${props.onRefresh}
            ?disabled=${props.loading}
          >
            Refresh
          </button>
        </div>
        
      </div>

      <div style="margin-top: 12px;">
          <div class="usage-query-bar">
          <input
            class="usage-query-input"
            type="text"
            .value=${props.queryDraft}
            placeholder="Filter sessions (e.g. key:agent:main:cron* model:gpt-4o has:errors minTokens:2000)"
            @input=${(e: Event) => props.onQueryDraftChange((e.target as HTMLInputElement).value)}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") {
                e.preventDefault();
                props.onApplyQuery();
              }
            }}
          />
          <div class="usage-query-actions">
            <button
              class="btn btn-sm usage-action-btn usage-secondary-btn"
              @click=${props.onApplyQuery}
              ?disabled=${props.loading || (!hasDraftQuery && !hasQuery)}
            >
              Filter (client-side)
            </button>
            ${
              hasDraftQuery || hasQuery
                ? html`<button class="btn btn-sm usage-action-btn usage-secondary-btn" @click=${props.onClearQuery}>Clear</button>`
                : nothing
            }
            <span class="usage-query-hint">
              ${
                hasQuery
                  ? `${filteredSessions.length} of ${totalSessions} sessions match`
                  : `${totalSessions} sessions in range`
              }
            </span>
          </div>
        </div>
        <div class="usage-filter-row">
          ${renderFilterSelect("agent", "Agent", agentOptions)}
          ${renderFilterSelect("channel", "Channel", channelOptions)}
          ${renderFilterSelect("provider", "Provider", providerOptions)}
          ${renderFilterSelect("model", "Model", modelOptions)}
          ${renderFilterSelect("tool", "Tool", toolOptions)}
          <span class="usage-query-hint">
            Tip: use filters or click bars to filter days.
          </span>
        </div>
        ${
          queryTerms.length > 0
            ? html`
                <div class="usage-query-chips">
                  ${queryTerms.map((term) => {
                    const label = term.raw;
                    return html`
                      <span class="usage-query-chip">
                        ${label}
                        <button
                          title="Remove filter"
                          @click=${() =>
                            props.onQueryDraftChange(removeQueryToken(props.queryDraft, label))}
                        >
                          ×
                        </button>
                      </span>
                    `;
                  })}
                </div>
              `
            : nothing
        }
        ${
          querySuggestions.length > 0
            ? html`
                <div class="usage-query-suggestions">
                  ${querySuggestions.map(
                    (suggestion) => html`
                      <button
                        class="usage-query-suggestion"
                        @click=${() =>
                          props.onQueryDraftChange(
                            applySuggestionToQuery(props.queryDraft, suggestion.value),
                          )}
                      >
                        ${suggestion.label}
                      </button>
                    `,
                  )}
                </div>
              `
            : nothing
        }
        ${
          queryWarnings.length > 0
            ? html`
                <div class="callout warning" style="margin-top: 8px;">
                  ${queryWarnings.join(" · ")}
                </div>
              `
            : nothing
        }
      </div>

      ${
        props.error
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
          : nothing
      }

      ${
        props.sessionsLimitReached
          ? html`
              <div class="callout warning" style="margin-top: 12px">
                Showing first 1,000 sessions. Narrow date range for complete results.
              </div>
            `
          : nothing
      }
    </section>

    ${renderUsageInsights(
      displayTotals,
      activeAggregates,
      insightStats,
      hasMissingCost,
      buildPeakErrorHours(aggregateSessions, props.timeZone),
      displaySessionCount,
      totalSessions,
    )}

    ${renderUsageMosaic(aggregateSessions, props.timeZone, props.selectedHours, props.onSelectHour)}

    <!-- Two-column layout: Daily+Breakdown on left, Sessions on right -->
    <div class="usage-grid">
      <div class="usage-grid-left">
        <div class="card usage-left-card">
          ${renderDailyChartCompact(
            filteredDaily,
            props.selectedDays,
            props.chartMode,
            props.dailyChartMode,
            props.onDailyChartModeChange,
            props.onSelectDay,
          )}
          ${displayTotals ? renderCostBreakdownCompact(displayTotals, props.chartMode) : nothing}
        </div>
      </div>
      <div class="usage-grid-right">
        ${renderSessionsCard(
          filteredSessions,
          props.selectedSessions,
          props.selectedDays,
          isTokenMode,
          props.sessionSort,
          props.sessionSortDir,
          props.recentSessions,
          props.sessionsTab,
          props.onSelectSession,
          props.onSessionSortChange,
          props.onSessionSortDirChange,
          props.onSessionsTabChange,
          props.visibleColumns,
          totalSessions,
          props.onClearSessions,
        )}
      </div>
    </div>

    <!-- Session Detail Panel (when selected) or Empty State -->
    ${
      primarySelectedEntry
        ? renderSessionDetailPanel(
            primarySelectedEntry,
            props.timeSeries,
            props.timeSeriesLoading,
            props.timeSeriesMode,
            props.onTimeSeriesModeChange,
            props.timeSeriesBreakdownMode,
            props.onTimeSeriesBreakdownChange,
            props.timeSeriesCursorStart,
            props.timeSeriesCursorEnd,
            props.onTimeSeriesCursorRangeChange,
            props.startDate,
            props.endDate,
            props.selectedDays,
            props.sessionLogs,
            props.sessionLogsLoading,
            props.sessionLogsExpanded,
            props.onToggleSessionLogsExpanded,
            {
              roles: props.logFilterRoles,
              tools: props.logFilterTools,
              hasTools: props.logFilterHasTools,
              query: props.logFilterQuery,
            },
            props.onLogFilterRolesChange,
            props.onLogFilterToolsChange,
            props.onLogFilterHasToolsChange,
            props.onLogFilterQueryChange,
            props.onLogFilterClear,
            props.contextExpanded,
            props.onToggleContextExpanded,
            props.onClearSessions,
          )
        : renderEmptyDetailState()
    }
  `;
}

// Exposed for Playwright/Vitest browser unit tests.
