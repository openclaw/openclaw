import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import type {
  TaskFlowDetail,
  TaskRunAggregateSummary,
  TaskRunDetail,
  TaskRunView,
} from "../types.ts";

const ACTIVE_TASK_STATUSES = new Set(["queued", "running"]);
const REVIEW_FLOW_STATUSES = new Set(["waiting", "blocked"]);
const TERMINAL_TASK_STATUSES = new Set(["succeeded", "failed", "timed_out", "cancelled", "lost"]);

export type SourceViewProps = {
  loading: boolean;
  error: string | null;
  tasks: TaskRunView[];
  taskSummary: TaskRunAggregateSummary;
  flows: TaskFlowDetail[];
  selectedTaskId: string | null;
  selectedTask: TaskRunDetail | null;
  selectedTaskLoading: boolean;
  onRefresh: () => void;
  onSelectTask: (taskId: string) => void;
  onClearSelection: () => void;
};

function formatTimestamp(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return t("source.labels.unknownTime");
  }
  return new Date(value).toLocaleString();
}

function formatTaskAge(task: TaskRunView): string {
  return formatTimestamp(task.lastEventAt ?? task.endedAt ?? task.startedAt ?? task.createdAt);
}

function formatFlowAge(flow: TaskFlowDetail): string {
  return formatTimestamp(flow.updatedAt ?? flow.endedAt ?? flow.createdAt);
}

function runtimeBadgeLabel(task: TaskRunView): string {
  return `${task.runtime}${task.agentId ? ` · ${task.agentId}` : ""}`;
}

function renderEmpty(label: string) {
  return html`<div class="muted" style="margin-top: 12px;">${label}</div>`;
}

function renderTaskRow(task: TaskRunView, props: SourceViewProps): TemplateResult {
  const selected = props.selectedTaskId === task.id;
  const detail = task.progressSummary ?? task.terminalSummary ?? task.error ?? task.sessionKey;
  return html`
    <div
      class="list-item list-item-clickable ${selected ? "list-item-selected" : ""}"
      @click=${() => props.onSelectTask(task.id)}
    >
      <div class="list-main">
        <div class="list-title">${task.label ?? task.title}</div>
        <div class="list-sub">${task.title}</div>
        <div class="muted" style="margin-top: 6px;">
          ${runtimeBadgeLabel(task)} · ${detail} · ${formatTaskAge(task)}
        </div>
      </div>
      <div class="list-meta">
        <span
          class="pill ${task.status === "running" ? "ok" : task.status === "queued" ? "warn" : ""}"
        >
          ${task.status}
        </span>
      </div>
    </div>
  `;
}

function renderFlowRow(flow: TaskFlowDetail): TemplateResult {
  const blocked = flow.blocked?.summary ?? flow.currentStep ?? t("source.labels.noCurrentStep");
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${flow.goal}</div>
        <div class="list-sub">${blocked}</div>
        <div class="muted" style="margin-top: 6px;">
          ${flow.ownerKey} · ${flow.tasks.length} ${t("source.labels.tasks")} ·
          ${formatFlowAge(flow)}
        </div>
      </div>
      <div class="list-meta">
        <span class="pill ${flow.status === "blocked" ? "danger" : "warn"}">${flow.status}</span>
      </div>
    </div>
  `;
}

function renderSelectedTask(props: SourceViewProps): TemplateResult {
  if (props.selectedTaskLoading) {
    return html`
      <div class="card">
        <div class="card-title">${t("source.selected.title")}</div>
        <div class="card-sub">${t("source.selected.loading")}</div>
      </div>
    `;
  }
  if (!props.selectedTask) {
    return html`
      <div class="card">
        <div class="card-title">${t("source.selected.title")}</div>
        <div class="card-sub">${t("source.selected.empty")}</div>
      </div>
    `;
  }
  const task = props.selectedTask;
  return html`
    <div class="card">
      <div style="display: flex; justify-content: space-between; gap: 12px; align-items: center;">
        <div>
          <div class="card-title">${t("source.selected.title")}</div>
          <div class="card-sub">${task.id}</div>
        </div>
        <button class="btn btn--subtle btn--sm" @click=${props.onClearSelection}>
          ${t("source.selected.clear")}
        </button>
      </div>
      <div class="list" style="margin-top: 16px;">
        <div class="list-item">
          <div class="list-main">
            <div class="list-title">${task.label ?? task.title}</div>
            <div class="list-sub">${task.title}</div>
          </div>
          <div class="list-meta"><span class="pill">${task.status}</span></div>
        </div>
        <div class="list-item">
          <div class="list-main">
            <div class="list-title">${t("source.labels.scope")}</div>
            <div class="list-sub">${task.scope} · ${task.runtime} · ${task.ownerKey}</div>
          </div>
        </div>
        <div class="list-item">
          <div class="list-main">
            <div class="list-title">${t("source.labels.timeline")}</div>
            <div class="list-sub">
              ${t("source.labels.created")} ${formatTimestamp(task.createdAt)}
              ${task.startedAt
                ? html`<br />${t("source.labels.started")} ${formatTimestamp(task.startedAt)}`
                : nothing}
              ${task.endedAt
                ? html`<br />${t("source.labels.ended")} ${formatTimestamp(task.endedAt)}`
                : nothing}
            </div>
          </div>
        </div>
        ${task.progressSummary
          ? html`
              <div class="list-item">
                <div class="list-main">
                  <div class="list-title">${t("source.labels.progress")}</div>
                  <div class="list-sub">${task.progressSummary}</div>
                </div>
              </div>
            `
          : nothing}
        ${task.terminalSummary || task.error
          ? html`
              <div class="list-item">
                <div class="list-main">
                  <div class="list-title">${t("source.labels.result")}</div>
                  <div class="list-sub">${task.terminalSummary ?? task.error}</div>
                </div>
              </div>
            `
          : nothing}
      </div>
    </div>
  `;
}

export function renderSource(props: SourceViewProps): TemplateResult {
  const activeTasks = props.tasks
    .filter((task) => ACTIVE_TASK_STATUSES.has(task.status))
    .slice(0, 10);
  const reviewFlows = props.flows
    .filter((flow) => REVIEW_FLOW_STATUSES.has(flow.status))
    .slice(0, 10);
  const recentDoneTasks = props.tasks
    .filter((task) => TERMINAL_TASK_STATUSES.has(task.status))
    .toSorted(
      (left, right) =>
        (right.endedAt ?? right.lastEventAt ?? right.createdAt) -
        (left.endedAt ?? left.lastEventAt ?? left.createdAt),
    )
    .slice(0, 12);
  const flowSummary = {
    active: props.flows.filter((flow) => flow.status === "queued" || flow.status === "running")
      .length,
    review: props.flows.filter((flow) => REVIEW_FLOW_STATUSES.has(flow.status)).length,
    done: props.flows.filter(
      (flow) =>
        !REVIEW_FLOW_STATUSES.has(flow.status) &&
        flow.status !== "queued" &&
        flow.status !== "running",
    ).length,
  };

  return html`
    <section class="grid">
      <div class="card">
        <div style="display: flex; justify-content: space-between; gap: 12px; align-items: center;">
          <div>
            <div class="card-title">${t("source.summary.title")}</div>
            <div class="card-sub">${t("source.summary.subtitle")}</div>
          </div>
          <button
            class="btn btn--subtle btn--sm"
            ?disabled=${props.loading}
            @click=${props.onRefresh}
          >
            ${props.loading ? t("source.actions.refreshing") : t("source.actions.refresh")}
          </button>
        </div>
        ${props.error
          ? html`<div class="pill danger" style="margin-top: 12px;">${props.error}</div>`
          : nothing}
        <div class="stat-grid" style="margin-top: 16px;">
          <div class="stat">
            <div class="stat-label">${t("source.stats.activeRuns")}</div>
            <div class="stat-value">
              ${props.taskSummary.byStatus.queued + props.taskSummary.byStatus.running}
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">${t("source.stats.reviewFlows")}</div>
            <div class="stat-value">${flowSummary.review}</div>
          </div>
          <div class="stat">
            <div class="stat-label">${t("source.stats.doneRuns")}</div>
            <div class="stat-value">${props.taskSummary.terminal}</div>
          </div>
          <div class="stat">
            <div class="stat-label">${t("source.stats.failures")}</div>
            <div class="stat-value ${props.taskSummary.failures > 0 ? "danger" : "ok"}">
              ${props.taskSummary.failures}
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">${t("source.stats.totalFlows")}</div>
            <div class="stat-value">${props.flows.length}</div>
          </div>
          <div class="stat">
            <div class="stat-label">${t("source.stats.totalRuns")}</div>
            <div class="stat-value">${props.taskSummary.total}</div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">${t("source.runtime.title")}</div>
        <div class="card-sub">${t("source.runtime.subtitle")}</div>
        <div class="list" style="margin-top: 16px;">
          ${Object.entries(props.taskSummary.byRuntime).map(
            ([runtime, count]) => html`
              <div class="list-item">
                <div class="list-main">
                  <div class="list-title">${runtime}</div>
                </div>
                <div class="list-meta"><span class="pill">${count}</span></div>
              </div>
            `,
          )}
        </div>
      </div>
    </section>

    <section class="grid" style="margin-top: 16px;">
      <div class="card">
        <div class="card-title">${t("source.active.title")}</div>
        <div class="card-sub">${t("source.active.subtitle")}</div>
        <div class="list" style="margin-top: 16px;">
          ${activeTasks.length > 0
            ? activeTasks.map((task) => renderTaskRow(task, props))
            : renderEmpty(t("source.active.empty"))}
        </div>
      </div>
      <div class="card">
        <div class="card-title">${t("source.review.title")}</div>
        <div class="card-sub">${t("source.review.subtitle")}</div>
        <div class="list" style="margin-top: 16px;">
          ${reviewFlows.length > 0
            ? reviewFlows.map((flow) => renderFlowRow(flow))
            : renderEmpty(t("source.review.empty"))}
        </div>
      </div>
    </section>

    <section class="grid" style="margin-top: 16px;">
      <div class="card">
        <div class="card-title">${t("source.done.title")}</div>
        <div class="card-sub">${t("source.done.subtitle")}</div>
        <div class="list" style="margin-top: 16px;">
          ${recentDoneTasks.length > 0
            ? recentDoneTasks.map((task) => renderTaskRow(task, props))
            : renderEmpty(t("source.done.empty"))}
        </div>
      </div>
      ${renderSelectedTask(props)}
    </section>
  `;
}
