/**
 * Plan-approval overlay (PR-8 follow-up).
 *
 * Rendered when the agent calls `exit_plan_mode`, surfacing the proposed
 * plan to the user with Approve / Reject / Edit buttons. Reuses the
 * exec-approval overlay shell + plan-cards renderer for visual
 * consistency.
 *
 * The decision flows back to the gateway via
 * `sessions.patch { planApproval: { action, feedback?, approvalId } }`,
 * which calls `resolvePlanApproval` from the plan-mode lib (#67538).
 */
import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state.ts";
import { renderPlanCard, type PlanCardStep } from "../chat/plan-cards.ts";

const PLAN_STEP_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;

function coercePlanStep(raw: { step: string; status: string; activeForm?: string }): PlanCardStep {
  const status = (PLAN_STEP_STATUSES as readonly string[]).includes(raw.status)
    ? (raw.status as PlanCardStep["status"])
    : "pending";
  return {
    text: raw.step,
    status,
    ...(raw.activeForm ? { activeForm: raw.activeForm } : {}),
  };
}

export function renderPlanApprovalOverlay(state: AppViewState) {
  const active = state.planApprovalRequest;
  if (!active) {
    return nothing;
  }
  const planSteps = active.plan.map(coercePlanStep);
  const planTitle = active.summary || "Proposed plan";
  return html`
    <div class="exec-approval-overlay" role="dialog" aria-live="polite">
      <div class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">${active.title}</div>
            <div class="exec-approval-sub">
              ${active.plan.length} ${active.plan.length === 1 ? "step" : "steps"} proposed
            </div>
          </div>
        </div>
        <div class="exec-approval-meta" style="margin-top: 8px;">
          ${renderPlanCard({
            title: planTitle,
            steps: planSteps,
            ...(active.summary ? { explanation: active.summary } : {}),
          })}
        </div>
        ${state.planApprovalError
          ? html`<div class="exec-approval-error">${state.planApprovalError}</div>`
          : nothing}
        <div class="exec-approval-actions">
          <button
            class="btn primary"
            ?disabled=${state.planApprovalBusy}
            @click=${() => state.handlePlanApprovalDecision("approve")}
            title="Execute the plan now"
          >
            Approve
          </button>
          <button
            class="btn"
            ?disabled=${state.planApprovalBusy}
            @click=${() => state.handlePlanApprovalDecision("edit")}
            title="Treat as approved with edits in mind"
          >
            Approve with edits
          </button>
          <button
            class="btn danger"
            ?disabled=${state.planApprovalBusy}
            @click=${async () => {
              const feedback = window.prompt("Reason for rejection (optional):") ?? undefined;
              await state.handlePlanApprovalDecision("reject", feedback || undefined);
            }}
            title="Send back for revision; agent stays in plan mode"
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  `;
}
