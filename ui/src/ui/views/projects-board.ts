import { html, nothing } from "lit";
import type { BoardIndex, BoardTaskEntry, CheckpointInfo } from "../controllers/projects.ts";

export type KanbanBoardProps = {
  board: BoardIndex | null;
  loading: boolean;
  error: string | null;
  expandedTaskId: string | null;
  checkpoint: CheckpointInfo | null;
  checkpointLoading: boolean;
  allTasks: BoardTaskEntry[];
  onTogglePeek: (taskId: string) => void;
};

export function renderKanbanBoard(props: KanbanBoardProps) {
  if (props.loading) return renderBoardSkeleton();
  if (props.error) return html`<div class="projects-error">${props.error}</div>`;
  if (!props.board) return html`<div class="projects-board-column__empty">No tasks in this project</div>`;

  const columns = props.board.columns;
  if (columns.length === 0) return html`<div class="projects-board-column__empty">No columns configured</div>`;

  return html`
    <div class="projects-board">
      ${columns.map((col) => renderColumn(col, props))}
    </div>
  `;
}

function renderColumn(column: { name: string; tasks: BoardTaskEntry[] }, props: KanbanBoardProps) {
  return html`
    <div class="projects-board-column">
      <div class="projects-board-column__header">
        <span class="projects-board-column__name">${column.name}</span>
        <span class="projects-board-column__count">${column.tasks.length}</span>
      </div>
      <div class="projects-board-column__cards">
        ${column.tasks.length === 0
          ? html`<div class="projects-board-column__empty">No tasks</div>`
          : column.tasks.map((task) => renderCard(task, props))}
      </div>
    </div>
  `;
}

function renderCard(task: BoardTaskEntry, props: KanbanBoardProps) {
  const priorityClass = `projects-board-card--${task.priority || "low"}`;
  const isBlocked = hasUnfinishedDeps(task, props.allTasks);
  const isExpanded = props.expandedTaskId === task.id;

  return html`
    <div class="${`projects-board-card ${priorityClass}`}">
      <div class="projects-board-card__top">
        <span class="projects-board-card__id">${task.id}</span>
        ${isBlocked ? html`
          <span class="projects-board-card__blocked">
            <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12"><path d="M8 1a4 4 0 0 0-4 4v2H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-1V5a4 4 0 0 0-4-4zm2 6H6V5a2 2 0 1 1 4 0v2z"/></svg>
            Blocked
          </span>
        ` : nothing}
      </div>
      <div class="projects-board-card__title">${task.title}</div>
      ${task.claimed_by ? html`<div class="projects-board-card__assignee">${task.claimed_by}</div>` : nothing}
      ${task.claimed_by ? renderAgentBar(task, props) : nothing}
    </div>
    ${isExpanded ? renderPeekPanel(props) : nothing}
  `;
}

function hasUnfinishedDeps(task: BoardTaskEntry, allTasks: BoardTaskEntry[]): boolean {
  if (!task.depends_on || task.depends_on.length === 0) return false;
  return task.depends_on.some((depId) => {
    const dep = allTasks.find((t) => t.id === depId);
    return dep && dep.status !== "Done" && dep.status !== "done";
  });
}

function renderAgentBar(task: BoardTaskEntry, props: KanbanBoardProps) {
  return html`
    <div class="projects-board-card__agent" @click=${() => props.onTogglePeek(task.id)}>
      <span class="projects-board-card__agent-dot"></span>
      <span class="projects-board-card__agent-name">${task.claimed_by}</span>
    </div>
  `;
}

function renderPeekPanel(props: KanbanBoardProps) {
  if (props.checkpointLoading) {
    return html`<div class="projects-peek"><div class="skeleton-line"></div><div class="skeleton-line"></div></div>`;
  }
  const cp = props.checkpoint;
  if (!cp) return nothing;

  const logEntries = cp.log ?? [];
  const recentLog = logEntries.slice(-5).reverse();

  return html`
    <div class="projects-peek">
      <div class="projects-peek__field">
        <span class="projects-peek__label">Status</span>
        <span class="projects-peek__value">${cp.status}</span>
      </div>
      <div class="projects-peek__field">
        <span class="projects-peek__label">Progress</span>
        <div class="projects-peek__progress">
          <div class="projects-peek__progress-bar">
            <div class="projects-peek__progress-fill" style="width: ${cp.progress_pct}%"></div>
          </div>
          <span class="projects-peek__progress-pct">${cp.progress_pct}%</span>
        </div>
      </div>
      <div class="projects-peek__field">
        <span class="projects-peek__label">Current step</span>
        <span class="projects-peek__value">${cp.last_step}</span>
      </div>
      <div class="projects-peek__field">
        <span class="projects-peek__label">Next action</span>
        <span class="projects-peek__value">${cp.next_action}</span>
      </div>
      <div class="projects-peek__field">
        <span class="projects-peek__label">Files modified</span>
        <span class="projects-peek__value">${cp.files_modified?.length ?? 0} files modified</span>
      </div>
      ${recentLog.length > 0 ? html`
        <div class="projects-peek__log">
          <div class="projects-peek__log-title">Recent activity</div>
          ${recentLog.map((entry) => html`
            <div class="projects-peek__log-entry">
              <span class="projects-peek__log-time">${new Date(entry.timestamp).toLocaleTimeString()}</span>
              <span class="projects-peek__log-action">${entry.action}</span>
            </div>
          `)}
        </div>
      ` : nothing}
    </div>
  `;
}

function renderBoardSkeleton() {
  return html`
    <div class="projects-board-skeleton">
      ${[1, 2, 3, 4].map(() => html`
        <div class="projects-board-skeleton__column">
          <div class="skeleton-line" style="width: 60%"></div>
          ${[1, 2, 3].map(() => html`<div class="skeleton-block" style="height: 80px"></div>`)}
        </div>
      `)}
    </div>
  `;
}
