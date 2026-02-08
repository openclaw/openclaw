import { html, nothing } from "lit";
import { formatAgo } from "../format.ts";
import { icon } from "../icons.ts";

export type MissionControlTaskStatus =
  | "pending"
  | "running"
  | "review"
  | "revising"
  | "done"
  | "failed";

export type MissionControlTask = {
  id: string;
  title: string;
  description: string;
  status: MissionControlTaskStatus;
  agentId?: string | null;
  sessionKey?: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  resultSummary?: string | null;
  errorMessage?: string | null;
  priority?: number;
  tags?: string[];
  failCount?: number;
  revisionCount?: number;
};

export type MissionControlFormState = {
  title: string;
  description: string;
  priority: string;
  tags: string;
};

export type MissionControlProps = {
  loading: boolean;
  error: string | null;
  tasks: MissionControlTask[];
  form: MissionControlFormState;
  deleteConfirmId: string | null;
  agentSpawnBusy: boolean;
  onRefresh: () => void;
  onFormChange: (patch: Partial<MissionControlFormState>) => void;
  onCreate: () => void;
  onUpdateStatus: (taskId: string, status: MissionControlTaskStatus) => void;
  onDelete: (taskId: string) => void;
  onDeleteConfirm: (taskId: string | null) => void;
  onSpawnAgent: (taskId: string, agentId?: string) => void;
};

const COLUMNS: Array<{ id: MissionControlTaskStatus; label: string; color: string }> = [
  { id: "pending", label: "Pending", color: "var(--color-text-muted)" },
  { id: "running", label: "Running", color: "var(--color-info)" },
  { id: "review", label: "Review", color: "var(--color-warning)" },
  { id: "revising", label: "Revising", color: "var(--color-accent)" },
  { id: "done", label: "Done", color: "var(--color-success)" },
  { id: "failed", label: "Failed", color: "var(--color-danger)" },
];

function statusClass(status: MissionControlTaskStatus): string {
  switch (status) {
    case "pending":
      return "task-status-pending";
    case "running":
      return "task-status-running";
    case "review":
      return "task-status-review";
    case "revising":
      return "task-status-revising";
    case "done":
      return "task-status-done";
    case "failed":
      return "task-status-failed";
    default:
      return "";
  }
}

function renderTaskCard(task: MissionControlTask, props: MissionControlProps) {
  const isDeleting = props.deleteConfirmId === task.id;
  const hasAgent = !!task.agentId;
  const hasSession = !!task.sessionKey;

  return html`
    <div class="mc-task-card ${statusClass(task.status)}" data-task-id=${task.id}>
      <div class="mc-task-header">
        <div class="mc-task-title">${task.title}</div>
        <button 
          class="mc-task-delete-btn" 
          @click=${() => props.onDeleteConfirm(task.id)}
          title="Delete task"
        >
          ${icon("x")}
        </button>
      </div>
      
      ${
        task.description
          ? html`
        <div class="mc-task-description">${task.description}</div>
      `
          : nothing
      }
      
      ${
        task.tags && task.tags.length > 0
          ? html`
        <div class="mc-task-tags">
          ${task.tags.map((tag) => html`<span class="mc-tag">${tag}</span>`)}
        </div>
      `
          : nothing
      }
      
      <div class="mc-task-meta">
        <span class="mc-task-time" title=${new Date(task.createdAt).toLocaleString()}>
          ${formatAgo(task.createdAt)}
        </span>
        ${task.priority ? html`<span class="mc-task-priority">P${task.priority}</span>` : nothing}
        ${task.failCount ? html`<span class="mc-task-fail-count">⚠️ ${task.failCount}</span>` : nothing}
        ${task.revisionCount ? html`<span class="mc-task-revision-count">📝 ${task.revisionCount}</span>` : nothing}
      </div>
      
      ${
        hasAgent
          ? html`
        <div class="mc-task-agent">
          <span class="mc-task-agent-label">Agent:</span>
          <span class="mc-task-agent-id mono">${task.agentId}</span>
          ${
            hasSession
              ? html`
            <a 
              class="mc-task-session-link" 
              href="/chat?session=${encodeURIComponent(task.sessionKey!)}"
              target="_blank"
              title="Open session"
            >
              ${icon("messageSquare")}
            </a>
          `
              : nothing
          }
        </div>
      `
          : nothing
      }
      
      ${
        task.resultSummary
          ? html`
        <div class="mc-task-result">${task.resultSummary}</div>
      `
          : nothing
      }
      
      ${
        task.errorMessage
          ? html`
        <div class="mc-task-error">${task.errorMessage}</div>
      `
          : nothing
      }
      
      <div class="mc-task-actions">
        ${
          task.status === "pending"
            ? html`
          <button 
            class="btn btn--sm" 
            @click=${() => props.onUpdateStatus(task.id, "running")}
            ?disabled=${props.agentSpawnBusy}
          >
            Start
          </button>
          <button 
            class="btn btn--sm primary" 
            @click=${() => props.onSpawnAgent(task.id)}
            ?disabled=${props.agentSpawnBusy}
          >
            ${props.agentSpawnBusy ? "Spawning..." : "Assign Agent"}
          </button>
        `
            : nothing
        }
        
        ${
          task.status === "running"
            ? html`
          <button 
            class="btn btn--sm" 
            @click=${() => props.onUpdateStatus(task.id, "review")}
          >
            Mark for Review
          </button>
          <button 
            class="btn btn--sm" 
            @click=${() => props.onUpdateStatus(task.id, "failed")}
          >
            Mark Failed
          </button>
        `
            : nothing
        }
        
        ${
          task.status === "review"
            ? html`
          <button 
            class="btn btn--sm" 
            @click=${() => props.onUpdateStatus(task.id, "revising")}
          >
            Request Revision
          </button>
          <button 
            class="btn btn--sm primary" 
            @click=${() => props.onUpdateStatus(task.id, "done")}
          >
            Approve
          </button>
        `
            : nothing
        }
        
        ${
          task.status === "revising"
            ? html`
          <button 
            class="btn btn--sm" 
            @click=${() => props.onUpdateStatus(task.id, "running")}
          >
            Resume
          </button>
        `
            : nothing
        }
        
        ${
          task.status === "failed"
            ? html`
          <button 
            class="btn btn--sm" 
            @click=${() => props.onUpdateStatus(task.id, "pending")}
          >
            Retry
          </button>
        `
            : nothing
        }
        
        ${
          task.status === "done"
            ? html`
          <button 
            class="btn btn--sm" 
            @click=${() => props.onUpdateStatus(task.id, "pending")}
          >
            Reopen
          </button>
        `
            : nothing
        }
      </div>
      
      ${
        isDeleting
          ? html`
        <div class="mc-delete-confirm">
          <span>Delete this task?</span>
          <button class="btn btn--sm danger" @click=${() => props.onDelete(task.id)}>Delete</button>
          <button class="btn btn--sm" @click=${() => props.onDeleteConfirm(null)}>Cancel</button>
        </div>
      `
          : nothing
      }
    </div>
  `;
}

function renderColumn(
  column: (typeof COLUMNS)[number],
  tasks: MissionControlTask[],
  props: MissionControlProps,
) {
  const columnTasks = tasks.filter((t) => t.status === column.id);

  return html`
    <div class="mc-column" data-status=${column.id}>
      <div class="mc-column-header" style="border-color: ${column.color}">
        <span class="mc-column-title">${column.label}</span>
        <span class="mc-column-count">${columnTasks.length}</span>
      </div>
      <div class="mc-column-content">
        ${columnTasks.map((task) => renderTaskCard(task, props))}
      </div>
    </div>
  `;
}

export function renderMissionControl(props: MissionControlProps) {
  return html`
    <div class="mc-container">
      <section class="card mc-header-card">
        <div class="row" style="justify-content: space-between; align-items: flex-start;">
          <div>
            <div class="card-title">Mission Control</div>
            <div class="card-sub">Kanban board for managing agent tasks and workflows.</div>
          </div>
          <button class="btn btn--sm" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? "Loading..." : "Refresh"}
          </button>
        </div>
        
        ${
          props.error
            ? html`
          <div class="callout danger" style="margin-top: 12px;">${props.error}</div>
        `
            : nothing
        }
      </section>

      <section class="card mc-create-card">
        <div class="card-title">Create New Task</div>
        <div class="form-grid" style="margin-top: 12px;">
          <label class="field">
            <span>Title</span>
            <input
              .value=${props.form.title}
              @input=${(e: Event) => props.onFormChange({ title: (e.target as HTMLInputElement).value })}
              placeholder="Task title"
            />
          </label>
          <label class="field">
            <span>Description</span>
            <input
              .value=${props.form.description}
              @input=${(e: Event) => props.onFormChange({ description: (e.target as HTMLInputElement).value })}
              placeholder="Task description"
            />
          </label>
          <label class="field">
            <span>Priority</span>
            <input
              type="number"
              min="0"
              max="10"
              .value=${props.form.priority}
              @input=${(e: Event) => props.onFormChange({ priority: (e.target as HTMLInputElement).value })}
              placeholder="0-10"
            />
          </label>
          <label class="field">
            <span>Tags (comma-separated)</span>
            <input
              .value=${props.form.tags}
              @input=${(e: Event) => props.onFormChange({ tags: (e.target as HTMLInputElement).value })}
              placeholder="tag1, tag2"
            />
          </label>
        </div>
        <div class="row" style="margin-top: 12px;">
          <button 
            class="btn primary" 
            @click=${props.onCreate}
            ?disabled=${!props.form.title.trim()}
          >
            Create Task
          </button>
        </div>
      </section>

      <section class="mc-board">
        ${COLUMNS.map((col) => renderColumn(col, props.tasks, props))}
      </section>
    </div>
  `;
}
