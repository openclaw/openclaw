import { html, nothing, type TemplateResult } from "lit";
import { formatRelativeTimestamp } from "../format.ts";
import "../components/workflow-graph.js";

export type WorkflowTaskStatus = "pending" | "in_progress" | "completed" | "skipped" | "failed";
export type WorkflowPlanStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

export type WorkflowTask = {
  id: string;
  content: string;
  status: WorkflowTaskStatus;
  result?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  order: number;
};

export type WorkflowPlan = {
  id: string;
  agentId: string;
  sessionKey?: string;
  title: string;
  description?: string;
  status: WorkflowPlanStatus;
  source: string;
  tasks: WorkflowTask[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  discordReported?: boolean;
};

export type WorkflowViewMode = "list" | "graph";

export type WorkflowProps = {
  basePath: string;
  loading: boolean;
  error: string | null;
  activePlans: WorkflowPlan[];
  historyPlans: WorkflowPlan[];
  historyTotal: number;
  selectedPlanId: string | null;
  selectedPlan: WorkflowPlan | null;
  scope: "active" | "history" | "all";
  viewMode: WorkflowViewMode;
  onRefresh: () => void;
  onScopeChange: (scope: "active" | "history" | "all") => void;
  onSelectPlan: (planId: string, scope: "active" | "history") => void;
  onClosePlanDetail: () => void;
  onLoadMoreHistory: () => void;
  onViewModeChange: (mode: WorkflowViewMode) => void;
};

function getStatusIcon(status: WorkflowTaskStatus | WorkflowPlanStatus): string {
  switch (status) {
    case "completed":
      return "✅";
    case "in_progress":
      return "🔄";
    case "pending":
      return "⬜";
    case "skipped":
      return "⏭️";
    case "failed":
      return "❌";
    case "cancelled":
      return "🚫";
    default:
      return "⬜";
  }
}

function getStatusClass(status: WorkflowTaskStatus | WorkflowPlanStatus): string {
  switch (status) {
    case "completed":
      return "workflow-status--completed";
    case "in_progress":
      return "workflow-status--in-progress";
    case "pending":
      return "workflow-status--pending";
    case "skipped":
      return "workflow-status--skipped";
    case "failed":
    case "cancelled":
      return "workflow-status--failed";
    default:
      return "";
  }
}

function calculateProgress(plan: WorkflowPlan): {
  completed: number;
  total: number;
  percent: number;
} {
  const total = plan.tasks.length;
  const completed = plan.tasks.filter(
    (t) => t.status === "completed" || t.status === "skipped" || t.status === "failed",
  ).length;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  return { completed, total, percent };
}

function renderProgressBar(percent: number): TemplateResult {
  return html`
    <div class="workflow-progress">
      <div class="workflow-progress__bar">
        <div class="workflow-progress__fill" style="width: ${percent}%"></div>
      </div>
      <span class="workflow-progress__text">${percent}%</span>
    </div>
  `;
}

function renderPlanCard(
  plan: WorkflowPlan,
  scope: "active" | "history",
  onSelect: (planId: string, scope: "active" | "history") => void,
): TemplateResult {
  const progress = calculateProgress(plan);
  return html`
    <div
      class="workflow-card ${getStatusClass(plan.status)}"
      role="button"
      tabindex="0"
      @click=${() => onSelect(plan.id, scope)}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(plan.id, scope);
        }
      }}
    >
      <div class="workflow-card__header">
        <span class="workflow-card__icon">${getStatusIcon(plan.status)}</span>
        <span class="workflow-card__title">${plan.title}</span>
        <span class="workflow-card__source pill pill--muted">${plan.source}</span>
      </div>
      <div class="workflow-card__meta">
        <span>${progress.completed}/${progress.total} tasks</span>
        <span class="workflow-card__time">${formatRelativeTimestamp(plan.updatedAt)}</span>
      </div>
      ${renderProgressBar(progress.percent)}
    </div>
  `;
}

function renderTaskItem(task: WorkflowTask): TemplateResult {
  return html`
    <div class="workflow-task ${getStatusClass(task.status)}">
      <span class="workflow-task__icon">${getStatusIcon(task.status)}</span>
      <div class="workflow-task__content">
        <div class="workflow-task__text">${task.content}</div>
        ${task.result ? html`<div class="workflow-task__result">→ ${task.result}</div>` : nothing}
        ${task.error ? html`<div class="workflow-task__error">⚠️ ${task.error}</div>` : nothing}
        ${
          task.completedAt
            ? html`<div class="workflow-task__time">${formatRelativeTimestamp(task.completedAt)}</div>`
            : nothing
        }
      </div>
    </div>
  `;
}

function renderPlanDetail(
  plan: WorkflowPlan,
  viewMode: WorkflowViewMode,
  onClose: () => void,
  onViewModeChange: (mode: WorkflowViewMode) => void,
): TemplateResult {
  const progress = calculateProgress(plan);
  const duration =
    plan.completedAt && plan.startedAt
      ? Math.round(
          (new Date(plan.completedAt).getTime() - new Date(plan.startedAt).getTime()) / 1000,
        )
      : null;

  return html`
    <div class="workflow-detail">
      <div class="workflow-detail__header">
        <button class="btn btn--icon" @click=${onClose} title="Close">
          ← Back
        </button>
        <h2 class="workflow-detail__title">${plan.title}</h2>
      </div>

      <div class="workflow-detail__meta card">
        <div class="row">
          <span class="workflow-detail__status ${getStatusClass(plan.status)}">
            ${getStatusIcon(plan.status)} ${plan.status}
          </span>
          <span class="pill pill--muted">${plan.source}</span>
        </div>
        <div class="row" style="margin-top: 8px;">
          <span>Progress: ${progress.completed}/${progress.total} tasks</span>
          ${duration !== null ? html`<span>Duration: ${duration}s</span>` : nothing}
        </div>
        ${renderProgressBar(progress.percent)}
        ${plan.description ? html`<p class="workflow-detail__desc">${plan.description}</p>` : nothing}
        <div class="workflow-detail__times">
          <span>Created: ${formatRelativeTimestamp(plan.createdAt)}</span>
          ${plan.startedAt ? html`<span>Started: ${formatRelativeTimestamp(plan.startedAt)}</span>` : nothing}
          ${plan.completedAt ? html`<span>Completed: ${formatRelativeTimestamp(plan.completedAt)}</span>` : nothing}
        </div>
        ${
          plan.discordReported
            ? html`
                <div class="workflow-detail__reported">✅ Reported to Discord</div>
              `
            : nothing
        }
      </div>

      <div class="card">
        <div class="row" style="justify-content: space-between; align-items: center;">
          <div class="card-title" style="margin: 0;">Tasks</div>
          <div class="btn-group">
            <button
              class="btn btn--sm ${viewMode === "list" ? "btn--active" : ""}"
              @click=${() => onViewModeChange("list")}
              title="List View"
            >
              ☰ List
            </button>
            <button
              class="btn btn--sm ${viewMode === "graph" ? "btn--active" : ""}"
              @click=${() => onViewModeChange("graph")}
              title="Graph View"
            >
              ⬡ Graph
            </button>
          </div>
        </div>

        ${
          viewMode === "graph"
            ? html`
              <div class="workflow-graph-wrapper" style="margin-top: 16px; height: 450px;">
                <workflow-graph .plan=${plan}></workflow-graph>
              </div>
            `
            : html`
              <div class="workflow-tasks">
                ${plan.tasks
                  .toSorted((a, b) => a.order - b.order)
                  .map((task) => renderTaskItem(task))}
              </div>
            `
        }
      </div>
    </div>
  `;
}

export function renderWorkflow(props: WorkflowProps): TemplateResult {
  if (props.selectedPlan) {
    return renderPlanDetail(
      props.selectedPlan,
      props.viewMode,
      props.onClosePlanDetail,
      props.onViewModeChange,
    );
  }

  const showActive = props.scope === "active" || props.scope === "all";
  const showHistory = props.scope === "history" || props.scope === "all";

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Workflow Plans</div>
          <div class="card-sub">Track task progress for heartbeat and long-running operations.</div>
        </div>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <div class="workflow-filters" style="margin-top: 14px;">
        <div class="btn-group">
          <button
            class="btn ${props.scope === "active" ? "btn--active" : ""}"
            @click=${() => props.onScopeChange("active")}
          >
            Active
          </button>
          <button
            class="btn ${props.scope === "history" ? "btn--active" : ""}"
            @click=${() => props.onScopeChange("history")}
          >
            History
          </button>
          <button
            class="btn ${props.scope === "all" ? "btn--active" : ""}"
            @click=${() => props.onScopeChange("all")}
          >
            All
          </button>
        </div>
      </div>

      ${props.error ? html`<div class="callout callout--error">${props.error}</div>` : nothing}

      ${
        showActive
          ? html`
            <div class="workflow-section">
              <h3 class="workflow-section__title">Active Plans</h3>
              ${
                props.activePlans.length === 0
                  ? html`
                      <div class="workflow-empty">No active workflow plans</div>
                    `
                  : html`
                    <div class="workflow-list">
                      ${props.activePlans.map((plan) =>
                        renderPlanCard(plan, "active", props.onSelectPlan),
                      )}
                    </div>
                  `
              }
            </div>
          `
          : nothing
      }

      ${
        showHistory
          ? html`
            <div class="workflow-section">
              <h3 class="workflow-section__title">
                History
                ${props.historyTotal > 0 ? html`<span class="pill">${props.historyTotal}</span>` : nothing}
              </h3>
              ${
                props.historyPlans.length === 0
                  ? html`
                      <div class="workflow-empty">No completed workflow plans</div>
                    `
                  : html`
                    <div class="workflow-list">
                      ${props.historyPlans.map((plan) =>
                        renderPlanCard(plan, "history", props.onSelectPlan),
                      )}
                    </div>
                    ${
                      props.historyPlans.length < props.historyTotal
                        ? html`
                          <button
                            class="btn btn--full-width"
                            @click=${props.onLoadMoreHistory}
                            ?disabled=${props.loading}
                          >
                            Load More
                          </button>
                        `
                        : nothing
                    }
                  `
              }
            </div>
          `
          : nothing
      }
    </section>
  `;
}
