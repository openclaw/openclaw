/**
 * Session Detail view – shows transcript with per-message token stats,
 * run list for the session, and token usage breakdown.
 */

import { html, nothing } from "lit";
import { formatRelativeTimestamp } from "../format.ts";
import type { SessionDetail, TranscriptEntry, RunListEntry } from "../types/console-types.ts";

export type SessionDetailProps = {
  loading: boolean;
  error: string | null;
  detail: SessionDetail | null;
  onClose: () => void;
  onSelectRun: (runId: string) => void;
};

function roleBadgeClass(role: string): string {
  switch (role) {
    case "user":
      return "data-table-badge--direct";
    case "assistant":
      return "data-table-badge--group";
    case "system":
      return "data-table-badge--global";
    case "tool":
      return "data-table-badge--unknown";
    default:
      return "";
  }
}

function roleIcon(role: string): string {
  switch (role) {
    case "user":
      return "\uD83D\uDC64";
    case "assistant":
      return "\uD83E\uDD16";
    case "system":
      return "\u2699";
    case "tool":
      return "\uD83D\uDD27";
    default:
      return "\u2022";
  }
}

function renderTranscriptEntry(entry: TranscriptEntry): unknown {
  return html`
    <div class="transcript-entry transcript-entry--${entry.role}">
      <div class="transcript-entry-header">
        <span class="data-table-badge ${roleBadgeClass(entry.role)}">${entry.role}</span>
        ${entry.toolName ? html`<span class="mono" style="font-size: 12px; color: var(--ok);">${entry.toolName}</span>` : nothing}
        ${entry.runId ? html`<span class="mono muted" style="font-size: 11px;">run: ${entry.runId}</span>` : nothing}
        <span class="muted" style="font-size: 12px; margin-left: auto;">${formatRelativeTimestamp(entry.timestamp)}</span>
        <span class="transcript-token-count">${entry.tokens} tok</span>
      </div>
      <div class="transcript-entry-content">
        <pre class="transcript-text">${entry.content}</pre>
      </div>
    </div>
  `;
}

function renderRunList(runs: RunListEntry[], onSelectRun: (runId: string) => void): unknown {
  return html`
    <div class="session-detail-runs">
      <div class="card-subtitle">Runs in this Session</div>
      <div class="data-table-container" style="margin-top: 8px;">
        <table class="data-table">
          <thead>
            <tr>
              <th>Run ID</th>
              <th>Status</th>
              <th>Tokens</th>
              <th>Tools</th>
              <th>Started</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${runs.map(
              (run) => html`
                <tr>
                  <td><span class="mono">${run.runId}</span></td>
                  <td>
                    <span class="data-table-badge ${run.status === "success" ? "data-table-badge--direct" : run.status === "error" ? "data-table-badge--unknown" : "data-table-badge--group"}">
                      ${run.status}
                    </span>
                  </td>
                  <td>${run.totalTokens.total.toLocaleString()}</td>
                  <td>${run.toolCallCount}</td>
                  <td>${formatRelativeTimestamp(run.startedAt)}</td>
                  <td>
                    <button class="btn btn--sm" @click=${() => onSelectRun(run.runId)}>
                      View Trace
                    </button>
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderTokenBreakdown(tokens: { input: number; output: number; total: number }): unknown {
  const inputPct = tokens.total > 0 ? Math.round((tokens.input / tokens.total) * 100) : 0;
  const outputPct = 100 - inputPct;
  return html`
    <div class="session-token-breakdown">
      <div class="card-subtitle">Token Usage</div>
      <div class="session-token-stats">
        <div class="session-token-stat">
          <span class="session-token-stat-label">Input</span>
          <span class="session-token-stat-value">${tokens.input.toLocaleString()}</span>
        </div>
        <div class="session-token-stat">
          <span class="session-token-stat-label">Output</span>
          <span class="session-token-stat-value">${tokens.output.toLocaleString()}</span>
        </div>
        <div class="session-token-stat">
          <span class="session-token-stat-label">Total</span>
          <span class="session-token-stat-value" style="font-weight: 600;">${tokens.total.toLocaleString()}</span>
        </div>
      </div>
      <div class="session-token-bar">
        <div class="session-token-bar__input" style="width: ${inputPct}%;" title="Input: ${inputPct}%"></div>
        <div class="session-token-bar__output" style="width: ${outputPct}%;" title="Output: ${outputPct}%"></div>
      </div>
      <div class="session-token-bar-legend">
        <span><span class="prompt-composition-legend-dot" style="background: var(--info);"></span> Input (${inputPct}%)</span>
        <span><span class="prompt-composition-legend-dot" style="background: var(--accent);"></span> Output (${outputPct}%)</span>
      </div>
    </div>
  `;
}

export function renderSessionDetail(props: SessionDetailProps) {
  const detail = props.detail;

  return html`
    <div class="session-detail-overlay">
      <section class="card session-detail-card">
        <div class="row" style="justify-content: space-between; margin-bottom: 16px;">
          <div>
            <div class="card-title">
              Session Detail
              ${detail ? html`<span class="mono" style="font-size: 13px; margin-left: 8px; color: var(--muted);">${detail.key}</span>` : nothing}
            </div>
            <div class="card-sub">
              ${
                detail
                  ? html`Agent: <strong>${detail.agentId}</strong>
                      \u00B7 ${detail.messageCount} messages
                      \u00B7 ${detail.totalTokens.total.toLocaleString()} tokens
                      \u00B7 Kind: ${detail.kind}`
                  : "Loading session details..."
              }
            </div>
          </div>
          <button class="btn" @click=${props.onClose}>Close</button>
        </div>

        ${
          props.error
            ? html`<div class="callout danger" style="margin-bottom: 12px;">${props.error}</div>`
            : nothing
        }

        ${
          props.loading
            ? html`<div style="text-align: center; padding: 48px; color: var(--muted);">Loading\u2026</div>`
            : nothing
        }

        ${
          detail
            ? html`
                <!-- Token breakdown -->
                ${renderTokenBreakdown(detail.totalTokens)}

                <!-- Transcript -->
                <div class="session-transcript">
                  <div class="card-subtitle" style="margin-bottom: 8px;">Transcript</div>
                  ${detail.transcript.map(renderTranscriptEntry)}
                </div>

                <!-- Runs -->
                ${renderRunList(detail.runs, props.onSelectRun)}
              `
            : nothing
        }
      </section>
    </div>
  `;
}
