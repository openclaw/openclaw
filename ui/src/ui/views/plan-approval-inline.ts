/**
 * Inline plan-approval card (PR-8 follow-up).
 *
 * Renders ABOVE the chat input bar, mimicking Claude Code's
 * "Claude proposed a plan" affordance: compact title strip + 3 buttons
 * (Approve / Approve with edits / Reject) + an "Open plan" link that
 * pops the full checklist into the right sidebar via the same path
 * tool-output details use.
 *
 * This replaces the modal overlay design — modal blocked the rest of
 * the UI and required Cmd+R to dismiss when stuck. Inline keeps the
 * chat scrollable and the chip + slash command still operable.
 */
import { html, nothing, type TemplateResult } from "lit";
import type { PlanApprovalRequest } from "../app-tool-stream.ts";

export interface InlinePlanApprovalProps {
  request: PlanApprovalRequest | null;
  busy: boolean;
  error: string | null;
  onApprove: () => void;
  onEdit: () => void;
  onReject: () => void;
  /** Pop the full plan into the right sidebar (read-only). */
  onOpenPlan: () => void;
}

export function renderInlinePlanApproval(
  props: InlinePlanApprovalProps,
): TemplateResult | typeof nothing {
  if (!props.request) {
    return nothing;
  }
  const { request, busy, error } = props;
  const stepCount = request.plan.length;
  const stepLabel = stepCount === 1 ? "step" : "steps";
  const summary = request.summary?.trim();
  return html`
    <div class="plan-inline-card" role="region" aria-label="Plan approval">
      <div class="plan-inline-card__header">
        <div class="plan-inline-card__title">
          ${summary
            ? html`<strong>Agent proposed a plan</strong>
                <span class="plan-inline-card__summary">— ${summary}</span>`
            : html`<strong>Agent proposed a plan</strong>`}
        </div>
        <button
          class="plan-inline-card__open"
          type="button"
          @click=${props.onOpenPlan}
          title="Open the full plan in the side panel"
        >
          Open plan
        </button>
      </div>
      <div class="plan-inline-card__meta">${stepCount} ${stepLabel}</div>
      ${error ? html`<div class="plan-inline-card__error">${error}</div>` : nothing}
      <div class="plan-inline-card__actions">
        <button
          class="plan-inline-card__btn plan-inline-card__btn--primary"
          type="button"
          ?disabled=${busy}
          @click=${props.onApprove}
        >
          Accept
        </button>
        <button
          class="plan-inline-card__btn"
          type="button"
          ?disabled=${busy}
          @click=${props.onEdit}
          title="Treat as approved with edits in mind"
        >
          Accept, allow edits
        </button>
        <button
          class="plan-inline-card__btn plan-inline-card__btn--danger"
          type="button"
          ?disabled=${busy}
          @click=${props.onReject}
          title="Send back for revision; agent stays in plan mode"
        >
          Revise
        </button>
      </div>
    </div>
  `;
}
