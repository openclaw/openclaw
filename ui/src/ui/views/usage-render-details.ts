import { html, svg, nothing } from "lit";
import { formatDurationCompact } from "../../../../src/infra/format-time/format-duration.ts";
import { parseToolSummary } from "../usage-helpers.ts";
import { charsToTokens, formatCost, formatTokens } from "./usage-metrics.ts";
import { renderInsightList } from "./usage-render-overview.ts";
import {
  SessionLogEntry,
  SessionLogRole,
  TimeSeriesPoint,
  UsageSessionEntry,
} from "./usageTypes.ts";

function pct(part: number, total: number): number {
  if (!total || total <= 0) {
    return 0;
  }
  return (part / total) * 100;
}

function renderEmptyDetailState() {
  return nothing;
}

function renderSessionSummary(session: UsageSessionEntry) {
  const usage = session.usage;
  if (!usage) {
    return html`
      <div class="muted">No usage data for this session.</div>
    `;
  }

  const formatTs = (ts?: number): string => (ts ? new Date(ts).toLocaleString() : "—");

  const badges: string[] = [];
  if (session.channel) {
    badges.push(`channel:${session.channel}`);
  }
  if (session.agentId) {
    badges.push(`agent:${session.agentId}`);
  }
  if (session.modelProvider || session.providerOverride) {
    badges.push(`provider:${session.modelProvider ?? session.providerOverride}`);
  }
  if (session.model) {
    badges.push(`model:${session.model}`);
  }

  const toolItems =
    usage.toolUsage?.tools.slice(0, 6).map((tool) => ({
      label: tool.name,
      value: `${tool.count}`,
      sub: "calls",
    })) ?? [];
  const modelItems =
    usage.modelUsage?.slice(0, 6).map((entry) => ({
      label: entry.model ?? "unknown",
      value: formatCost(entry.totals.totalCost),
      sub: formatTokens(entry.totals.totalTokens),
    })) ?? [];

  return html`
    ${badges.length > 0 ? html`<div class="usage-badges">${badges.map((b) => html`<span class="usage-badge">${b}</span>`)}</div>` : nothing}
    <div class="session-summary-grid">
      <div class="session-summary-card">
        <div class="session-summary-title">Messages</div>
        <div class="session-summary-value">${usage.messageCounts?.total ?? 0}</div>
        <div class="session-summary-meta">${usage.messageCounts?.user ?? 0} user · ${usage.messageCounts?.assistant ?? 0} assistant</div>
      </div>
      <div class="session-summary-card">
        <div class="session-summary-title">Tool Calls</div>
        <div class="session-summary-value">${usage.toolUsage?.totalCalls ?? 0}</div>
        <div class="session-summary-meta">${usage.toolUsage?.uniqueTools ?? 0} tools</div>
      </div>
      <div class="session-summary-card">
        <div class="session-summary-title">Errors</div>
        <div class="session-summary-value">${usage.messageCounts?.errors ?? 0}</div>
        <div class="session-summary-meta">${usage.messageCounts?.toolResults ?? 0} tool results</div>
      </div>
      <div class="session-summary-card">
        <div class="session-summary-title">Duration</div>
        <div class="session-summary-value">${formatDurationCompact(usage.durationMs, { spaced: true }) ?? "—"}</div>
        <div class="session-summary-meta">${formatTs(usage.firstActivity)} → ${formatTs(usage.lastActivity)}</div>
      </div>
    </div>
    <div class="usage-insights-grid" style="margin-top: 12px;">
      ${renderInsightList("Top Tools", toolItems, "No tool calls")}
      ${renderInsightList("Model Mix", modelItems, "No model data")}
    </div>
  `;
}

function renderSessionDetailPanel(
  session: UsageSessionEntry,
  timeSeries: { points: TimeSeriesPoint[] } | null,
  timeSeriesLoading: boolean,
  timeSeriesMode: "cumulative" | "per-turn",
  onTimeSeriesModeChange: (mode: "cumulative" | "per-turn") => void,
  timeSeriesBreakdownMode: "total" | "by-type",
  onTimeSeriesBreakdownChange: (mode: "total" | "by-type") => void,
  startDate: string,
  endDate: string,
  selectedDays: string[],
  sessionLogs: SessionLogEntry[] | null,
  sessionLogsLoading: boolean,
  sessionLogsExpanded: boolean,
  onToggleSessionLogsExpanded: () => void,
  logFilters: {
    roles: SessionLogRole[];
    tools: string[];
    hasTools: boolean;
    query: string;
  },
  onLogFilterRolesChange: (next: SessionLogRole[]) => void,
  onLogFilterToolsChange: (next: string[]) => void,
  onLogFilterHasToolsChange: (next: boolean) => void,
  onLogFilterQueryChange: (next: string) => void,
  onLogFilterClear: () => void,
  contextExpanded: boolean,
  onToggleContextExpanded: () => void,
  onClose: () => void,
) {
  const label = session.label || session.key;
  const displayLabel = label.length > 50 ? label.slice(0, 50) + "…" : label;
  const usage = session.usage;

  return html`
    <div class="card session-detail-panel">
      <div class="session-detail-header">
        <div class="session-detail-header-left">
          <div class="session-detail-title">${displayLabel}</div>
        </div>
        <div class="session-detail-stats">
          ${
            usage
              ? html`
            <span><strong>${formatTokens(usage.totalTokens)}</strong> tokens</span>
            <span><strong>${formatCost(usage.totalCost)}</strong></span>
          `
              : nothing
          }
        </div>
        <button class="session-close-btn" @click=${onClose} title="Close session details">×</button>
      </div>
      <div class="session-detail-content">
        ${renderSessionSummary(session)}
        <div class="session-detail-row">
          ${renderTimeSeriesCompact(
            timeSeries,
            timeSeriesLoading,
            timeSeriesMode,
            onTimeSeriesModeChange,
            timeSeriesBreakdownMode,
            onTimeSeriesBreakdownChange,
            startDate,
            endDate,
            selectedDays,
          )}
        </div>
        <div class="session-detail-bottom">
          ${renderSessionLogsCompact(
            sessionLogs,
            sessionLogsLoading,
            sessionLogsExpanded,
            onToggleSessionLogsExpanded,
            logFilters,
            onLogFilterRolesChange,
            onLogFilterToolsChange,
            onLogFilterHasToolsChange,
            onLogFilterQueryChange,
            onLogFilterClear,
          )}
          ${renderContextPanel(session.contextWeight, usage, contextExpanded, onToggleContextExpanded)}
        </div>
      </div>
    </div>
  `;
}

function renderTimeSeriesCompact(
  timeSeries: { points: TimeSeriesPoint[] } | null,
  loading: boolean,
  mode: "cumulative" | "per-turn",
  onModeChange: (mode: "cumulative" | "per-turn") => void,
  breakdownMode: "total" | "by-type",
  onBreakdownChange: (mode: "total" | "by-type") => void,
  startDate?: string,
  endDate?: string,
  selectedDays?: string[],
) {
  if (loading) {
    return html`
      <div class="session-timeseries-compact">
        <div class="muted" style="padding: 20px; text-align: center">Loading...</div>
      </div>
    `;
  }
  if (!timeSeries || timeSeries.points.length < 2) {
    return html`
      <div class="session-timeseries-compact">
        <div class="muted" style="padding: 20px; text-align: center">No timeline data</div>
      </div>
    `;
  }

  // Filter and recalculate (same logic as main function)
  let points = timeSeries.points;
  if (startDate || endDate || (selectedDays && selectedDays.length > 0)) {
    const startTs = startDate ? new Date(startDate + "T00:00:00").getTime() : 0;
    const endTs = endDate ? new Date(endDate + "T23:59:59").getTime() : Infinity;
    points = timeSeries.points.filter((p) => {
      if (p.timestamp < startTs || p.timestamp > endTs) {
        return false;
      }
      if (selectedDays && selectedDays.length > 0) {
        const d = new Date(p.timestamp);
        const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        return selectedDays.includes(dateStr);
      }
      return true;
    });
  }
  if (points.length < 2) {
    return html`
      <div class="session-timeseries-compact">
        <div class="muted" style="padding: 20px; text-align: center">No data in range</div>
      </div>
    `;
  }
  let cumTokens = 0,
    cumCost = 0;
  let sumOutput = 0;
  let sumInput = 0;
  let sumCacheRead = 0;
  let sumCacheWrite = 0;
  points = points.map((p) => {
    cumTokens += p.totalTokens;
    cumCost += p.cost;
    sumOutput += p.output;
    sumInput += p.input;
    sumCacheRead += p.cacheRead;
    sumCacheWrite += p.cacheWrite;
    return { ...p, cumulativeTokens: cumTokens, cumulativeCost: cumCost };
  });

  const width = 400,
    height = 80;
  const padding = { top: 16, right: 10, bottom: 20, left: 40 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const isCumulative = mode === "cumulative";
  const breakdownByType = mode === "per-turn" && breakdownMode === "by-type";
  const totalTypeTokens = sumOutput + sumInput + sumCacheRead + sumCacheWrite;
  const barTotals = points.map((p) =>
    isCumulative
      ? p.cumulativeTokens
      : breakdownByType
        ? p.input + p.output + p.cacheRead + p.cacheWrite
        : p.totalTokens,
  );
  const maxValue = Math.max(...barTotals, 1);
  const barWidth = Math.max(2, Math.min(8, (chartWidth / points.length) * 0.7));
  const barGap = Math.max(1, (chartWidth - barWidth * points.length) / (points.length - 1 || 1));

  return html`
    <div class="session-timeseries-compact">
      <div class="timeseries-header-row">
        <div class="card-title" style="font-size: 13px;">Usage Over Time</div>
        <div class="timeseries-controls">
          <div class="chart-toggle small">
            <button
              class="toggle-btn ${!isCumulative ? "active" : ""}"
              @click=${() => onModeChange("per-turn")}
            >
              Per Turn
            </button>
            <button
              class="toggle-btn ${isCumulative ? "active" : ""}"
              @click=${() => onModeChange("cumulative")}
            >
              Cumulative
            </button>
          </div>
          ${
            !isCumulative
              ? html`
                  <div class="chart-toggle small">
                    <button
                      class="toggle-btn ${breakdownMode === "total" ? "active" : ""}"
                      @click=${() => onBreakdownChange("total")}
                    >
                      Total
                    </button>
                    <button
                      class="toggle-btn ${breakdownMode === "by-type" ? "active" : ""}"
                      @click=${() => onBreakdownChange("by-type")}
                    >
                      By Type
                    </button>
                  </div>
                `
              : nothing
          }
        </div>
      </div>
      <svg viewBox="0 0 ${width} ${height + 15}" class="timeseries-svg" style="width: 100%; height: auto;">
        <!-- Y axis -->
        <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + chartHeight}" stroke="var(--border)" />
        <!-- X axis -->
        <line x1="${padding.left}" y1="${padding.top + chartHeight}" x2="${width - padding.right}" y2="${padding.top + chartHeight}" stroke="var(--border)" />
        <!-- Y axis labels -->
        <text x="${padding.left - 4}" y="${padding.top + 4}" text-anchor="end" class="axis-label" style="font-size: 9px; fill: var(--text-muted)">${formatTokens(maxValue)}</text>
        <text x="${padding.left - 4}" y="${padding.top + chartHeight}" text-anchor="end" class="axis-label" style="font-size: 9px; fill: var(--text-muted)">0</text>
        <!-- X axis labels (first and last) -->
        ${
          points.length > 0
            ? svg`
          <text x="${padding.left}" y="${padding.top + chartHeight + 12}" text-anchor="start" style="font-size: 8px; fill: var(--text-muted)">${new Date(points[0].timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</text>
          <text x="${width - padding.right}" y="${padding.top + chartHeight + 12}" text-anchor="end" style="font-size: 8px; fill: var(--text-muted)">${new Date(points[points.length - 1].timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</text>
        `
            : nothing
        }
        <!-- Bars -->
        ${points.map((p, i) => {
          const val = barTotals[i];
          const x = padding.left + i * (barWidth + barGap);
          const barHeight = (val / maxValue) * chartHeight;
          const y = padding.top + chartHeight - barHeight;
          const date = new Date(p.timestamp);
          const tooltipLines = [
            date.toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }),
            `${formatTokens(val)} tokens`,
          ];
          if (breakdownByType) {
            tooltipLines.push(`Output ${formatTokens(p.output)}`);
            tooltipLines.push(`Input ${formatTokens(p.input)}`);
            tooltipLines.push(`Cache write ${formatTokens(p.cacheWrite)}`);
            tooltipLines.push(`Cache read ${formatTokens(p.cacheRead)}`);
          }
          const tooltip = tooltipLines.join(" · ");
          if (!breakdownByType) {
            return svg`<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" class="ts-bar" rx="1" style="cursor: pointer;"><title>${tooltip}</title></rect>`;
          }
          const segments = [
            { value: p.output, class: "output" },
            { value: p.input, class: "input" },
            { value: p.cacheWrite, class: "cache-write" },
            { value: p.cacheRead, class: "cache-read" },
          ];
          let yCursor = padding.top + chartHeight;
          return svg`
            ${segments.map((seg) => {
              if (seg.value <= 0 || val <= 0) {
                return nothing;
              }
              const segHeight = barHeight * (seg.value / val);
              yCursor -= segHeight;
              return svg`<rect x="${x}" y="${yCursor}" width="${barWidth}" height="${segHeight}" class="ts-bar ${seg.class}" rx="1"><title>${tooltip}</title></rect>`;
            })}
          `;
        })}
      </svg>
      <div class="timeseries-summary">${points.length} msgs · ${formatTokens(cumTokens)} · ${formatCost(cumCost)}</div>
      ${
        breakdownByType
          ? html`
              <div style="margin-top: 8px;">
                <div class="card-title" style="font-size: 12px; margin-bottom: 6px;">Tokens by Type</div>
                <div class="cost-breakdown-bar" style="height: 18px;">
                  <div class="cost-segment output" style="width: ${pct(sumOutput, totalTypeTokens).toFixed(1)}%"></div>
                  <div class="cost-segment input" style="width: ${pct(sumInput, totalTypeTokens).toFixed(1)}%"></div>
                  <div class="cost-segment cache-write" style="width: ${pct(sumCacheWrite, totalTypeTokens).toFixed(1)}%"></div>
                  <div class="cost-segment cache-read" style="width: ${pct(sumCacheRead, totalTypeTokens).toFixed(1)}%"></div>
                </div>
                <div class="cost-breakdown-legend">
                  <div class="legend-item" title="Assistant output tokens">
                    <span class="legend-dot output"></span>Output ${formatTokens(sumOutput)}
                  </div>
                  <div class="legend-item" title="User + tool input tokens">
                    <span class="legend-dot input"></span>Input ${formatTokens(sumInput)}
                  </div>
                  <div class="legend-item" title="Tokens written to cache">
                    <span class="legend-dot cache-write"></span>Cache Write ${formatTokens(sumCacheWrite)}
                  </div>
                  <div class="legend-item" title="Tokens read from cache">
                    <span class="legend-dot cache-read"></span>Cache Read ${formatTokens(sumCacheRead)}
                  </div>
                </div>
                <div class="cost-breakdown-total">Total: ${formatTokens(totalTypeTokens)}</div>
              </div>
            `
          : nothing
      }
    </div>
  `;
}

function renderContextPanel(
  contextWeight: UsageSessionEntry["contextWeight"],
  usage: UsageSessionEntry["usage"],
  expanded: boolean,
  onToggleExpanded: () => void,
) {
  if (!contextWeight) {
    return html`
      <div class="context-details-panel">
        <div class="muted" style="padding: 20px; text-align: center">No context data</div>
      </div>
    `;
  }
  const systemTokens = charsToTokens(contextWeight.systemPrompt.chars);
  const skillsTokens = charsToTokens(contextWeight.skills.promptChars);
  const toolsTokens = charsToTokens(
    contextWeight.tools.listChars + contextWeight.tools.schemaChars,
  );
  const filesTokens = charsToTokens(
    contextWeight.injectedWorkspaceFiles.reduce((sum, f) => sum + f.injectedChars, 0),
  );
  const totalContextTokens = systemTokens + skillsTokens + toolsTokens + filesTokens;

  let contextPct = "";
  if (usage && usage.totalTokens > 0) {
    const inputTokens = usage.input + usage.cacheRead;
    if (inputTokens > 0) {
      contextPct = `~${Math.min((totalContextTokens / inputTokens) * 100, 100).toFixed(0)}% of input`;
    }
  }

  const skillsList = contextWeight.skills.entries.toSorted((a, b) => b.blockChars - a.blockChars);
  const toolsList = contextWeight.tools.entries.toSorted(
    (a, b) => b.summaryChars + b.schemaChars - (a.summaryChars + a.schemaChars),
  );
  const filesList = contextWeight.injectedWorkspaceFiles.toSorted(
    (a, b) => b.injectedChars - a.injectedChars,
  );
  const defaultLimit = 4;
  const showAll = expanded;
  const skillsTop = showAll ? skillsList : skillsList.slice(0, defaultLimit);
  const toolsTop = showAll ? toolsList : toolsList.slice(0, defaultLimit);
  const filesTop = showAll ? filesList : filesList.slice(0, defaultLimit);
  const hasMore =
    skillsList.length > defaultLimit ||
    toolsList.length > defaultLimit ||
    filesList.length > defaultLimit;

  return html`
    <div class="context-details-panel">
      <div class="context-breakdown-header">
        <div class="card-title" style="font-size: 13px;">System Prompt Breakdown</div>
        ${
          hasMore
            ? html`<button class="context-expand-btn" @click=${onToggleExpanded}>
                ${showAll ? "Collapse" : "Expand all"}
              </button>`
            : nothing
        }
      </div>
      <p class="context-weight-desc">${contextPct || "Base context per message"}</p>
      <div class="context-stacked-bar">
        <div class="context-segment system" style="width: ${pct(systemTokens, totalContextTokens).toFixed(1)}%" title="System: ~${formatTokens(systemTokens)}"></div>
        <div class="context-segment skills" style="width: ${pct(skillsTokens, totalContextTokens).toFixed(1)}%" title="Skills: ~${formatTokens(skillsTokens)}"></div>
        <div class="context-segment tools" style="width: ${pct(toolsTokens, totalContextTokens).toFixed(1)}%" title="Tools: ~${formatTokens(toolsTokens)}"></div>
        <div class="context-segment files" style="width: ${pct(filesTokens, totalContextTokens).toFixed(1)}%" title="Files: ~${formatTokens(filesTokens)}"></div>
      </div>
      <div class="context-legend">
        <span class="legend-item"><span class="legend-dot system"></span>Sys ~${formatTokens(systemTokens)}</span>
        <span class="legend-item"><span class="legend-dot skills"></span>Skills ~${formatTokens(skillsTokens)}</span>
        <span class="legend-item"><span class="legend-dot tools"></span>Tools ~${formatTokens(toolsTokens)}</span>
        <span class="legend-item"><span class="legend-dot files"></span>Files ~${formatTokens(filesTokens)}</span>
      </div>
      <div class="context-total">Total: ~${formatTokens(totalContextTokens)}</div>
      <div class="context-breakdown-grid">
        ${
          skillsList.length > 0
            ? (() => {
                const more = skillsList.length - skillsTop.length;
                return html`
                  <div class="context-breakdown-card">
                    <div class="context-breakdown-title">Skills (${skillsList.length})</div>
                    <div class="context-breakdown-list">
                      ${skillsTop.map(
                        (s) => html`
                          <div class="context-breakdown-item">
                            <span class="mono">${s.name}</span>
                            <span class="muted">~${formatTokens(charsToTokens(s.blockChars))}</span>
                          </div>
                        `,
                      )}
                    </div>
                    ${
                      more > 0
                        ? html`<div class="context-breakdown-more">+${more} more</div>`
                        : nothing
                    }
                  </div>
                `;
              })()
            : nothing
        }
        ${
          toolsList.length > 0
            ? (() => {
                const more = toolsList.length - toolsTop.length;
                return html`
                  <div class="context-breakdown-card">
                    <div class="context-breakdown-title">Tools (${toolsList.length})</div>
                    <div class="context-breakdown-list">
                      ${toolsTop.map(
                        (t) => html`
                          <div class="context-breakdown-item">
                            <span class="mono">${t.name}</span>
                            <span class="muted">~${formatTokens(charsToTokens(t.summaryChars + t.schemaChars))}</span>
                          </div>
                        `,
                      )}
                    </div>
                    ${
                      more > 0
                        ? html`<div class="context-breakdown-more">+${more} more</div>`
                        : nothing
                    }
                  </div>
                `;
              })()
            : nothing
        }
        ${
          filesList.length > 0
            ? (() => {
                const more = filesList.length - filesTop.length;
                return html`
                  <div class="context-breakdown-card">
                    <div class="context-breakdown-title">Files (${filesList.length})</div>
                    <div class="context-breakdown-list">
                      ${filesTop.map(
                        (f) => html`
                          <div class="context-breakdown-item">
                            <span class="mono">${f.name}</span>
                            <span class="muted">~${formatTokens(charsToTokens(f.injectedChars))}</span>
                          </div>
                        `,
                      )}
                    </div>
                    ${
                      more > 0
                        ? html`<div class="context-breakdown-more">+${more} more</div>`
                        : nothing
                    }
                  </div>
                `;
              })()
            : nothing
        }
      </div>
    </div>
  `;
}

function renderSessionLogsCompact(
  logs: SessionLogEntry[] | null,
  loading: boolean,
  expandedAll: boolean,
  onToggleExpandedAll: () => void,
  filters: {
    roles: SessionLogRole[];
    tools: string[];
    hasTools: boolean;
    query: string;
  },
  onFilterRolesChange: (next: SessionLogRole[]) => void,
  onFilterToolsChange: (next: string[]) => void,
  onFilterHasToolsChange: (next: boolean) => void,
  onFilterQueryChange: (next: string) => void,
  onFilterClear: () => void,
) {
  if (loading) {
    return html`
      <div class="session-logs-compact">
        <div class="session-logs-header">Conversation</div>
        <div class="muted" style="padding: 20px; text-align: center">Loading...</div>
      </div>
    `;
  }
  if (!logs || logs.length === 0) {
    return html`
      <div class="session-logs-compact">
        <div class="session-logs-header">Conversation</div>
        <div class="muted" style="padding: 20px; text-align: center">No messages</div>
      </div>
    `;
  }

  const normalizedQuery = filters.query.trim().toLowerCase();
  const entries = logs.map((log) => {
    const toolInfo = parseToolSummary(log.content);
    const cleanContent = toolInfo.cleanContent || log.content;
    return { log, toolInfo, cleanContent };
  });
  const toolOptions = Array.from(
    new Set(entries.flatMap((entry) => entry.toolInfo.tools.map(([name]) => name))),
  ).toSorted((a, b) => a.localeCompare(b));
  const filteredEntries = entries.filter((entry) => {
    if (filters.roles.length > 0 && !filters.roles.includes(entry.log.role)) {
      return false;
    }
    if (filters.hasTools && entry.toolInfo.tools.length === 0) {
      return false;
    }
    if (filters.tools.length > 0) {
      const matchesTool = entry.toolInfo.tools.some(([name]) => filters.tools.includes(name));
      if (!matchesTool) {
        return false;
      }
    }
    if (normalizedQuery) {
      const haystack = entry.cleanContent.toLowerCase();
      if (!haystack.includes(normalizedQuery)) {
        return false;
      }
    }
    return true;
  });
  const displayedCount =
    filters.roles.length > 0 || filters.tools.length > 0 || filters.hasTools || normalizedQuery
      ? `${filteredEntries.length} of ${logs.length}`
      : `${logs.length}`;

  const roleSelected = new Set(filters.roles);
  const toolSelected = new Set(filters.tools);

  return html`
    <div class="session-logs-compact">
      <div class="session-logs-header">
        <span>Conversation <span style="font-weight: normal; color: var(--text-muted);">(${displayedCount} messages)</span></span>
        <button class="btn btn-sm usage-action-btn usage-secondary-btn" @click=${onToggleExpandedAll}>
          ${expandedAll ? "Collapse All" : "Expand All"}
        </button>
      </div>
      <div class="usage-filters-inline" style="margin: 10px 12px;">
        <select
          multiple
          size="4"
          @change=${(event: Event) =>
            onFilterRolesChange(
              Array.from((event.target as HTMLSelectElement).selectedOptions).map(
                (option) => option.value as SessionLogRole,
              ),
            )}
        >
          <option value="user" ?selected=${roleSelected.has("user")}>User</option>
          <option value="assistant" ?selected=${roleSelected.has("assistant")}>Assistant</option>
          <option value="tool" ?selected=${roleSelected.has("tool")}>Tool</option>
          <option value="toolResult" ?selected=${roleSelected.has("toolResult")}>Tool result</option>
        </select>
        <select
          multiple
          size="4"
          @change=${(event: Event) =>
            onFilterToolsChange(
              Array.from((event.target as HTMLSelectElement).selectedOptions).map(
                (option) => option.value,
              ),
            )}
        >
          ${toolOptions.map(
            (tool) =>
              html`<option value=${tool} ?selected=${toolSelected.has(tool)}>${tool}</option>`,
          )}
        </select>
        <label class="usage-filters-inline" style="gap: 6px;">
          <input
            type="checkbox"
            .checked=${filters.hasTools}
            @change=${(event: Event) =>
              onFilterHasToolsChange((event.target as HTMLInputElement).checked)}
          />
          Has tools
        </label>
        <input
          type="text"
          placeholder="Search conversation"
          .value=${filters.query}
          @input=${(event: Event) => onFilterQueryChange((event.target as HTMLInputElement).value)}
        />
        <button class="btn btn-sm usage-action-btn usage-secondary-btn" @click=${onFilterClear}>
          Clear
        </button>
      </div>
      <div class="session-logs-list">
        ${filteredEntries.map((entry) => {
          const { log, toolInfo, cleanContent } = entry;
          const roleClass = log.role === "user" ? "user" : "assistant";
          const roleLabel =
            log.role === "user" ? "You" : log.role === "assistant" ? "Assistant" : "Tool";
          return html`
          <div class="session-log-entry ${roleClass}">
            <div class="session-log-meta">
              <span class="session-log-role">${roleLabel}</span>
              <span>${new Date(log.timestamp).toLocaleString()}</span>
              ${log.tokens ? html`<span>${formatTokens(log.tokens)}</span>` : nothing}
            </div>
            <div class="session-log-content">${cleanContent}</div>
            ${
              toolInfo.tools.length > 0
                ? html`
                    <details class="session-log-tools" ?open=${expandedAll}>
                      <summary>${toolInfo.summary}</summary>
                      <div class="session-log-tools-list">
                        ${toolInfo.tools.map(
                          ([name, count]) => html`
                            <span class="session-log-tools-pill">${name} × ${count}</span>
                          `,
                        )}
                      </div>
                    </details>
                  `
                : nothing
            }
          </div>
        `;
        })}
        ${
          filteredEntries.length === 0
            ? html`
                <div class="muted" style="padding: 12px">No messages match the filters.</div>
              `
            : nothing
        }
      </div>
    </div>
  `;
}

export {
  renderContextPanel,
  renderEmptyDetailState,
  renderSessionDetailPanel,
  renderSessionLogsCompact,
  renderSessionSummary,
  renderTimeSeriesCompact,
};
