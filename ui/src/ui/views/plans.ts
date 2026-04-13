import { html, nothing } from "lit";
import {
  listAvailablePlanStatusActions,
  type PlanStatus,
  type PlanStatusFilter,
  type PlansViewProps,
} from "../controllers/plans.ts";
import { formatRelativeTimestamp } from "../format.ts";
import type { PlanRecord, PlanRegistrySummary } from "../types.ts";

function renderPlansSummary(summary: PlanRegistrySummary | null | undefined) {
  if (!summary) {
    return html`<span class="muted">No summary</span>`;
  }
  return html`
    <div class="muted" style="font-size: 12px; margin-top: 6px;">
      ${summary.total} total · ${summary.reviewable} reviewable · ${summary.terminal} terminal
    </div>
  `;
}

function renderPlanStatusActions(props: PlansViewProps) {
  const actions = listAvailablePlanStatusActions(props.detail);
  if (!props.detail || actions.length === 0) {
    return nothing;
  }
  return html`
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top: 12px;">
      ${actions.map(
        (status) => html`
          <button
            class="btn btn--sm"
            ?disabled=${props.statusUpdating}
            @click=${() => props.onStatusAction(status)}
          >
            Mark ${formatPlanStatusLabel(status)}
          </button>
        `,
      )}
    </div>
  `;
}

function renderPlanDetail(plan: PlanRecord | null, props: PlansViewProps) {
  if (!plan) {
    return html`<div class="muted">Select a plan to inspect details.</div>`;
  }
  return html`
    <div class="card-sub" style="margin-top: 0;">${plan.ownerKey} · ${plan.scopeKind}</div>
    ${plan.summary ? html`<div style="margin-top: 10px;">${plan.summary}</div>` : nothing}
    <div class="muted" style="margin-top: 10px; font-size: 12px;">
      status: ${plan.status} · updated ${formatRelativeTimestamp(plan.updatedAt)}
    </div>
    ${Array.isArray(plan.linkedFlowIds) && plan.linkedFlowIds.length > 0
      ? html`<div class="muted" style="margin-top: 6px; font-size: 12px;">
          linked flows: ${plan.linkedFlowIds.join(", ")}
        </div>`
      : nothing}
    ${renderPlanStatusActions(props)}
    ${props.statusError
      ? html`<div class="callout danger" style="margin-top: 12px;">${props.statusError}</div>`
      : nothing}
    <pre style="margin-top: 12px; white-space: pre-wrap;">${plan.content}</pre>
  `;
}

function formatPlanStatusLabel(status: PlanStatus): string {
  switch (status) {
    case "ready_for_review":
      return "ready for review";
    default:
      return status;
  }
}

function renderPlanList(props: PlansViewProps) {
  const plans = props.result?.plans ?? [];
  if (props.loading && plans.length === 0) {
    return html`<div class="muted">Loading plans…</div>`;
  }
  if (plans.length === 0) {
    return html`<div class="muted">No plans available.</div>`;
  }
  return html`<div style="display:flex; flex-direction:column; gap:8px;">
    ${plans.map(
      (plan) => html`
        <button
          class="btn btn--subtle"
          style="justify-content:flex-start; text-align:left; padding:10px 12px; ${props.selectedPlanId ===
          plan.planId
            ? "border-color: var(--accent, #7c3aed);"
            : ""}"
          @click=${() => props.onSelectPlan(plan.planId)}
        >
          <span style="display:flex; flex-direction:column; gap:4px; align-items:flex-start;">
            <span>${plan.title}</span>
            <span class="muted" style="font-size:12px;">${plan.status} · ${plan.ownerKey}</span>
          </span>
        </button>
      `,
    )}
  </div>`;
}

function renderPlansFilters(props: PlansViewProps) {
  return html`
    <label class="field" style="margin:0; min-width: 200px;">
      <span>Status</span>
      <select
        .value=${props.statusFilter}
        @change=${(e: Event) =>
          props.onStatusFilterChange((e.target as HTMLSelectElement).value as PlanStatusFilter)}
      >
        <option value="all">All statuses</option>
        <option value="draft">Draft</option>
        <option value="ready_for_review">Ready for review</option>
        <option value="approved">Approved</option>
        <option value="rejected">Rejected</option>
        <option value="archived">Archived</option>
      </select>
    </label>
  `;
}

export function renderPlans(props: PlansViewProps) {
  return html`
    <div class="card">
      <div
        style="display:flex; gap:12px; justify-content:space-between; align-items:flex-start; flex-wrap:wrap;"
      >
        <div>
          <div class="card-title">Plans</div>
          <div class="card-sub">Inspect orchestration plan artifacts from the gateway.</div>
          ${renderPlansSummary(props.result?.summary)}
        </div>
        <div style="display:flex; gap:8px; align-items:end; flex-wrap:wrap;">
          ${renderPlansFilters(props)}
          <button class="btn btn--sm" ?disabled=${props.loading} @click=${props.onRefresh}>
            Refresh
          </button>
        </div>
      </div>
      ${props.error
        ? html`<div class="callout danger" style="margin-top: 14px;">${props.error}</div>`
        : nothing}
      <div
        style="display:grid; grid-template-columns:minmax(220px, 320px) minmax(0, 1fr); gap: 16px; margin-top: 16px;"
      >
        <div>${renderPlanList(props)}</div>
        <div>
          ${props.detailError
            ? html`<div class="callout danger">${props.detailError}</div>`
            : props.detailLoading
              ? html`<div class="muted">Loading plan details…</div>`
              : renderPlanDetail(props.detail, props)}
        </div>
      </div>
    </div>
  `;
}
