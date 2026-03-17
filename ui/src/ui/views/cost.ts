import { html, nothing, TemplateResult } from "lit";
import type {
  CostState,
  CostSummaryResponse,
  CostTimeseriesResponse,
  LedgerItem,
  ModelCostBreakdownResponse,
  TopSessionsResponse,
} from "../controllers/cost.ts";

function formatCurrency(amount: number): string {
  if (amount < 0.01 && amount > 0) {
    return `$${amount.toFixed(4)}`;
  }
  return `$${amount.toFixed(2)}`;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}K`;
  }
  return count.toString();
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString();
}

function formatDayLabel(dateStr: string): string {
  const parts = dateStr.split("-");
  return `${parts[1]}/${parts[2]}`;
}

const costStyles = `
  .cost-page-header {
    margin: 4px 0 12px;
  }
  .cost-page-title {
    font-size: 28px;
    font-weight: 700;
    letter-spacing: -0.02em;
    margin-bottom: 4px;
  }
  .cost-page-subtitle {
    font-size: 13px;
    color: var(--muted);
    margin: 0 0 12px;
  }
  .cost-filters-inline {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .cost-filters-inline input[type="date"] {
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font-size: 13px;
  }
  .cost-refresh-indicator {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: rgba(255, 77, 77, 0.1);
    border-radius: 4px;
    font-size: 12px;
    color: #ff4d4d;
  }
  .cost-refresh-indicator::before {
    content: "";
    width: 10px;
    height: 10px;
    border: 2px solid #ff4d4d;
    border-top-color: transparent;
    border-radius: 50%;
    animation: cost-spin 0.6s linear infinite;
  }
  @keyframes cost-spin {
    to { transform: rotate(360deg); }
  }
  .cost-action-btn {
    height: 34px;
    padding: 0 14px;
    border-radius: 999px;
    font-weight: 600;
    font-size: 13px;
    line-height: 1;
    border: 1px solid var(--border);
    background: var(--bg-secondary);
    color: var(--text);
    cursor: pointer;
    box-shadow: none;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .cost-action-btn:hover {
    background: var(--bg);
    border-color: var(--border-strong);
  }
  .cost-action-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .cost-primary-btn {
    background: #ff4d4d;
    color: #fff;
    border-color: #ff4d4d;
  }
  .cost-primary-btn:hover {
    background: #e64545;
    border-color: #e64545;
  }
  .cost-preset-btn {
    height: 30px;
    padding: 0 12px;
    border-radius: 6px;
    font-weight: 500;
    font-size: 12px;
    border: 1px solid var(--border);
    background: var(--bg-secondary);
    color: var(--text);
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .cost-preset-btn:hover {
    background: var(--bg-hover);
  }
  .cost-preset-btn.active {
    background: var(--accent);
    color: white;
    border-color: var(--accent);
  }
  .cost-tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }
  .cost-tab {
    padding: 10px 16px;
    border: none;
    background: none;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    color: var(--muted);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    transition: color 0.15s, border-color 0.15s;
  }
  .cost-tab:hover {
    color: var(--text);
  }
  .cost-tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  .cost-kpi-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
    margin-bottom: 20px;
  }
  .cost-kpi-card {
    padding: 16px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 10px;
  }
  .cost-kpi-label {
    font-size: 12px;
    color: var(--muted);
    margin-bottom: 4px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .cost-kpi-value {
    font-size: 24px;
    font-weight: 700;
    color: var(--text);
    letter-spacing: -0.02em;
  }
  .cost-kpi-value.total {
    color: #ff4d4d;
  }
  .cost-chart-container {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px;
    margin-bottom: 20px;
  }
  .cost-chart-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }
  .cost-chart-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }
  .cost-chart-bars {
    display: flex;
    align-items: flex-end;
    gap: 4px;
    height: 160px;
    padding: 8px 0;
  }
  .cost-chart-bar {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 0;
  }
  .cost-chart-bar-stack {
    width: 100%;
    max-width: 32px;
    display: flex;
    flex-direction: column;
    border-radius: 4px 4px 0 0;
    overflow: hidden;
  }
  .cost-chart-bar-segment {
    width: 100%;
    transition: height 0.2s;
  }
  .cost-chart-bar-segment.llm { background: #ff4d4d; }
  .cost-chart-bar-segment.fixed { background: #4dabf7; }
  .cost-chart-bar-segment.one-off { background: #ffd43b; }
  .cost-chart-bar-segment.usage { background: #69db7c; }
  .cost-chart-bar-label {
    font-size: 9px;
    color: var(--muted);
    margin-top: 4px;
    text-align: center;
  }
  .cost-chart-legend {
    display: flex;
    gap: 16px;
    margin-top: 12px;
    justify-content: center;
  }
  .cost-legend-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
  }
  .cost-legend-dot {
    width: 10px;
    height: 10px;
    border-radius: 2px;
  }
  .cost-legend-dot.llm { background: #ff4d4d; }
  .cost-legend-dot.fixed { background: #4dabf7; }
  .cost-legend-dot.one-off { background: #ffd43b; }
  .cost-legend-dot.usage { background: #69db7c; }
  .cost-table-container {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    margin-bottom: 20px;
  }
  .cost-table-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  .cost-table-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }
  .cost-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .cost-table th {
    text-align: left;
    padding: 10px 16px;
    font-weight: 500;
    color: var(--muted);
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .cost-table th.number {
    text-align: right;
  }
  .cost-table td {
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    color: var(--text);
  }
  .cost-table td.number {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .cost-table tr:last-child td {
    border-bottom: none;
  }
  .cost-table tr:hover {
    background: var(--bg-hover);
  }
  .cost-table .provider-row {
    background: var(--bg);
  }
  .cost-table .provider-row:hover {
    background: var(--bg);
  }
  .cost-type-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
    text-transform: uppercase;
  }
  .cost-type-badge.fixed { background: rgba(77, 171, 247, 0.15); color: #4dabf7; }
  .cost-type-badge.usage { background: rgba(105, 219, 124, 0.15); color: #69db7c; }
  .cost-type-badge.one_off { background: rgba(255, 212, 59, 0.15); color: #fab005; }
  .cost-status-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
  }
  .cost-status-badge.active { background: rgba(105, 219, 124, 0.15); color: #69db7c; }
  .cost-status-badge.inactive { background: rgba(134, 142, 150, 0.15); color: #868e96; }
  .cost-ledger-actions {
    display: flex;
    gap: 8px;
  }
  .cost-ledger-btn {
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 12px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    cursor: pointer;
    transition: background 0.15s;
  }
  .cost-ledger-btn:hover {
    background: var(--bg-hover);
  }
  .cost-ledger-btn.primary {
    background: var(--accent);
    color: white;
    border-color: var(--accent);
  }
  .cost-ledger-btn.danger {
    color: #ff4d4d;
    border-color: rgba(255, 77, 77, 0.3);
  }
  .cost-ledger-btn.danger:hover {
    background: rgba(255, 77, 77, 0.1);
  }
  .cost-empty-state {
    text-align: center;
    padding: 40px 20px;
    color: var(--muted);
  }
  .cost-empty-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 8px;
  }
`;

function renderKpiCards(summary: CostSummaryResponse | null): TemplateResult {
  if (!summary) {
    return html`
      <div class="cost-kpi-grid">
        ${[1, 2, 3, 4].map(
          () => html`
            <div class="cost-kpi-card">
              <div class="cost-kpi-label">Loading...</div>
              <div class="cost-kpi-value">—</div>
            </div>
          `,
        )}
      </div>
    `;
  }

  return html`
    <div class="cost-kpi-grid">
      <div class="cost-kpi-card">
        <div class="cost-kpi-label">Total Cost</div>
        <div class="cost-kpi-value total">${formatCurrency(summary.totals.total)}</div>
      </div>
      <div class="cost-kpi-card">
        <div class="cost-kpi-label">LLM Cost</div>
        <div class="cost-kpi-value">${formatCurrency(summary.totals.llm)}</div>
      </div>
      <div class="cost-kpi-card">
        <div class="cost-kpi-label">Fixed Cost</div>
        <div class="cost-kpi-value">${formatCurrency(summary.totals.fixed)}</div>
      </div>
      <div class="cost-kpi-card">
        <div class="cost-kpi-label">One-off</div>
        <div class="cost-kpi-value">${formatCurrency(summary.totals.oneOff)}</div>
      </div>
    </div>
  `;
}

function renderDailyChart(timeseries: CostTimeseriesResponse | null): TemplateResult {
  if (!timeseries || timeseries.series.length === 0) {
    return html`
      <div class="cost-chart-container">
        <div class="cost-chart-header">
          <div class="cost-chart-title">Daily Cost</div>
        </div>
        <div class="cost-empty-state">
          <p>No cost data available for this period</p>
        </div>
      </div>
    `;
  }

  const maxTotal = Math.max(...timeseries.series.map((d) => d.total), 0.01);
  const barMaxWidth =
    timeseries.series.length > 30
      ? 12
      : timeseries.series.length > 20
        ? 18
        : timeseries.series.length > 14
          ? 24
          : 32;

  return html`
    <div class="cost-chart-container">
      <div class="cost-chart-header">
        <div class="cost-chart-title">Daily Cost</div>
      </div>
      <div class="cost-chart-bars" style="--bar-max-width: ${barMaxWidth}px">
        ${timeseries.series.map((day) => {
          const height = Math.max((day.total / maxTotal) * 140, 2);
          const llmHeight = (day.llm / maxTotal) * 140;
          const fixedHeight = (day.fixed / maxTotal) * 140;
          const oneOffHeight = (day.oneOff / maxTotal) * 140;
          const usageHeight = (day.usage / maxTotal) * 140;

          return html`
            <div class="cost-chart-bar" title="${day.date}: ${formatCurrency(day.total)}">
              <div class="cost-chart-bar-stack" style="height: ${height}px">
                ${
                  usageHeight > 0
                    ? html`<div class="cost-chart-bar-segment usage" style="height: ${usageHeight}px"></div>`
                    : nothing
                }
                ${
                  oneOffHeight > 0
                    ? html`<div class="cost-chart-bar-segment one-off" style="height: ${oneOffHeight}px"></div>`
                    : nothing
                }
                ${
                  fixedHeight > 0
                    ? html`<div class="cost-chart-bar-segment fixed" style="height: ${fixedHeight}px"></div>`
                    : nothing
                }
                ${
                  llmHeight > 0
                    ? html`<div class="cost-chart-bar-segment llm" style="height: ${llmHeight}px"></div>`
                    : nothing
                }
              </div>
              <div class="cost-chart-bar-label">${formatDayLabel(day.date)}</div>
            </div>
          `;
        })}
      </div>
      <div class="cost-chart-legend">
        <span class="cost-legend-item"><span class="cost-legend-dot llm"></span> LLM</span>
        <span class="cost-legend-item"><span class="cost-legend-dot fixed"></span> Fixed</span>
        <span class="cost-legend-item"><span class="cost-legend-dot one-off"></span> One-off</span>
        <span class="cost-legend-item"><span class="cost-legend-dot usage"></span> Usage</span>
      </div>
    </div>
  `;
}

function renderModelTable(byModel: ModelCostBreakdownResponse | null): TemplateResult {
  if (!byModel || byModel.byProvider.length === 0) {
    return html`
      <div class="cost-table-container">
        <div class="cost-table-header">
          <div class="cost-table-title">Cost by Model</div>
        </div>
        <div class="cost-empty-state">
          <p>No model usage data available</p>
        </div>
      </div>
    `;
  }

  return html`
    <div class="cost-table-container">
      <div class="cost-table-header">
        <div class="cost-table-title">Cost by Model</div>
      </div>
      <table class="cost-table">
        <thead>
          <tr>
            <th>Provider / Model</th>
            <th class="number">Input</th>
            <th class="number">Output</th>
            <th class="number">Cache R/W</th>
            <th class="number">Calls</th>
            <th class="number">Cost</th>
          </tr>
        </thead>
        <tbody>
          ${byModel.byProvider.flatMap((provider) => [
            html`
              <tr class="provider-row">
                <td colspan="5"><strong>${provider.provider}</strong></td>
                <td class="number"><strong>${formatCurrency(provider.totalCost)}</strong></td>
              </tr>
            `,
            ...provider.models.map(
              (model) => html`
                <tr>
                  <td style="padding-left: 32px">${model.model}</td>
                  <td class="number">${formatTokens(model.inputTokens)}</td>
                  <td class="number">${formatTokens(model.outputTokens)}</td>
                  <td class="number">
                    ${formatTokens(model.cacheReadTokens)} / ${formatTokens(model.cacheWriteTokens)}
                  </td>
                  <td class="number">${model.callCount.toLocaleString()}</td>
                  <td class="number">${formatCurrency(model.totalCost)}</td>
                </tr>
              `,
            ),
          ])}
        </tbody>
      </table>
    </div>
  `;
}

function renderTopSessionsTable(topSessions: TopSessionsResponse | null): TemplateResult {
  if (!topSessions || topSessions.sessions.length === 0) {
    return html`
      <div class="cost-table-container">
        <div class="cost-table-header">
          <div class="cost-table-title">Top Sessions by Cost</div>
        </div>
        <div class="cost-empty-state">
          <p>No session data available</p>
        </div>
      </div>
    `;
  }

  return html`
    <div class="cost-table-container">
      <div class="cost-table-header">
        <div class="cost-table-title">Top Sessions by Cost</div>
      </div>
      <table class="cost-table">
        <thead>
          <tr>
            <th>Session</th>
            <th>Agent</th>
            <th class="number">Tokens</th>
            <th class="number">Cost</th>
            <th>Last Activity</th>
          </tr>
        </thead>
        <tbody>
          ${topSessions.sessions.map(
            (session) => html`
              <tr>
                <td>${session.label || session.sessionId.slice(0, 12)}</td>
                <td>${session.agentId || "—"}</td>
                <td class="number">${formatTokens(session.totalTokens)}</td>
                <td class="number">${formatCurrency(session.totalCost)}</td>
                <td>${session.lastActivity ? formatDate(session.lastActivity) : "—"}</td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
  `;
}

function renderLedgerTable(items: LedgerItem[], onDelete: (id: string) => void): TemplateResult {
  return html`
    <div class="cost-table-container">
      <div class="cost-table-header">
        <div class="cost-table-title">Cost Ledger</div>
        <button class="cost-ledger-btn primary">Add Item</button>
      </div>
      ${
        items.length === 0
          ? html`
              <div class="cost-empty-state">
                <div class="cost-empty-title">No cost items</div>
                <p>Add fixed subscriptions, usage-based costs, or one-off expenses to track them here.</p>
              </div>
            `
          : html`
          <table class="cost-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Vendor</th>
                <th class="number">Amount</th>
                <th>Cycle</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${items.map(
                (item) => html`
                  <tr>
                    <td>${item.name}</td>
                    <td>
                      <span class="cost-type-badge ${item.costType}">${item.costType.replace("_", "-")}</span>
                    </td>
                    <td>${item.vendor || "—"}</td>
                    <td class="number">${formatCurrency(item.amount)}</td>
                    <td>${item.billingCycle || "—"}</td>
                    <td>
                      <span class="cost-status-badge ${item.status}">${item.status}</span>
                    </td>
                    <td>
                      <div class="cost-ledger-actions">
                        <button class="cost-ledger-btn">Edit</button>
                        <button class="cost-ledger-btn danger" @click=${() => onDelete(item.id)}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                `,
              )}
            </tbody>
          </table>
        `
      }
    </div>
  `;
}

export type CostViewProps = {
  state: CostState;
  onDateChange: (startDate: string, endDate: string) => void;
  onPresetClick: (days: number) => void;
  onRefresh: () => void;
  onTabChange: (tab: CostState["activeTab"]) => void;
  onExport: (format: "csv" | "json") => void;
  onDeleteLedgerItem: (id: string) => void;
};

export function renderCost(props: CostViewProps): TemplateResult {
  const {
    state,
    onDateChange,
    onPresetClick,
    onRefresh,
    onTabChange,
    onExport,
    onDeleteLedgerItem,
  } = props;

  const getDaysInRange = (): number => {
    const start = new Date(state.startDate);
    const end = new Date(state.endDate);
    return Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  };

  const days = getDaysInRange();
  const isPresetActive = (presetDays: number) => days === presetDays;

  return html`
    <style>
      ${costStyles}
    </style>
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px;">
        <div style="flex: 1; min-width: 250px;">
          <div class="cost-page-header">
            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 2px;">
              <div class="cost-page-title">Cost Monitor</div>
              ${
                state.loading
                  ? html`
                      <span class="cost-refresh-indicator">Loading</span>
                    `
                  : nothing
              }
            </div>
            <div class="cost-page-subtitle">Track LLM and infrastructure costs</div>
          </div>
        </div>
        <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 8px;">
          <div class="cost-filters-inline">
            <div style="display: flex; gap: 4px;">
              <button
                class="cost-preset-btn ${isPresetActive(7) ? "active" : ""}"
                @click=${() => onPresetClick(7)}
              >7d</button>
              <button
                class="cost-preset-btn ${isPresetActive(30) ? "active" : ""}"
                @click=${() => onPresetClick(30)}
              >30d</button>
              <button
                class="cost-preset-btn ${isPresetActive(90) ? "active" : ""}"
                @click=${() => onPresetClick(90)}
              >90d</button>
            </div>
            <input
              type="date"
              .value=${state.startDate}
              @change=${(e: Event) =>
                onDateChange((e.target as HTMLInputElement).value, state.endDate)}
            />
            <span style="color: var(--muted);">to</span>
            <input
              type="date"
              .value=${state.endDate}
              @change=${(e: Event) =>
                onDateChange(state.startDate, (e.target as HTMLInputElement).value)}
            />
            <button class="cost-action-btn" @click=${onRefresh} ?disabled=${state.loading}>
              Refresh
            </button>
            <button class="cost-action-btn" @click=${() => onExport("csv")}>Export</button>
          </div>
        </div>
      </div>

      <div class="cost-tabs">
        <button
          class="cost-tab ${state.activeTab === "overview" ? "active" : ""}"
          @click=${() => onTabChange("overview")}
        >Overview</button>
        <button
          class="cost-tab ${state.activeTab === "models" ? "active" : ""}"
          @click=${() => onTabChange("models")}
        >Models</button>
        <button
          class="cost-tab ${state.activeTab === "sessions" ? "active" : ""}"
          @click=${() => onTabChange("sessions")}
        >Sessions</button>
        <button
          class="cost-tab ${state.activeTab === "ledger" ? "active" : ""}"
          @click=${() => onTabChange("ledger")}
        >Ledger</button>
      </div>

      ${
        state.error
          ? html`<div style="color: #ff4d4d; padding: 12px; margin-bottom: 16px; background: rgba(255, 77, 77, 0.1); border-radius: 6px;">
            ${state.error}
          </div>`
          : nothing
      }

      ${
        state.activeTab === "overview"
          ? html`
            ${renderKpiCards(state.summary)}
            ${renderDailyChart(state.timeseries)}
            ${renderModelTable(state.byModel)}
          `
          : nothing
      }

      ${state.activeTab === "models" ? renderModelTable(state.byModel) : nothing}

      ${state.activeTab === "sessions" ? renderTopSessionsTable(state.topSessions) : nothing}

      ${
        state.activeTab === "ledger"
          ? renderLedgerTable(state.ledgerItems, onDeleteLedgerItem)
          : nothing
      }
    </section>
  `;
}
