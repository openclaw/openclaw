import { html, nothing } from "lit";
import { formatDurationCompact } from "../../../../src/infra/format-time/format-duration.ts";
import {
  formatCost,
  formatDayLabel,
  formatFullDate,
  formatTokens,
  UsageInsightStats,
} from "./usage-metrics.ts";
import {
  UsageAggregates,
  UsageColumnId,
  UsageSessionEntry,
  UsageTotals,
  CostDailyEntry,
} from "./usageTypes.ts";

function pct(part: number, total: number): number {
  if (total === 0) {
    return 0;
  }
  return (part / total) * 100;
}

function getCostBreakdown(totals: UsageTotals) {
  // Use actual costs from API data (already aggregated in backend)
  const totalCost = totals.totalCost || 0;

  return {
    input: {
      tokens: totals.input,
      cost: totals.inputCost || 0,
      pct: pct(totals.inputCost || 0, totalCost),
    },
    output: {
      tokens: totals.output,
      cost: totals.outputCost || 0,
      pct: pct(totals.outputCost || 0, totalCost),
    },
    cacheRead: {
      tokens: totals.cacheRead,
      cost: totals.cacheReadCost || 0,
      pct: pct(totals.cacheReadCost || 0, totalCost),
    },
    cacheWrite: {
      tokens: totals.cacheWrite,
      cost: totals.cacheWriteCost || 0,
      pct: pct(totals.cacheWriteCost || 0, totalCost),
    },
    totalCost,
  };
}

function renderFilterChips(
  selectedDays: string[],
  selectedHours: number[],
  selectedSessions: string[],
  sessions: UsageSessionEntry[],
  onClearDays: () => void,
  onClearHours: () => void,
  onClearSessions: () => void,
  onClearFilters: () => void,
) {
  const hasFilters =
    selectedDays.length > 0 || selectedHours.length > 0 || selectedSessions.length > 0;
  if (!hasFilters) {
    return nothing;
  }

  const selectedSession =
    selectedSessions.length === 1 ? sessions.find((s) => s.key === selectedSessions[0]) : null;
  const sessionsLabel = selectedSession
    ? (selectedSession.label || selectedSession.key).slice(0, 20) +
      ((selectedSession.label || selectedSession.key).length > 20 ? "…" : "")
    : selectedSessions.length === 1
      ? selectedSessions[0].slice(0, 8) + "…"
      : `${selectedSessions.length} sessions`;
  const sessionsFullName = selectedSession
    ? selectedSession.label || selectedSession.key
    : selectedSessions.length === 1
      ? selectedSessions[0]
      : selectedSessions.join(", ");

  const daysLabel = selectedDays.length === 1 ? selectedDays[0] : `${selectedDays.length} days`;
  const hoursLabel =
    selectedHours.length === 1 ? `${selectedHours[0]}:00` : `${selectedHours.length} hours`;

  return html`
    <div class="active-filters">
      ${
        selectedDays.length > 0
          ? html`
            <div class="filter-chip">
              <span class="filter-chip-label">Days: ${daysLabel}</span>
              <button class="filter-chip-remove" @click=${onClearDays} title="Remove filter">×</button>
            </div>
          `
          : nothing
      }
      ${
        selectedHours.length > 0
          ? html`
            <div class="filter-chip">
              <span class="filter-chip-label">Hours: ${hoursLabel}</span>
              <button class="filter-chip-remove" @click=${onClearHours} title="Remove filter">×</button>
            </div>
          `
          : nothing
      }
      ${
        selectedSessions.length > 0
          ? html`
            <div class="filter-chip" title="${sessionsFullName}">
              <span class="filter-chip-label">Session: ${sessionsLabel}</span>
              <button class="filter-chip-remove" @click=${onClearSessions} title="Remove filter">×</button>
            </div>
          `
          : nothing
      }
      ${
        (selectedDays.length > 0 || selectedHours.length > 0) && selectedSessions.length > 0
          ? html`
            <button class="btn btn-sm filter-clear-btn" @click=${onClearFilters}>
              Clear All
            </button>
          `
          : nothing
      }
    </div>
  `;
}

function renderDailyChartCompact(
  daily: CostDailyEntry[],
  selectedDays: string[],
  chartMode: "tokens" | "cost",
  dailyChartMode: "total" | "by-type",
  onDailyChartModeChange: (mode: "total" | "by-type") => void,
  onSelectDay: (day: string, shiftKey: boolean) => void,
) {
  if (!daily.length) {
    return html`
      <div class="daily-chart-compact">
        <div class="sessions-panel-title">Daily Usage</div>
        <div class="muted" style="padding: 20px; text-align: center">No data</div>
      </div>
    `;
  }

  const isTokenMode = chartMode === "tokens";
  const values = daily.map((d) => (isTokenMode ? d.totalTokens : d.totalCost));
  const maxValue = Math.max(...values, isTokenMode ? 1 : 0.0001);

  // Calculate bar width based on number of days
  const barMaxWidth = daily.length > 30 ? 12 : daily.length > 20 ? 18 : daily.length > 14 ? 24 : 32;
  const showTotals = daily.length <= 14;

  return html`
    <div class="daily-chart-compact">
      <div class="daily-chart-header">
        <div class="chart-toggle small sessions-toggle">
          <button
            class="toggle-btn ${dailyChartMode === "total" ? "active" : ""}"
            @click=${() => onDailyChartModeChange("total")}
          >
            Total
          </button>
          <button
            class="toggle-btn ${dailyChartMode === "by-type" ? "active" : ""}"
            @click=${() => onDailyChartModeChange("by-type")}
          >
            By Type
          </button>
        </div>
        <div class="card-title">Daily ${isTokenMode ? "Token" : "Cost"} Usage</div>
      </div>
      <div class="daily-chart">
        <div class="daily-chart-bars" style="--bar-max-width: ${barMaxWidth}px">
          ${daily.map((d, idx) => {
            const value = values[idx];
            const heightPct = (value / maxValue) * 100;
            const isSelected = selectedDays.includes(d.date);
            const label = formatDayLabel(d.date);
            // Shorter label for many days (just day number)
            const shortLabel = daily.length > 20 ? String(parseInt(d.date.slice(8), 10)) : label;
            const labelStyle = daily.length > 20 ? "font-size: 8px" : "";
            const segments =
              dailyChartMode === "by-type"
                ? isTokenMode
                  ? [
                      { value: d.output, class: "output" },
                      { value: d.input, class: "input" },
                      { value: d.cacheWrite, class: "cache-write" },
                      { value: d.cacheRead, class: "cache-read" },
                    ]
                  : [
                      { value: d.outputCost ?? 0, class: "output" },
                      { value: d.inputCost ?? 0, class: "input" },
                      { value: d.cacheWriteCost ?? 0, class: "cache-write" },
                      { value: d.cacheReadCost ?? 0, class: "cache-read" },
                    ]
                : [];
            const breakdownLines =
              dailyChartMode === "by-type"
                ? isTokenMode
                  ? [
                      `Output ${formatTokens(d.output)}`,
                      `Input ${formatTokens(d.input)}`,
                      `Cache write ${formatTokens(d.cacheWrite)}`,
                      `Cache read ${formatTokens(d.cacheRead)}`,
                    ]
                  : [
                      `Output ${formatCost(d.outputCost ?? 0)}`,
                      `Input ${formatCost(d.inputCost ?? 0)}`,
                      `Cache write ${formatCost(d.cacheWriteCost ?? 0)}`,
                      `Cache read ${formatCost(d.cacheReadCost ?? 0)}`,
                    ]
                : [];
            const totalLabel = isTokenMode ? formatTokens(d.totalTokens) : formatCost(d.totalCost);
            return html`
              <div
                class="daily-bar-wrapper ${isSelected ? "selected" : ""}"
                @click=${(e: MouseEvent) => onSelectDay(d.date, e.shiftKey)}
              >
                ${
                  dailyChartMode === "by-type"
                    ? html`
                        <div
                          class="daily-bar"
                          style="height: ${heightPct.toFixed(1)}%; display: flex; flex-direction: column;"
                        >
                          ${(() => {
                            const total = segments.reduce((sum, seg) => sum + seg.value, 0) || 1;
                            return segments.map(
                              (seg) => html`
                                <div
                                  class="cost-segment ${seg.class}"
                                  style="height: ${(seg.value / total) * 100}%"
                                ></div>
                              `,
                            );
                          })()}
                        </div>
                      `
                    : html`
                        <div class="daily-bar" style="height: ${heightPct.toFixed(1)}%"></div>
                      `
                }
                ${showTotals ? html`<div class="daily-bar-total">${totalLabel}</div>` : nothing}
                <div class="daily-bar-label" style="${labelStyle}">${shortLabel}</div>
                <div class="daily-bar-tooltip">
                  <strong>${formatFullDate(d.date)}</strong><br />
                  ${formatTokens(d.totalTokens)} tokens<br />
                  ${formatCost(d.totalCost)}
                  ${
                    breakdownLines.length
                      ? html`${breakdownLines.map((line) => html`<div>${line}</div>`)}`
                      : nothing
                  }
                </div>
              </div>
            `;
          })}
        </div>
      </div>
    </div>
  `;
}

function renderCostBreakdownCompact(totals: UsageTotals, mode: "tokens" | "cost") {
  const breakdown = getCostBreakdown(totals);
  const isTokenMode = mode === "tokens";
  const totalTokens = totals.totalTokens || 1;
  const tokenPcts = {
    output: pct(totals.output, totalTokens),
    input: pct(totals.input, totalTokens),
    cacheWrite: pct(totals.cacheWrite, totalTokens),
    cacheRead: pct(totals.cacheRead, totalTokens),
  };

  return html`
    <div class="cost-breakdown cost-breakdown-compact">
      <div class="cost-breakdown-header">${isTokenMode ? "Tokens" : "Cost"} by Type</div>
      <div class="cost-breakdown-bar">
        <div class="cost-segment output" style="width: ${(isTokenMode ? tokenPcts.output : breakdown.output.pct).toFixed(1)}%"
          title="Output: ${isTokenMode ? formatTokens(totals.output) : formatCost(breakdown.output.cost)}"></div>
        <div class="cost-segment input" style="width: ${(isTokenMode ? tokenPcts.input : breakdown.input.pct).toFixed(1)}%"
          title="Input: ${isTokenMode ? formatTokens(totals.input) : formatCost(breakdown.input.cost)}"></div>
        <div class="cost-segment cache-write" style="width: ${(isTokenMode ? tokenPcts.cacheWrite : breakdown.cacheWrite.pct).toFixed(1)}%"
          title="Cache Write: ${isTokenMode ? formatTokens(totals.cacheWrite) : formatCost(breakdown.cacheWrite.cost)}"></div>
        <div class="cost-segment cache-read" style="width: ${(isTokenMode ? tokenPcts.cacheRead : breakdown.cacheRead.pct).toFixed(1)}%"
          title="Cache Read: ${isTokenMode ? formatTokens(totals.cacheRead) : formatCost(breakdown.cacheRead.cost)}"></div>
      </div>
      <div class="cost-breakdown-legend">
        <span class="legend-item"><span class="legend-dot output"></span>Output ${isTokenMode ? formatTokens(totals.output) : formatCost(breakdown.output.cost)}</span>
        <span class="legend-item"><span class="legend-dot input"></span>Input ${isTokenMode ? formatTokens(totals.input) : formatCost(breakdown.input.cost)}</span>
        <span class="legend-item"><span class="legend-dot cache-write"></span>Cache Write ${isTokenMode ? formatTokens(totals.cacheWrite) : formatCost(breakdown.cacheWrite.cost)}</span>
        <span class="legend-item"><span class="legend-dot cache-read"></span>Cache Read ${isTokenMode ? formatTokens(totals.cacheRead) : formatCost(breakdown.cacheRead.cost)}</span>
      </div>
      <div class="cost-breakdown-total">
        Total: ${isTokenMode ? formatTokens(totals.totalTokens) : formatCost(totals.totalCost)}
      </div>
    </div>
  `;
}

function renderInsightList(
  title: string,
  items: Array<{ label: string; value: string; sub?: string }>,
  emptyLabel: string,
) {
  return html`
    <div class="usage-insight-card">
      <div class="usage-insight-title">${title}</div>
      ${
        items.length === 0
          ? html`<div class="muted">${emptyLabel}</div>`
          : html`
              <div class="usage-list">
                ${items.map(
                  (item) => html`
                    <div class="usage-list-item">
                      <span>${item.label}</span>
                      <span class="usage-list-value">
                        <span>${item.value}</span>
                        ${item.sub ? html`<span class="usage-list-sub">${item.sub}</span>` : nothing}
                      </span>
                    </div>
                  `,
                )}
              </div>
            `
      }
    </div>
  `;
}

function renderPeakErrorList(
  title: string,
  items: Array<{ label: string; value: string; sub?: string }>,
  emptyLabel: string,
) {
  return html`
    <div class="usage-insight-card">
      <div class="usage-insight-title">${title}</div>
      ${
        items.length === 0
          ? html`<div class="muted">${emptyLabel}</div>`
          : html`
              <div class="usage-error-list">
                ${items.map(
                  (item) => html`
                    <div class="usage-error-row">
                      <div class="usage-error-date">${item.label}</div>
                      <div class="usage-error-rate">${item.value}</div>
                      ${item.sub ? html`<div class="usage-error-sub">${item.sub}</div>` : nothing}
                    </div>
                  `,
                )}
              </div>
            `
      }
    </div>
  `;
}

function renderUsageInsights(
  totals: UsageTotals | null,
  aggregates: UsageAggregates,
  stats: UsageInsightStats,
  showCostHint: boolean,
  errorHours: Array<{ label: string; value: string; sub?: string }>,
  sessionCount: number,
  totalSessions: number,
) {
  if (!totals) {
    return nothing;
  }

  const avgTokens = aggregates.messages.total
    ? Math.round(totals.totalTokens / aggregates.messages.total)
    : 0;
  const avgCost = aggregates.messages.total ? totals.totalCost / aggregates.messages.total : 0;
  const cacheBase = totals.input + totals.cacheRead;
  const cacheHitRate = cacheBase > 0 ? totals.cacheRead / cacheBase : 0;
  const cacheHitLabel = cacheBase > 0 ? `${(cacheHitRate * 100).toFixed(1)}%` : "—";
  const errorRatePct = stats.errorRate * 100;
  const throughputLabel =
    stats.throughputTokensPerMin !== undefined
      ? `${formatTokens(Math.round(stats.throughputTokensPerMin))} tok/min`
      : "—";
  const throughputCostLabel =
    stats.throughputCostPerMin !== undefined
      ? `${formatCost(stats.throughputCostPerMin, 4)} / min`
      : "—";
  const avgDurationLabel =
    stats.durationCount > 0
      ? (formatDurationCompact(stats.avgDurationMs, { spaced: true }) ?? "—")
      : "—";
  const cacheHint = "Cache hit rate = cache read / (input + cache read). Higher is better.";
  const errorHint = "Error rate = errors / total messages. Lower is better.";
  const throughputHint = "Throughput shows tokens per minute over active time. Higher is better.";
  const tokensHint = "Average tokens per message in this range.";
  const costHint = showCostHint
    ? "Average cost per message when providers report costs. Cost data is missing for some or all sessions in this range."
    : "Average cost per message when providers report costs.";

  const errorDays = aggregates.daily
    .filter((day) => day.messages > 0 && day.errors > 0)
    .map((day) => {
      const rate = day.errors / day.messages;
      return {
        label: formatDayLabel(day.date),
        value: `${(rate * 100).toFixed(2)}%`,
        sub: `${day.errors} errors · ${day.messages} msgs · ${formatTokens(day.tokens)}`,
        rate,
      };
    })
    .toSorted((a, b) => b.rate - a.rate)
    .slice(0, 5)
    .map(({ rate: _rate, ...rest }) => rest);

  const topModels = aggregates.byModel.slice(0, 5).map((entry) => ({
    label: entry.model ?? "unknown",
    value: formatCost(entry.totals.totalCost),
    sub: `${formatTokens(entry.totals.totalTokens)} · ${entry.count} msgs`,
  }));
  const topProviders = aggregates.byProvider.slice(0, 5).map((entry) => ({
    label: entry.provider ?? "unknown",
    value: formatCost(entry.totals.totalCost),
    sub: `${formatTokens(entry.totals.totalTokens)} · ${entry.count} msgs`,
  }));
  const topTools = aggregates.tools.tools.slice(0, 6).map((tool) => ({
    label: tool.name,
    value: `${tool.count}`,
    sub: "calls",
  }));
  const topAgents = aggregates.byAgent.slice(0, 5).map((entry) => ({
    label: entry.agentId,
    value: formatCost(entry.totals.totalCost),
    sub: formatTokens(entry.totals.totalTokens),
  }));
  const topChannels = aggregates.byChannel.slice(0, 5).map((entry) => ({
    label: entry.channel,
    value: formatCost(entry.totals.totalCost),
    sub: formatTokens(entry.totals.totalTokens),
  }));

  return html`
    <section class="card" style="margin-top: 16px;">
      <div class="card-title">Usage Overview</div>
      <div class="usage-summary-grid">
        <div class="usage-summary-card">
          <div class="usage-summary-title">
            Messages
            <span class="usage-summary-hint" title="Total user + assistant messages in range.">?</span>
          </div>
          <div class="usage-summary-value">${aggregates.messages.total}</div>
          <div class="usage-summary-sub">
            ${aggregates.messages.user} user · ${aggregates.messages.assistant} assistant
          </div>
        </div>
        <div class="usage-summary-card">
          <div class="usage-summary-title">
            Tool Calls
            <span class="usage-summary-hint" title="Total tool call count across sessions.">?</span>
          </div>
          <div class="usage-summary-value">${aggregates.tools.totalCalls}</div>
          <div class="usage-summary-sub">${aggregates.tools.uniqueTools} tools used</div>
        </div>
        <div class="usage-summary-card">
          <div class="usage-summary-title">
            Errors
            <span class="usage-summary-hint" title="Total message/tool errors in range.">?</span>
          </div>
          <div class="usage-summary-value">${aggregates.messages.errors}</div>
          <div class="usage-summary-sub">${aggregates.messages.toolResults} tool results</div>
        </div>
        <div class="usage-summary-card">
          <div class="usage-summary-title">
            Avg Tokens / Msg
            <span class="usage-summary-hint" title=${tokensHint}>?</span>
          </div>
          <div class="usage-summary-value">${formatTokens(avgTokens)}</div>
          <div class="usage-summary-sub">Across ${aggregates.messages.total || 0} messages</div>
        </div>
        <div class="usage-summary-card">
          <div class="usage-summary-title">
            Avg Cost / Msg
            <span class="usage-summary-hint" title=${costHint}>?</span>
          </div>
          <div class="usage-summary-value">${formatCost(avgCost, 4)}</div>
          <div class="usage-summary-sub">${formatCost(totals.totalCost)} total</div>
        </div>
        <div class="usage-summary-card">
          <div class="usage-summary-title">
            Sessions
            <span class="usage-summary-hint" title="Distinct sessions in the range.">?</span>
          </div>
          <div class="usage-summary-value">${sessionCount}</div>
          <div class="usage-summary-sub">of ${totalSessions} in range</div>
        </div>
        <div class="usage-summary-card">
          <div class="usage-summary-title">
            Throughput
            <span class="usage-summary-hint" title=${throughputHint}>?</span>
          </div>
          <div class="usage-summary-value">${throughputLabel}</div>
          <div class="usage-summary-sub">${throughputCostLabel}</div>
        </div>
        <div class="usage-summary-card">
          <div class="usage-summary-title">
            Error Rate
            <span class="usage-summary-hint" title=${errorHint}>?</span>
          </div>
          <div class="usage-summary-value ${errorRatePct > 5 ? "bad" : errorRatePct > 1 ? "warn" : "good"}">${errorRatePct.toFixed(2)}%</div>
          <div class="usage-summary-sub">
            ${aggregates.messages.errors} errors · ${avgDurationLabel} avg session
          </div>
        </div>
        <div class="usage-summary-card">
          <div class="usage-summary-title">
            Cache Hit Rate
            <span class="usage-summary-hint" title=${cacheHint}>?</span>
          </div>
          <div class="usage-summary-value ${cacheHitRate > 0.6 ? "good" : cacheHitRate > 0.3 ? "warn" : "bad"}">${cacheHitLabel}</div>
          <div class="usage-summary-sub">
            ${formatTokens(totals.cacheRead)} cached · ${formatTokens(cacheBase)} prompt
          </div>
        </div>
      </div>
      <div class="usage-insights-grid">
        ${renderInsightList("Top Models", topModels, "No model data")}
        ${renderInsightList("Top Providers", topProviders, "No provider data")}
        ${renderInsightList("Top Tools", topTools, "No tool calls")}
        ${renderInsightList("Top Agents", topAgents, "No agent data")}
        ${renderInsightList("Top Channels", topChannels, "No channel data")}
        ${renderPeakErrorList("Peak Error Days", errorDays, "No error data")}
        ${renderPeakErrorList("Peak Error Hours", errorHours, "No error data")}
      </div>
    </section>
  `;
}

function renderSessionsCard(
  sessions: UsageSessionEntry[],
  selectedSessions: string[],
  selectedDays: string[],
  isTokenMode: boolean,
  sessionSort: "tokens" | "cost" | "recent" | "messages" | "errors",
  sessionSortDir: "asc" | "desc",
  recentSessions: string[],
  sessionsTab: "all" | "recent",
  onSelectSession: (key: string, shiftKey: boolean) => void,
  onSessionSortChange: (sort: "tokens" | "cost" | "recent" | "messages" | "errors") => void,
  onSessionSortDirChange: (dir: "asc" | "desc") => void,
  onSessionsTabChange: (tab: "all" | "recent") => void,
  visibleColumns: UsageColumnId[],
  totalSessions: number,
  onClearSessions: () => void,
) {
  const showColumn = (id: UsageColumnId) => visibleColumns.includes(id);
  const formatSessionListLabel = (s: UsageSessionEntry): string => {
    const raw = s.label || s.key;
    // Agent session keys often include a token query param; remove it for readability.
    if (raw.startsWith("agent:") && raw.includes("?token=")) {
      return raw.slice(0, raw.indexOf("?token="));
    }
    return raw;
  };
  const copySessionName = async (s: UsageSessionEntry) => {
    const text = formatSessionListLabel(s);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Best effort; clipboard can fail on insecure contexts or denied permission.
    }
  };

  const buildSessionMeta = (s: UsageSessionEntry): string[] => {
    const parts: string[] = [];
    if (showColumn("channel") && s.channel) {
      parts.push(`channel:${s.channel}`);
    }
    if (showColumn("agent") && s.agentId) {
      parts.push(`agent:${s.agentId}`);
    }
    if (showColumn("provider") && (s.modelProvider || s.providerOverride)) {
      parts.push(`provider:${s.modelProvider ?? s.providerOverride}`);
    }
    if (showColumn("model") && s.model) {
      parts.push(`model:${s.model}`);
    }
    if (showColumn("messages") && s.usage?.messageCounts) {
      parts.push(`msgs:${s.usage.messageCounts.total}`);
    }
    if (showColumn("tools") && s.usage?.toolUsage) {
      parts.push(`tools:${s.usage.toolUsage.totalCalls}`);
    }
    if (showColumn("errors") && s.usage?.messageCounts) {
      parts.push(`errors:${s.usage.messageCounts.errors}`);
    }
    if (showColumn("duration") && s.usage?.durationMs) {
      parts.push(`dur:${formatDurationCompact(s.usage.durationMs, { spaced: true }) ?? "—"}`);
    }
    return parts;
  };

  // Helper to get session value (filtered by days if selected)
  const getSessionValue = (s: UsageSessionEntry): number => {
    const usage = s.usage;
    if (!usage) {
      return 0;
    }

    // If days are selected and session has daily breakdown, compute filtered total
    if (selectedDays.length > 0 && usage.dailyBreakdown && usage.dailyBreakdown.length > 0) {
      const filteredDays = usage.dailyBreakdown.filter((d) => selectedDays.includes(d.date));
      return isTokenMode
        ? filteredDays.reduce((sum, d) => sum + d.tokens, 0)
        : filteredDays.reduce((sum, d) => sum + d.cost, 0);
    }

    // Otherwise use total
    return isTokenMode ? (usage.totalTokens ?? 0) : (usage.totalCost ?? 0);
  };

  const sortedSessions = [...sessions].toSorted((a, b) => {
    switch (sessionSort) {
      case "recent":
        return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
      case "messages":
        return (b.usage?.messageCounts?.total ?? 0) - (a.usage?.messageCounts?.total ?? 0);
      case "errors":
        return (b.usage?.messageCounts?.errors ?? 0) - (a.usage?.messageCounts?.errors ?? 0);
      case "cost":
        return getSessionValue(b) - getSessionValue(a);
      case "tokens":
      default:
        return getSessionValue(b) - getSessionValue(a);
    }
  });
  const sortedWithDir = sessionSortDir === "asc" ? sortedSessions.toReversed() : sortedSessions;

  const totalValue = sortedWithDir.reduce((sum, session) => sum + getSessionValue(session), 0);
  const avgValue = sortedWithDir.length ? totalValue / sortedWithDir.length : 0;
  const totalErrors = sortedWithDir.reduce(
    (sum, session) => sum + (session.usage?.messageCounts?.errors ?? 0),
    0,
  );

  const selectedSet = new Set(selectedSessions);
  const selectedEntries = sortedWithDir.filter((s) => selectedSet.has(s.key));
  const selectedCount = selectedEntries.length;
  const sessionMap = new Map(sortedWithDir.map((s) => [s.key, s]));
  const recentEntries = recentSessions
    .map((key) => sessionMap.get(key))
    .filter((entry): entry is UsageSessionEntry => Boolean(entry));

  return html`
    <div class="card sessions-card">
      <div class="sessions-card-header">
        <div class="card-title">Sessions</div>
        <div class="sessions-card-count">
          ${sessions.length} shown${totalSessions !== sessions.length ? ` · ${totalSessions} total` : ""}
        </div>
      </div>
      <div class="sessions-card-meta">
        <div class="sessions-card-stats">
          <span>${isTokenMode ? formatTokens(avgValue) : formatCost(avgValue)} avg</span>
          <span>${totalErrors} errors</span>
        </div>
        <div class="chart-toggle small">
          <button
            class="toggle-btn ${sessionsTab === "all" ? "active" : ""}"
            @click=${() => onSessionsTabChange("all")}
          >
            All
          </button>
          <button
            class="toggle-btn ${sessionsTab === "recent" ? "active" : ""}"
            @click=${() => onSessionsTabChange("recent")}
          >
            Recently viewed
          </button>
        </div>
        <label class="sessions-sort">
          <span>Sort</span>
          <select
            @change=${(e: Event) => onSessionSortChange((e.target as HTMLSelectElement).value as typeof sessionSort)}
          >
            <option value="cost" ?selected=${sessionSort === "cost"}>Cost</option>
            <option value="errors" ?selected=${sessionSort === "errors"}>Errors</option>
            <option value="messages" ?selected=${sessionSort === "messages"}>Messages</option>
            <option value="recent" ?selected=${sessionSort === "recent"}>Recent</option>
            <option value="tokens" ?selected=${sessionSort === "tokens"}>Tokens</option>
          </select>
        </label>
        <button
          class="btn btn-sm sessions-action-btn icon"
          @click=${() => onSessionSortDirChange(sessionSortDir === "desc" ? "asc" : "desc")}
          title=${sessionSortDir === "desc" ? "Descending" : "Ascending"}
        >
          ${sessionSortDir === "desc" ? "↓" : "↑"}
        </button>
        ${
          selectedCount > 0
            ? html`
                <button class="btn btn-sm sessions-action-btn sessions-clear-btn" @click=${onClearSessions}>
                  Clear Selection
                </button>
              `
            : nothing
        }
      </div>
      ${
        sessionsTab === "recent"
          ? recentEntries.length === 0
            ? html`
                <div class="muted" style="padding: 20px; text-align: center">No recent sessions</div>
              `
            : html`
                <div class="session-bars" style="max-height: 220px; margin-top: 6px;">
                  ${recentEntries.map((s) => {
                    const value = getSessionValue(s);
                    const isSelected = selectedSet.has(s.key);
                    const displayLabel = formatSessionListLabel(s);
                    const meta = buildSessionMeta(s);
                    return html`
                      <div
                        class="session-bar-row ${isSelected ? "selected" : ""}"
                        @click=${(e: MouseEvent) => onSelectSession(s.key, e.shiftKey)}
                        title="${s.key}"
                      >
                        <div class="session-bar-label">
                          <div class="session-bar-title">${displayLabel}</div>
                          ${meta.length > 0 ? html`<div class="session-bar-meta">${meta.join(" · ")}</div>` : nothing}
                        </div>
                        <div class="session-bar-track" style="display: none;"></div>
                        <div class="session-bar-actions">
                          <button
                            class="session-copy-btn"
                            title="Copy session name"
                            @click=${(e: MouseEvent) => {
                              e.stopPropagation();
                              void copySessionName(s);
                            }}
                          >
                            Copy
                          </button>
                          <div class="session-bar-value">${isTokenMode ? formatTokens(value) : formatCost(value)}</div>
                        </div>
                      </div>
                    `;
                  })}
                </div>
              `
          : sessions.length === 0
            ? html`
                <div class="muted" style="padding: 20px; text-align: center">No sessions in range</div>
              `
            : html`
                <div class="session-bars">
                  ${sortedWithDir.slice(0, 50).map((s) => {
                    const value = getSessionValue(s);
                    const isSelected = selectedSessions.includes(s.key);
                    const displayLabel = formatSessionListLabel(s);
                    const meta = buildSessionMeta(s);

                    return html`
                      <div
                        class="session-bar-row ${isSelected ? "selected" : ""}"
                        @click=${(e: MouseEvent) => onSelectSession(s.key, e.shiftKey)}
                        title="${s.key}"
                      >
                        <div class="session-bar-label">
                          <div class="session-bar-title">${displayLabel}</div>
                          ${meta.length > 0 ? html`<div class="session-bar-meta">${meta.join(" · ")}</div>` : nothing}
                        </div>
                        <div class="session-bar-track" style="display: none;"></div>
                        <div class="session-bar-actions">
                          <button
                            class="session-copy-btn"
                            title="Copy session name"
                            @click=${(e: MouseEvent) => {
                              e.stopPropagation();
                              void copySessionName(s);
                            }}
                          >
                            Copy
                          </button>
                          <div class="session-bar-value">${isTokenMode ? formatTokens(value) : formatCost(value)}</div>
                        </div>
                      </div>
                    `;
                  })}
                  ${sessions.length > 50 ? html`<div class="muted" style="padding: 8px; text-align: center; font-size: 11px;">+${sessions.length - 50} more</div>` : nothing}
                </div>
              `
      }
      ${
        selectedCount > 1
          ? html`
              <div style="margin-top: 10px;">
                <div class="sessions-card-count">Selected (${selectedCount})</div>
                <div class="session-bars" style="max-height: 160px; margin-top: 6px;">
                  ${selectedEntries.map((s) => {
                    const value = getSessionValue(s);
                    const displayLabel = formatSessionListLabel(s);
                    const meta = buildSessionMeta(s);
                    return html`
                      <div
                        class="session-bar-row selected"
                        @click=${(e: MouseEvent) => onSelectSession(s.key, e.shiftKey)}
                        title="${s.key}"
                      >
                        <div class="session-bar-label">
                          <div class="session-bar-title">${displayLabel}</div>
                          ${meta.length > 0 ? html`<div class="session-bar-meta">${meta.join(" · ")}</div>` : nothing}
                        </div>
                  <div class="session-bar-track" style="display: none;"></div>
                        <div class="session-bar-actions">
                          <button
                            class="session-copy-btn"
                            title="Copy session name"
                            @click=${(e: MouseEvent) => {
                              e.stopPropagation();
                              void copySessionName(s);
                            }}
                          >
                            Copy
                          </button>
                          <div class="session-bar-value">${isTokenMode ? formatTokens(value) : formatCost(value)}</div>
                        </div>
                      </div>
                    `;
                  })}
                </div>
              </div>
            `
          : nothing
      }
    </div>
  `;
}

export {
  renderCostBreakdownCompact,
  renderDailyChartCompact,
  renderFilterChips,
  renderInsightList,
  renderPeakErrorList,
  renderSessionsCard,
  renderUsageInsights,
};
