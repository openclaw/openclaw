/**
 * Chat Task Sidebar component.
 * Displays task progress and activity logs derived from tool stream data.
 */

import { html, nothing } from "lit";
import { icon, type IconName } from "../icons";
import type { ChatTask, ChatActivityLog, TaskStatus } from "../types/task-types";
import { formatAgo } from "../format";

export type ChatTaskSidebarProps = {
  open: boolean;
  tasks: ChatTask[];
  activityLog: ChatActivityLog[];
  expandedIds: Set<string>;
  onClose: () => void;
  onToggleExpanded: (taskId: string) => void;
  onOpenToolOutput?: (content: string) => void;
};

/** Setup keyboard shortcuts for the task sidebar */
export function setupTaskSidebarKeyboardShortcuts(props: {
  getOpen: () => boolean;
  onClose: () => void;
}): () => void {
  const handler = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (!props.getOpen()) return;

    event.preventDefault();
    props.onClose();

    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT")
    ) {
      target.blur();
    }
  };

  document.addEventListener("keydown", handler);
  return () => document.removeEventListener("keydown", handler);
}

/** Get the icon name for a task status */
function getStatusIcon(status: TaskStatus): IconName {
  switch (status) {
    case "not-started":
      return "target";
    case "in-progress":
      return "clock";
    case "completed":
      return "check-circle";
    case "error":
      return "alert-circle";
    case "user-feedback":
      return "user";
  }
}

/** Get the CSS class modifier for a task status */
function getStatusClass(status: TaskStatus): string {
  switch (status) {
    case "not-started":
      return "task-status--pending";
    case "in-progress":
      return "task-status--active";
    case "completed":
      return "task-status--completed";
    case "error":
      return "task-status--error";
    case "user-feedback":
      return "task-status--feedback";
  }
}

/** Render a single task item */
function renderTask(
  task: ChatTask,
  props: ChatTaskSidebarProps,
  depth = 0,
): ReturnType<typeof html> {
  const isExpanded = props.expandedIds.has(task.id);
  const hasDetails = Boolean(task.output || task.args || task.children.length > 0);
  const statusIcon = getStatusIcon(task.status);
  const statusClass = getStatusClass(task.status);
  const isAnimated = task.status === "in-progress" || task.status === "user-feedback";

  return html`
    <div class="task-item ${statusClass}" style="--task-depth: ${depth}">
      <div class="task-item__header">
        <span class="task-item__status ${isAnimated ? "task-status--animated" : ""}">
          ${icon(statusIcon, { size: 14 })}
        </span>
        <span class="task-item__name">${task.name}</span>
        ${hasDetails
          ? html`
              <button
                class="task-item__toggle"
                type="button"
                @click=${() => props.onToggleExpanded(task.id)}
                aria-expanded=${isExpanded}
                aria-label=${isExpanded ? "Collapse" : "Expand"}
              >
                ${icon(isExpanded ? "chevron-down" : "chevron-right", { size: 12 })}
              </button>
            `
          : nothing}
        <span class="task-item__time">${formatAgo(task.startedAt)}</span>
      </div>

      ${isExpanded && hasDetails
        ? html`
            <div class="task-item__details">
              ${task.error
                ? html`<div class="task-item__error">${task.error}</div>`
                : nothing}
              ${task.output && props.onOpenToolOutput
                ? html`
                    <button
                      class="task-item__output-btn"
                      type="button"
                      @click=${() => props.onOpenToolOutput?.(task.output!)}
                    >
                      ${icon("external-link", { size: 12 })}
                      View output
                    </button>
                  `
                : nothing}
              ${task.children.map((child) => renderTask(child, props, depth + 1))}
            </div>
          `
        : nothing}
    </div>
  `;
}

/** Render an activity log entry */
function renderActivityEntry(entry: ChatActivityLog): ReturnType<typeof html> {
  const typeIcon: IconName =
    entry.type === "tool-start"
      ? "play"
      : entry.type === "tool-result"
        ? "check"
        : entry.type === "tool-error"
          ? "alert-circle"
          : entry.type === "user-message"
            ? "user"
            : "sparkles";

  const typeClass =
    entry.type === "tool-error"
      ? "activity-entry--error"
      : entry.type === "tool-result"
        ? "activity-entry--success"
        : "";

  return html`
    <div class="activity-entry ${typeClass}">
      <span class="activity-entry__icon">
        ${icon(typeIcon, { size: 12 })}
      </span>
      <span class="activity-entry__title">${entry.title}</span>
      <span class="activity-entry__time">${formatAgo(entry.timestamp)}</span>
    </div>
  `;
}

/** Render the task sidebar header stats */
function renderStats(tasks: ChatTask[]) {
  const completed = tasks.filter((t) => t.status === "completed").length;
  const inProgress = tasks.filter((t) => t.status === "in-progress").length;
  const errors = tasks.filter((t) => t.status === "error").length;
  const total = tasks.length;

  if (total === 0) return nothing;

  return html`
    <div class="task-sidebar__stats">
      <span class="task-stat task-stat--completed">
        ${icon("check-circle", { size: 12 })}
        ${completed}
      </span>
      ${inProgress > 0
        ? html`
            <span class="task-stat task-stat--active">
              ${icon("clock", { size: 12 })}
              ${inProgress}
            </span>
          `
        : nothing}
      ${errors > 0
        ? html`
            <span class="task-stat task-stat--error">
              ${icon("alert-circle", { size: 12 })}
              ${errors}
            </span>
          `
        : nothing}
      <span class="task-stat task-stat--total">${total} total</span>
    </div>
  `;
}

/** Main render function for the chat task sidebar */
export function renderChatTaskSidebar(props: ChatTaskSidebarProps) {
  if (!props.open) return nothing;

  const hasTasks = props.tasks.length > 0;
  const hasActivity = props.activityLog.length > 0;

  return html`
    <div
      class="task-sidebar-backdrop"
      @click=${props.onClose}
    ></div>
    <aside class="task-sidebar">
      <header class="task-sidebar__header">
        <div class="task-sidebar__header-content">
          <h2 class="task-sidebar__title">Task Breakdown</h2>
          ${renderStats(props.tasks)}
        </div>
        <button
          class="task-sidebar__close"
          type="button"
          @click=${props.onClose}
          aria-label="Close task sidebar"
        >
          ${icon("x", { size: 18 })}
        </button>
      </header>

      <div class="task-sidebar__body">
        ${hasTasks
          ? html`
              <section class="task-sidebar__section">
                <h3 class="task-sidebar__section-title">Tasks</h3>
                <div class="task-list">
                  ${props.tasks.map((task) => renderTask(task, props))}
                </div>
              </section>
            `
          : nothing}

        ${hasActivity
          ? html`
              <section class="task-sidebar__section">
                <h3 class="task-sidebar__section-title">Activity Log</h3>
                <div class="activity-list">
                  ${props.activityLog.slice(-20).map(renderActivityEntry)}
                </div>
              </section>
            `
          : nothing}

        ${!hasTasks && !hasActivity
          ? html`
              <div class="task-sidebar__empty">
                <span class="task-sidebar__empty-icon">
                  ${icon("layers", { size: 32 })}
                </span>
                <p>No tasks yet</p>
                <p class="muted">Tasks will appear as the assistant uses tools.</p>
              </div>
            `
          : nothing}
      </div>
    </aside>
  `;
}
