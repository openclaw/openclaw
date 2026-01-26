import { html, nothing } from "lit";

export type CostUsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalCost: number;
  missingCostEntries: number;
};

export type CostUsageDailyEntry = CostUsageTotals & {
  date: string;
};

export type CostUsageSummary = {
  updatedAt: number;
  days: number;
  daily: CostUsageDailyEntry[];
  totals: CostUsageTotals;
};

export type UsageWindow = {
  label: string;
  usedPercent: number;
  resetAt?: number;
};

export type ProviderQuota = {
  provider: string;
  displayName: string;
  windows: UsageWindow[];
  plan?: string;
  error?: string;
};

export type UsageSummary = {
  updatedAt: number;
  providers: ProviderQuota[];
};

export type AnalyticsProps = {
  loading: boolean;
  error: string | null;
  data: CostUsageSummary | null;
  quota: ProviderQuota[] | null;
  days: number;
  onDaysChange: (days: number) => void;
  onRefresh: () => void;
};

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

function formatCost(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function formatPercent(n: number): string {
  return `${Math.round(n)}%`;
}

function formatResetTime(timestamp?: number): string {
  if (!timestamp) return "";
  const now = Date.now();
  const diff = timestamp - now;
  if (diff <= 0) return "now";
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function renderBarChart(daily: CostUsageDailyEntry[], metric: "totalTokens" | "totalCost") {
  if (!daily.length) {
    return html`<div class="chart-empty">No data for this period</div>`;
  }

  const values = daily.map((d) => d[metric]);
  const max = Math.max(...values, 1);
  const barWidth = Math.max(8, Math.min(40, Math.floor(600 / daily.length) - 4));

  return html`
    <div class="chart-container">
      <div class="chart-bars">
        ${daily.map((entry) => {
          const value = entry[metric];
          const height = Math.max(2, (value / max) * 150);
          const label = metric === "totalCost" ? formatCost(value) : formatNumber(value);
          const dateLabel = entry.date.slice(5); // MM-DD
          return html`
            <div class="chart-bar-wrapper" style="width: ${barWidth}px">
              <div class="chart-bar-tooltip">${label}</div>
              <div
                class="chart-bar"
                style="height: ${height}px; width: ${barWidth - 2}px"
                title="${entry.date}: ${label}"
              ></div>
              <div class="chart-bar-label">${dateLabel}</div>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}

function renderQuotaBar(percent: number) {
  const color = percent >= 90 ? "var(--danger)" : percent >= 70 ? "var(--warning)" : "var(--accent)";
  return html`
    <div class="quota-bar-container">
      <div class="quota-bar-fill" style="width: ${Math.min(100, percent)}%; background: ${color}"></div>
    </div>
  `;
}

function renderProviderQuota(provider: ProviderQuota) {
  if (provider.error) {
    return html`
      <div class="quota-provider">
        <div class="quota-provider-name">${provider.displayName}</div>
        <div class="quota-error">${provider.error}</div>
      </div>
    `;
  }

  if (!provider.windows.length) {
    return nothing;
  }

  return html`
    <div class="quota-provider">
      <div class="quota-provider-header">
        <div class="quota-provider-name">${provider.displayName}</div>
        ${provider.plan ? html`<div class="quota-plan">${provider.plan}</div>` : nothing}
      </div>
      <div class="quota-windows">
        ${provider.windows.map(
          (w) => html`
            <div class="quota-window">
              <div class="quota-window-header">
                <span class="quota-window-label">${w.label}</span>
                <span class="quota-window-value">${formatPercent(w.usedPercent)} used</span>
              </div>
              ${renderQuotaBar(w.usedPercent)}
              ${w.resetAt ? html`<div class="quota-reset">Resets in ${formatResetTime(w.resetAt)}</div>` : nothing}
            </div>
          `,
        )}
      </div>
    </div>
  `;
}

export function renderAnalytics(props: AnalyticsProps) {
  const { loading, error, data, quota, days } = props;
  const totals = data?.totals;
  const hasQuota = quota && quota.some((p) => p.windows.length > 0);
  const hasQuotaError = quota && quota.some((p) => p.error);
  const quotaEmpty = quota && quota.length === 0;

  return html`
    <style>
      .analytics-controls {
        display: flex;
        gap: 12px;
        align-items: center;
        margin-bottom: 20px;
      }
      .analytics-controls select {
        padding: 6px 12px;
        border-radius: 6px;
        border: 1px solid var(--border);
        background: var(--bg-elevated);
        color: var(--fg);
        font-size: 14px;
      }
      .chart-container {
        overflow-x: auto;
        padding: 20px 0;
      }
      .chart-bars {
        display: flex;
        align-items: flex-end;
        gap: 4px;
        min-height: 180px;
        padding-bottom: 24px;
      }
      .chart-bar-wrapper {
        display: flex;
        flex-direction: column;
        align-items: center;
        position: relative;
      }
      .chart-bar {
        background: var(--accent, #6366f1);
        border-radius: 3px 3px 0 0;
        transition: opacity 0.15s;
      }
      .chart-bar:hover {
        opacity: 0.8;
      }
      .chart-bar-label {
        font-size: 10px;
        color: var(--fg-muted);
        margin-top: 4px;
        white-space: nowrap;
      }
      .chart-bar-tooltip {
        font-size: 11px;
        color: var(--fg-muted);
        margin-bottom: 4px;
        opacity: 0;
        transition: opacity 0.15s;
      }
      .chart-bar-wrapper:hover .chart-bar-tooltip {
        opacity: 1;
      }
      .chart-empty {
        color: var(--fg-muted);
        padding: 40px;
        text-align: center;
      }
      .analytics-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 16px;
        margin-bottom: 24px;
      }
      .analytics-stat {
        background: var(--bg-elevated);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 16px;
      }
      .analytics-stat-label {
        font-size: 12px;
        color: var(--fg-muted);
        margin-bottom: 4px;
      }
      .analytics-stat-value {
        font-size: 24px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .quota-section {
        margin-bottom: 24px;
      }
      .quota-providers {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 16px;
      }
      .quota-provider {
        background: var(--bg-elevated);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 16px;
      }
      .quota-provider-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
      }
      .quota-provider-name {
        font-weight: 600;
        font-size: 14px;
      }
      .quota-plan {
        font-size: 11px;
        color: var(--fg-muted);
        background: var(--bg);
        padding: 2px 8px;
        border-radius: 10px;
      }
      .quota-error {
        color: var(--fg-muted);
        font-size: 12px;
      }
      .quota-windows {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .quota-window {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .quota-window-header {
        display: flex;
        justify-content: space-between;
        font-size: 12px;
      }
      .quota-window-label {
        color: var(--fg-muted);
      }
      .quota-window-value {
        font-weight: 500;
        font-variant-numeric: tabular-nums;
      }
      .quota-bar-container {
        height: 8px;
        background: var(--bg);
        border-radius: 4px;
        overflow: hidden;
      }
      .quota-bar-fill {
        height: 100%;
        border-radius: 4px;
        transition: width 0.3s ease;
      }
      .quota-reset {
        font-size: 11px;
        color: var(--fg-muted);
      }
    </style>

    ${hasQuota || hasQuotaError
      ? html`
          <section class="card">
            <div class="card-title">Plan Quota</div>
            <div class="card-sub">Current usage against your plan limits.</div>
            <div class="quota-providers" style="margin-top: 16px;">
              ${quota!.map((p) => renderProviderQuota(p))}
            </div>
          </section>
        `
      : quotaEmpty
        ? html`
            <section class="card">
              <div class="card-title">Plan Quota</div>
              <div class="card-sub">Current usage against your plan limits.</div>
              <div class="callout" style="margin-top: 16px;">
                No plan quota data available. To see usage limits for Claude Max or other plans,
                configure OAuth authentication with the required scopes.
              </div>
            </section>
          `
        : nothing}

    <section class="card" style="margin-top: ${hasQuota || hasQuotaError || quotaEmpty ? "18px" : "0"};">
      <div class="card-title">Usage Summary</div>
      <div class="card-sub">Token consumption and estimated costs.</div>

      <div class="analytics-controls" style="margin-top: 16px;">
        <label>
          Period:
          <select
            .value=${String(days)}
            @change=${(e: Event) => {
              const value = parseInt((e.target as HTMLSelectElement).value, 10);
              props.onDaysChange(value);
            }}
          >
            <option value="7">Last 7 days</option>
            <option value="14">Last 14 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
          </select>
        </label>
        <button class="btn" @click=${() => props.onRefresh()} ?disabled=${loading}>
          ${loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      ${error ? html`<div class="callout danger">${error}</div>` : nothing}

      ${totals
        ? html`
            <div class="analytics-grid">
              <div class="analytics-stat">
                <div class="analytics-stat-label">Total Tokens</div>
                <div class="analytics-stat-value">${formatNumber(totals.totalTokens)}</div>
              </div>
              <div class="analytics-stat">
                <div class="analytics-stat-label">Input Tokens</div>
                <div class="analytics-stat-value">${formatNumber(totals.input)}</div>
              </div>
              <div class="analytics-stat">
                <div class="analytics-stat-label">Output Tokens</div>
                <div class="analytics-stat-value">${formatNumber(totals.output)}</div>
              </div>
              <div class="analytics-stat">
                <div class="analytics-stat-label">Cache Read</div>
                <div class="analytics-stat-value">${formatNumber(totals.cacheRead)}</div>
              </div>
              <div class="analytics-stat">
                <div class="analytics-stat-label">Cache Write</div>
                <div class="analytics-stat-value">${formatNumber(totals.cacheWrite)}</div>
              </div>
              <div class="analytics-stat">
                <div class="analytics-stat-label">Est. Cost</div>
                <div class="analytics-stat-value">${formatCost(totals.totalCost)}</div>
              </div>
            </div>
          `
        : nothing}
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">Daily Tokens</div>
      <div class="card-sub">Token usage per day.</div>
      ${data?.daily ? renderBarChart(data.daily, "totalTokens") : html`<div class="chart-empty">${loading ? "Loading..." : "No data"}</div>`}
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">Daily Cost</div>
      <div class="card-sub">Estimated cost per day.</div>
      ${data?.daily ? renderBarChart(data.daily, "totalCost") : html`<div class="chart-empty">${loading ? "Loading..." : "No data"}</div>`}
    </section>
  `;
}
