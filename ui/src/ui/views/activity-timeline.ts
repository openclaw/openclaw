import { html, nothing } from "lit";
import type { TimelineEntry } from "../activity/activity-tree.ts";
import { icons } from "../icons.ts";

function kindColor(kind: string): string {
  switch (kind) {
    case "tool":
      return "var(--color-accent, #5b9bd5)";
    case "thinking":
      return "var(--color-purple, #9b59b6)";
    case "subagent":
      return "var(--color-success, #2ecc71)";
    default:
      return "var(--color-muted, #888)";
  }
}

function kindIcon(kind: string) {
  switch (kind) {
    case "tool":
      return icons.wrench;
    case "thinking":
      return icons.brain;
    case "subagent":
      return icons.folder;
    default:
      return icons.zap;
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function formatDuration(ms: number | null): string {
  if (ms === null) {
    return "";
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

export type ActivityTimelineProps = {
  entries: TimelineEntry[];
};

export function renderActivityTimeline(props: ActivityTimelineProps) {
  if (props.entries.length === 0) {
    return html`<div class="activity-timeline-empty muted">No activity yet.</div>`;
  }

  return html`
    <div class="activity-timeline">
      ${props.entries.map(
        (entry) => html`
          <div
            class="activity-timeline__entry ${entry.isError
              ? "activity-timeline__entry--error"
              : ""}"
          >
            <span class="activity-timeline__ts muted">${formatTime(entry.ts)}</span>
            <span class="activity-timeline__dot" style="color: ${kindColor(entry.kind)}">
              <span class="nav-item__icon">${kindIcon(entry.kind)}</span>
            </span>
            <span class="activity-timeline__label">${entry.label}</span>
            <span class="activity-timeline__status activity-timeline__status--${entry.status}">
              ${entry.status}
            </span>
            ${entry.durationMs !== null
              ? html`<span class="activity-timeline__duration muted"
                  >${formatDuration(entry.durationMs)}</span
                >`
              : nothing}
          </div>
        `,
      )}
    </div>
  `;
}
