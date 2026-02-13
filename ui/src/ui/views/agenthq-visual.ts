import { html, nothing, type TemplateResult } from "lit";
import type { AgentHQHistoryResult, AgentHQSummary } from "../types.ts";
import { renderIcon } from "../icons.ts";

export type AgentHQVisualProps = {
  history: AgentHQHistoryResult | null;
  summaries: Map<string, AgentHQSummary>;
  summaryEnabled: boolean;
  onSelectCommit: (sha: string, fileName: string) => void;
  onGenerateSummary: (sha: string) => void;
};

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function renderAgentHQVisual(props: AgentHQVisualProps): TemplateResult {
  if (!props.history || props.history.entries.length === 0) {
    return html`
      <div class="agenthq-empty">
        ${renderIcon("eye", "agenthq-empty-icon")}
        <div class="agenthq-empty-title">No Evolution History</div>
        <div class="agenthq-empty-desc">
          This agent hasn't evolved yet. Changes to workspace files will appear here as visual
          snapshots.
        </div>
      </div>
    `;
  }

  return html`
    <div class="agenthq-visual">
      ${props.history.entries.map((entry) => renderEvolutionCard(entry, props))}
    </div>
  `;
}

function renderEvolutionCard(
  entry: AgentHQHistoryResult["entries"][0],
  props: AgentHQVisualProps,
): TemplateResult {
  const summary = props.summaries.get(entry.sha);
  const totalAdditions = entry.files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = entry.files.reduce((sum, f) => sum + f.deletions, 0);
  const firstFile = entry.files[0]?.name ?? null;

  return html`
    <div
      class="agenthq-evolution-card"
      @click=${() => firstFile && props.onSelectCommit(entry.sha, firstFile)}
    >
      <div class="agenthq-evolution-header">
        <div>
          <div class="agenthq-evolution-date">${formatDate(entry.timestamp)}</div>
          <div class="agenthq-evolution-time">${formatTime(entry.timestamp)}</div>
        </div>
        <div class="agenthq-evolution-sha">${entry.shortSha}</div>
      </div>

      <div class="agenthq-evolution-changes">
        ${entry.files.map((file) => {
          const statusClass =
            file.status === "added" ? "added" : file.status === "deleted" ? "deleted" : "modified";
          return html`
            <div class="agenthq-evolution-file ${statusClass}">
              ${file.name.replace(".md", "")}
            </div>
          `;
        })}
      </div>

      ${
        props.summaryEnabled && summary
          ? html`
            <div class="agenthq-evolution-message">
              ${summary.changes[0] || entry.message}
            </div>
            ${
              summary.evolutionScore > 0
                ? html`
                  <div class="agenthq-summary-score">
                    <div class="agenthq-summary-score-bar">
                      <div
                        class="agenthq-summary-score-fill"
                        style="width: ${summary.evolutionScore}%"
                      ></div>
                    </div>
                    <div class="agenthq-summary-score-value">${summary.evolutionScore}%</div>
                  </div>
                `
                : nothing
            }
          `
          : html` <div class="agenthq-evolution-message">${entry.message}</div> `
      }

      <div class="agenthq-evolution-stats">
        <div class="agenthq-evolution-stat additions">
          ${renderIcon("plus", "agenthq-tab-icon")} ${totalAdditions}
        </div>
        <div class="agenthq-evolution-stat deletions">
          ${renderIcon("minus", "agenthq-tab-icon")} ${totalDeletions}
        </div>
        <div class="agenthq-evolution-stat">
          ${renderIcon("fileText", "agenthq-tab-icon")} ${entry.files.length}
        </div>
      </div>
    </div>
  `;
}
