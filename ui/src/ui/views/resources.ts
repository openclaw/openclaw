import { html, nothing } from "lit";
import type { AgentResourcesResult } from "../controllers/agent-resources.ts";
import { icons } from "../icons.ts";
import { renderEmptyState, renderSpinner } from "../render-utils.ts";

export type ResourcesProps = {
  loading: boolean;
  error: string | null;
  data: AgentResourcesResult | null;
  onRefresh: () => void;
};

function formatNumber(n: number | null | undefined): string {
  if (n == null) {
    return "0";
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }
  return String(n);
}

function formatUsd(n: number | null | undefined): string {
  if (n == null || n === 0) {
    return "$0.00";
  }
  if (n < 0.01) {
    return `$${n.toFixed(4)}`;
  }
  return `$${n.toFixed(2)}`;
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let n = bytes;
  let idx = 0;
  while (n >= 1024 && idx < units.length - 1) {
    n /= 1024;
    idx += 1;
  }
  const decimals = idx === 0 ? 0 : n < 10 ? 2 : 1;
  return `${n.toFixed(decimals)} ${units[idx]}`;
}

function formatHeartbeat(everyMs: number | null, enabled: boolean, label?: string): string {
  if (!enabled) {
    return "off";
  }
  if (label && label !== "n/a") {
    return label;
  }
  if (!everyMs) {
    return "on";
  }
  const minutes = Math.round(everyMs / 60_000);
  if (minutes <= 0) {
    return `${everyMs}ms`;
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

export function renderResources(props: ResourcesProps) {
  const agents = props.data?.agents ?? [];
  const hasData = agents.length > 0;

  const totals = agents.reduce(
    (acc, row) => {
      acc.sessionsTotal += row.sessions.total;
      acc.sessionsActive += row.sessions.active;
      acc.tokensTotal += row.tokens.total;
      acc.costTotal += row.cost.total;
      acc.workspaceBytes += row.workspace.totalBytes;
      return acc;
    },
    {
      sessionsTotal: 0,
      sessionsActive: 0,
      tokensTotal: 0,
      costTotal: 0,
      workspaceBytes: 0,
    },
  );

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: flex-start;">
        <div>
          <div class="card-title">Resources</div>
          <div class="card-sub">
            Per-agent snapshot: sessions, tokens, cost, heartbeat cadence, and workspace footprint.
          </div>
        </div>
        <div class="row" style="gap: 8px;">
          <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>

      ${
        props.error
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
          : nothing
      }

      ${
        props.loading && !hasData
          ? renderSpinner("Loading agent resources...")
          : !hasData
            ? renderEmptyState({
                icon: icons.barChart,
                title: "No agent resource data",
                subtitle:
                  "This data appears after the gateway tracks agents and sessions (agents.resources).",
              })
            : html`
              <section class="grid grid-cols-4" style="margin-top: 16px;">
                <div class="card stat-card">
                  <div class="stat-label">Agents</div>
                  <div class="stat-value">${agents.length}</div>
                  <div class="muted">Known agents in this gateway.</div>
                </div>
                <div class="card stat-card">
                  <div class="stat-label">Sessions</div>
                  <div class="stat-value">${totals.sessionsActive}/${totals.sessionsTotal}</div>
                  <div class="muted">Active / total tracked.</div>
                </div>
                <div class="card stat-card">
                  <div class="stat-label">Tokens</div>
                  <div class="stat-value">${formatNumber(totals.tokensTotal)}</div>
                  <div class="muted">Input + output total.</div>
                </div>
                <div class="card stat-card">
                  <div class="stat-label">Cost</div>
                  <div class="stat-value">${formatUsd(totals.costTotal)}</div>
                  <div class="muted">Estimated total (windowed).</div>
                </div>
              </section>

              <div class="callout" style="margin-top: 14px;">
                <div style="font-weight: 600; margin-bottom: 4px;">How to read this</div>
                <div class="muted" style="font-size: 12px;">
                  <div>
                    <span class="mono">Sessions</span> counts are what the gateway has observed.
                    <span class="mono">Active</span> typically means recently alive / running.
                  </div>
                  <div>
                    <span class="mono">Tokens</span>/<span class="mono">Cost</span> depend on provider
                    reporting and may be partial when credentials are missing.
                  </div>
                  <div>
                    <span class="mono">Heartbeat</span> helps spot “sleeping” agents or overly chatty
                    heartbeats.
                  </div>
                </div>
              </div>

              <div style="margin-top: 16px; overflow: auto;">
                <table class="table" style="width: 100%; min-width: 860px;">
                  <thead>
                    <tr>
                      <th style="text-align: left;">Agent</th>
                      <th style="text-align: left;">Default</th>
                      <th style="text-align: right;">Sessions</th>
                      <th style="text-align: right;">Tokens</th>
                      <th style="text-align: right;">Cost</th>
                      <th style="text-align: right;">Heartbeat</th>
                      <th style="text-align: right;">Workspace</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${agents
                      .toSorted((a, b) => {
                        if (a.isDefault !== b.isDefault) {
                          return a.isDefault ? -1 : 1;
                        }
                        return a.agentId.localeCompare(b.agentId);
                      })
                      .map(
                        (row) => html`
                          <tr>
                            <td style="text-align: left; font-weight: 600;">${row.agentId}</td>
                            <td style="text-align: left;">${row.isDefault ? "yes" : ""}</td>
                            <td style="text-align: right;" class="mono">
                              ${row.sessions.active}/${row.sessions.total}
                            </td>
                            <td style="text-align: right;" class="mono">
                              ${formatNumber(row.tokens.total)}
                              <span class="muted" style="font-size: 12px;">(${formatNumber(row.tokens.input)} in / ${formatNumber(row.tokens.output)} out)</span>
                            </td>
                            <td style="text-align: right;" class="mono">
                              ${formatUsd(row.cost.total)}
                              <span class="muted" style="font-size: 12px;">/${row.cost.days}d</span>
                            </td>
                            <td style="text-align: right;" class="mono">
                              ${formatHeartbeat(row.heartbeat.everyMs, row.heartbeat.enabled, row.heartbeat.every)}
                            </td>
                            <td style="text-align: right;" class="mono">
                              ${formatBytes(row.workspace.totalBytes)}
                              <span class="muted" style="font-size: 12px;">(${formatNumber(row.workspace.files)} files)</span>
                            </td>
                          </tr>
                        `,
                      )}
                  </tbody>
                </table>
              </div>
            `
      }
    </section>
  `;
}
