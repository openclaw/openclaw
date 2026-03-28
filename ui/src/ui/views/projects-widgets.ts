import { html, nothing } from "lit";
import type { ProjectListEntry, BoardIndex, QueueIndex } from "../controllers/projects.ts";
import { formatRelativeTimestamp } from "../format.ts";

/**
 * Widget 1: Project status overview with key stats.
 * Accepts optional board to derive total task count (plan says "from board").
 */
export function renderProjectStatusWidget(
  project: ProjectListEntry,
  board?: BoardIndex | null,
) {
  const totalTasks = board
    ? board.columns.reduce((sum, col) => sum + col.tasks.length, 0)
    : 0;
  const statusOk = project.status.toLowerCase() === "active";
  const updatedTs = project.updated ?? project.indexedAt;
  const updatedMs = updatedTs ? new Date(updatedTs).getTime() : null;

  return html`
    <div class="card projects-widget stagger-1">
      <div class="card-title">Status</div>
      <div class="stat-grid">
        <div class="stat-cell">
          <div class="stat-label">STATUS</div>
          <div class="stat-value ${statusOk ? "ok" : "warn"}">${project.status}</div>
        </div>
        <div class="stat-cell">
          <div class="stat-label">TASKS</div>
          <div class="stat-value">${totalTasks}</div>
        </div>
        <div class="stat-cell">
          <div class="stat-label">OWNER</div>
          <div class="stat-value">${project.owner ?? "\u2014"}</div>
        </div>
        <div class="stat-cell">
          <div class="stat-label">UPDATED</div>
          <div class="stat-value">${updatedMs ? formatRelativeTimestamp(updatedMs) : "n/a"}</div>
        </div>
      </div>
    </div>
  `;
}

/**
 * Widget 2: Task counts stacked bar with per-column breakdown.
 */
export function renderTaskCountsWidget(board: BoardIndex | null) {
  const columns = board?.columns ?? [];
  const total = columns.reduce((sum, col) => sum + col.tasks.length, 0);

  return html`
    <div class="card projects-widget stagger-2">
      <div class="card-title">Tasks</div>
      ${total === 0
        ? html`<div class="muted">No tasks</div>`
        : html`
            <div class="projects-bar">
              ${columns
                .filter((col) => col.tasks.length > 0)
                .map((col) => {
                  const pct = (col.tasks.length / total) * 100;
                  const modifier = columnModifier(col.name);
                  return html`
                    <div
                      class="projects-bar__segment ${modifier}"
                      style="flex-basis: ${pct}%"
                    >${col.tasks.length}</div>
                  `;
                })}
            </div>
            <div class="projects-bar-legend">
              ${columns
                .filter((col) => col.tasks.length > 0)
                .map(
                  (col) => html`
                    <span class="projects-bar-legend__item">
                      <span class="projects-bar-legend__dot ${columnModifier(col.name)}"></span>
                      ${col.tasks.length} ${col.name}
                    </span>
                  `,
                )}
            </div>
          `}
    </div>
  `;
}

/**
 * Widget 3: Active agents with pulsing status dots.
 */
export function renderActiveAgentsWidget(queue: QueueIndex | null) {
  const claimed = queue?.claimed ?? [];

  return html`
    <div class="card projects-widget stagger-3">
      <div class="card-title">Active Agents</div>
      ${claimed.length === 0
        ? html`
            <div class="projects-empty">
              <div class="projects-empty__title">No active agents</div>
              <div class="projects-empty__hint">
                No agents are currently working on tasks in this project.
              </div>
            </div>
          `
        : claimed.map((entry) => {
            const agentName =
              entry.metadata.agent ?? entry.metadata.claimed_by ?? "Unknown";
            const claimedAt = entry.metadata.claimed_at
              ? new Date(entry.metadata.claimed_at).getTime()
              : null;
            return html`
              <div class="projects-agent-row">
                <span class="statusDot ok"></span>
                <span class="projects-agent-name">${agentName}</span>
                <span class="projects-agent-task">${entry.taskId}</span>
                <span class="projects-agent-time">
                  ${claimedAt ? formatRelativeTimestamp(claimedAt) : ""}
                </span>
              </div>
            `;
          })}
    </div>
  `;
}

/**
 * Widget 4: Recent activity derived from board task positions.
 *
 * Note (D-11): The gateway RPC responses do not include task file log entries.
 * This widget shows task state changes derived from board column positions as
 * a pragmatic approximation. Full log-entry activity requires a future endpoint.
 */
export function renderRecentActivityWidget(
  board: BoardIndex | null,
  queue: QueueIndex | null,
) {
  const columns = board?.columns ?? [];
  const allEmpty = columns.every((col) => col.tasks.length === 0);

  if (!board || allEmpty) {
    return html`
      <div class="card projects-widget stagger-4">
        <div class="card-title">Recent Activity</div>
        <div class="projects-empty">
          <div class="projects-empty__title">No recent activity</div>
          <div class="projects-empty__hint">
            Task changes and agent actions will appear here.
          </div>
        </div>
      </div>
    `;
  }

  // Build activity entries from board tasks, sorted by column priority
  // (In Progress first, Done last), limited to 10 entries.
  const COLUMN_PRIORITY: Record<string, number> = {
    "in progress": 0,
    review: 1,
    backlog: 2,
    blocked: 3,
    done: 4,
  };

  type ActivityEntry = {
    taskId: string;
    title: string;
    claimedBy: string;
    columnName: string;
    priority: number;
  };

  const entries: ActivityEntry[] = [];
  for (const col of columns) {
    const priority = COLUMN_PRIORITY[col.name.toLowerCase()] ?? 2;
    for (const task of col.tasks) {
      entries.push({
        taskId: task.id,
        title: task.title,
        claimedBy: task.claimed_by ?? "System",
        columnName: col.name,
        priority,
      });
    }
  }
  entries.sort((a, b) => a.priority - b.priority);
  const visible = entries.slice(0, 10);

  const indexedAtMs = board.indexedAt ? new Date(board.indexedAt).getTime() : null;

  return html`
    <div class="card projects-widget stagger-4">
      <div class="card-title">Recent Activity</div>
      ${visible.map(
        (entry) => html`
          <div class="projects-activity-row">
            <span class="projects-activity-time">
              ${indexedAtMs ? formatRelativeTimestamp(indexedAtMs) : ""}
            </span>
            <span class="projects-activity-agent">${entry.claimedBy}</span>
            <span class="projects-activity-action">
              ${entry.taskId}: ${entry.title}
              <span class="muted">(${entry.columnName})</span>
            </span>
          </div>
        `,
      )}
    </div>
  `;
}

// --- Helpers ---

/** Map column name to a BEM modifier class for the stacked bar segment. */
function columnModifier(name: string): string {
  const slug = name.toLowerCase().replace(/\s+/g, "-");
  return `projects-bar__segment--${slug}`;
}

