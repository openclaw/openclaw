import { html, nothing, type TemplateResult } from "lit";
import type { AgentHQHistoryResult, AgentHQSummary } from "../types.ts";
import { renderIcon } from "../icons.ts";

export type AgentHQTimelineProps = {
  history: AgentHQHistoryResult | null;
  expandedCommits: Set<string>;
  summaries: Map<string, AgentHQSummary>;
  summaryEnabled: boolean;
  onToggleCommit: (sha: string) => void;
  onSelectFile: (sha: string, fileName: string) => void;
  onGenerateSummary: (sha: string) => void;
};

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function renderAgentHQTimeline(props: AgentHQTimelineProps): TemplateResult {
  if (!props.history || props.history.entries.length === 0) {
    return html`
      <div class="agenthq-empty">
        ${renderIcon("history", "agenthq-empty-icon")}
        <div class="agenthq-empty-title">No History Yet</div>
        <div class="agenthq-empty-desc">
          No changes have been recorded for this agent's workspace files.
        </div>
      </div>
    `;
  }

  return html`
    <div class="agenthq-timeline">
      ${props.history.entries.map((entry) => renderTimelineEntry(entry, props))}
    </div>
  `;
}

function renderTimelineEntry(
  entry: AgentHQHistoryResult["entries"][0],
  props: AgentHQTimelineProps,
): TemplateResult {
  const isExpanded = props.expandedCommits.has(entry.sha);
  const summary = props.summaries.get(entry.sha);
  const totalAdditions = entry.files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = entry.files.reduce((sum, f) => sum + f.deletions, 0);

  return html`
    <div class="agenthq-timeline-entry ${isExpanded ? "expanded" : ""}">
      <div class="agenthq-timeline-dot"></div>
      <div class="agenthq-timeline-header" @click=${() => props.onToggleCommit(entry.sha)}>
        ${renderIcon("chevronRight", "agenthq-timeline-chevron")}
        <div class="agenthq-timeline-title">${entry.message}</div>
        <div class="agenthq-timeline-date">${formatDate(entry.timestamp)}</div>
      </div>
      <div class="agenthq-timeline-body">
        <div class="agenthq-timeline-meta">
          <span>${entry.shortSha}</span>
          <span>•</span>
          <span>${formatTime(entry.timestamp)}</span>
          <span>•</span>
          <span class="agenthq-evolution-stat additions">+${totalAdditions}</span>
          <span class="agenthq-evolution-stat deletions">-${totalDeletions}</span>
        </div>

        ${
          props.summaryEnabled && summary
            ? html`
              <div class="agenthq-summary-card">
                <div class="agenthq-summary-card-header">
                  ${renderIcon("brain", "agenthq-summary-card-icon")}
                  <div class="agenthq-summary-card-title">AI Summary</div>
                </div>
                <div class="agenthq-summary-changes">
                  ${summary.changes.map(
                    (change) => html` <div class="agenthq-summary-change">${change}</div> `,
                  )}
                </div>
                ${
                  summary.impact
                    ? html`
                      <div class="agenthq-summary-impact">
                        <div class="agenthq-summary-impact-label">Impact</div>
                        ${summary.impact}
                      </div>
                    `
                    : nothing
                }
              </div>
            `
            : props.summaryEnabled && !summary
              ? html`
                <button
                  class="agenthq-filter-chip"
                  @click=${() => props.onGenerateSummary(entry.sha)}
                >
                  ${renderIcon("brain", "agenthq-tab-icon")} Generate Summary
                </button>
              `
              : nothing
        }

        <div class="agenthq-timeline-files">
          ${entry.files.map(
            (file) => html`
              <div
                class="agenthq-timeline-file"
                @click=${() => props.onSelectFile(entry.sha, file.name)}
              >
                <span class="agenthq-timeline-file-name">${file.name}</span>
                <div class="agenthq-timeline-file-stats">
                  <span class="agenthq-evolution-stat additions">+${file.additions}</span>
                  <span class="agenthq-evolution-stat deletions">-${file.deletions}</span>
                </div>
              </div>
            `,
          )}
        </div>
      </div>
    </div>
  `;
}
