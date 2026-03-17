/**
 * Run Trace view – displays a list of recent runs and a flow visualization
 * of the selected run's call chain (inbound → routing → prompt → model → tools → outbound).
 * Subagent nodes are clickable to expand their internal trace.
 */

import { html, nothing } from "lit";
import { formatRelativeTimestamp } from "../format.ts";
import { renderTraceFlow, renderSubagentDetail } from "../components/trace-flow.ts";
import type { RunListEntry, RunTrace, TraceNode } from "../types/console-types.ts";

export type ConsoleTraceProps = {
  loading: boolean;
  error: string | null;
  runList: RunListEntry[];
  selectedRunId: string | null;
  activeRun: RunTrace | null;
  subagentDetail: TraceNode | null;
  onSelectRun: (runId: string) => void;
  onRefresh: () => void;
  onSubagentClick: (node: TraceNode) => void;
  onSubagentClose: () => void;
};

function statusBadgeClass(status: string): string {
  switch (status) {
    case "success":
      return "data-table-badge--direct";
    case "error":
      return "data-table-badge--unknown";
    case "running":
      return "data-table-badge--group";
    default:
      return "data-table-badge--global";
  }
}

function formatTokens(tokens: { input: number; output: number; total: number }): string {
  return `${tokens.total.toLocaleString()} (${tokens.input.toLocaleString()}/${tokens.output.toLocaleString()})`;
}

export function renderConsoleTrace(props: ConsoleTraceProps) {
  return html`
    <div class="console-trace">
      <!-- Run list panel -->
      <section class="card" style="margin-bottom: 16px;">
        <div class="row" style="justify-content: space-between; margin-bottom: 12px;">
          <div>
            <div class="card-title">Run Trace</div>
            <div class="card-sub">Select a run to visualize its call chain.</div>
          </div>
          <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? "Loading\u2026" : "Refresh"}
          </button>
        </div>

        ${
          props.error
            ? html`<div class="callout danger" style="margin-bottom: 12px;">${props.error}</div>`
            : nothing
        }

        <div class="data-table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>Run ID</th>
                <th>Session</th>
                <th>Agent</th>
                <th>Status</th>
                <th>Tokens</th>
                <th>Tools</th>
                <th>Subagents</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              ${
                props.runList.length === 0
                  ? html`
                      <tr>
                        <td colspan="8" style="text-align: center; padding: 48px 16px; color: var(--muted)">
                          No runs recorded yet.
                        </td>
                      </tr>
                    `
                  : props.runList.map((run) => html`
                      <tr
                        class=${props.selectedRunId === run.runId ? "data-table-row--selected" : ""}
                        style="cursor: pointer;"
                        @click=${() => props.onSelectRun(run.runId)}
                      >
                        <td><span class="mono">${run.runId}</span></td>
                        <td><span class="mono" style="font-size: 12px;">${run.sessionKey}</span></td>
                        <td>${run.agentId}</td>
                        <td>
                          <span class="data-table-badge ${statusBadgeClass(run.status)}">
                            ${run.status}
                          </span>
                        </td>
                        <td>${formatTokens(run.totalTokens)}</td>
                        <td>${run.toolCallCount}</td>
                        <td>${run.subagentCount}</td>
                        <td>${formatRelativeTimestamp(run.startedAt)}</td>
                      </tr>
                    `)
              }
            </tbody>
          </table>
        </div>
      </section>

      <!-- Flow visualization -->
      ${
        props.activeRun
          ? html`
              <section class="card">
                <div class="row" style="justify-content: space-between; margin-bottom: 12px;">
                  <div>
                    <div class="card-title">
                      Call Chain
                      <span class="mono" style="font-size: 13px; margin-left: 8px; color: var(--muted)">
                        ${props.activeRun.runId}
                      </span>
                    </div>
                    <div class="card-sub">
                      ${props.activeRun.nodes.length} nodes
                      \u00B7 ${formatTokens(props.activeRun.totalTokens)} tokens
                      ${props.activeRun.totalDurationMs != null ? html` \u00B7 ${props.activeRun.totalDurationMs}ms` : nothing}
                    </div>
                  </div>
                </div>

                ${renderTraceFlow({
                  nodes: props.activeRun.nodes,
                  edges: props.activeRun.edges,
                  onSubagentClick: props.onSubagentClick,
                })}

                <!-- Node detail on hover/click (meta info) -->
                ${
                  props.activeRun.nodes.length > 0
                    ? html`
                        <div class="trace-legend">
                          <span class="trace-legend-item"><span class="trace-legend-dot" style="background: var(--info)"></span> Inbound/Outbound</span>
                          <span class="trace-legend-item"><span class="trace-legend-dot" style="background: var(--accent-2)"></span> Router</span>
                          <span class="trace-legend-item"><span class="trace-legend-dot" style="background: var(--warn)"></span> Prompt Assembly</span>
                          <span class="trace-legend-item"><span class="trace-legend-dot" style="background: var(--accent)"></span> Model Call</span>
                          <span class="trace-legend-item"><span class="trace-legend-dot" style="background: var(--ok)"></span> Tool Call</span>
                          <span class="trace-legend-item"><span class="trace-legend-dot" style="background: #a78bfa"></span> Subagent</span>
                        </div>
                      `
                    : nothing
                }
              </section>

              <!-- Subagent detail panel (overlay) -->
              ${
                props.subagentDetail
                  ? renderSubagentDetail(props.subagentDetail, props.onSubagentClose)
                  : nothing
              }
            `
          : nothing
      }
    </div>
  `;
}
