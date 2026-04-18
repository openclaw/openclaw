/**
 * Inline plan-approval card (PR-8 follow-up).
 *
 * Renders ABOVE the chat input bar, mimicking Claude Code's
 * "Claude proposed a plan" affordance: compact title strip + 3 buttons
 * (Accept / Accept allow edits / Revise) + an "Open plan" link that
 * pops the full checklist into the right sidebar via the same path
 * tool-output details use.
 *
 * Revise opens an inline textarea in-place (no popup), matching
 * Claude Code's revision UX. The chat input bar is hidden by the
 * caller (via `planApprovalRequest != null`) while this card is
 * showing so users don't accidentally type into the wrong surface.
 */
import { html, nothing, type TemplateResult } from "lit";
import type { PlanApprovalRequest } from "../app-tool-stream.ts";

export interface InlinePlanApprovalProps {
  request: PlanApprovalRequest | null;
  busy: boolean;
  error: string | null;
  /** Local "revise textarea open" state — caller owns it so it survives renders. */
  reviseOpen: boolean;
  reviseDraft: string;
  onApprove: () => void;
  onAcceptWithEdits: () => void;
  onReviseOpen: () => void;
  onReviseCancel: () => void;
  onReviseDraftChange: (text: string) => void;
  onReviseSubmit: () => void;
  /** Pop the full plan into the right sidebar (read-only). */
  onOpenPlan: () => void;
}

export function renderInlinePlanApproval(
  props: InlinePlanApprovalProps,
): TemplateResult | typeof nothing {
  if (!props.request) {
    return nothing;
  }
  const { request, busy, error, reviseOpen } = props;
  const stepCount = request.plan.length;
  const stepLabel = stepCount === 1 ? "step" : "steps";
  const summary = request.summary?.trim();
  // PR-9 Tier 1: prefer the agent's explicit title (set via
  // exit_plan_mode { title: "..." }) when it's distinct from the
  // generic boilerplate. Falls back to "Agent proposed a plan" so
  // pre-Tier-1 agents that only supply summary still render cleanly.
  const rawTitle = request.title?.trim();
  const isGenericTitle =
    !rawTitle || rawTitle === "Plan approval requested" || rawTitle.startsWith("Plan approval —");
  const headline = isGenericTitle ? "Agent proposed a plan" : rawTitle;
  return html`
    <div class="plan-inline-card" role="region" aria-label="Plan approval">
      <div class="plan-inline-card__header">
        <div class="plan-inline-card__title">
          ${summary
            ? html`<strong>${headline}</strong>
                <span class="plan-inline-card__summary">— ${summary}</span>`
            : html`<strong>${headline}</strong>`}
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
      ${reviseOpen
        ? html`
            <textarea
              class="plan-inline-card__revise-input"
              placeholder="What should change? (optional, sent to the agent as feedback)"
              rows="3"
              .value=${props.reviseDraft}
              ?disabled=${busy}
              @input=${(e: Event) =>
                props.onReviseDraftChange((e.target as HTMLTextAreaElement).value)}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  props.onReviseSubmit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  props.onReviseCancel();
                }
              }}
            ></textarea>
            <div class="plan-inline-card__actions">
              <button
                class="plan-inline-card__btn plan-inline-card__btn--primary"
                type="button"
                ?disabled=${busy}
                @click=${props.onReviseSubmit}
              >
                Send revision
              </button>
              <button
                class="plan-inline-card__btn"
                type="button"
                ?disabled=${busy}
                @click=${props.onReviseCancel}
              >
                Cancel
              </button>
            </div>
          `
        : html`
            <div class="plan-inline-card__actions">
              <button
                class="plan-inline-card__btn plan-inline-card__btn--primary"
                type="button"
                ?disabled=${busy}
                @click=${props.onApprove}
                title="Execute the plan as proposed — no edits"
              >
                Accept
              </button>
              <button
                class="plan-inline-card__btn"
                type="button"
                ?disabled=${busy}
                @click=${props.onAcceptWithEdits}
                title="Approve and let the agent adjust steps as it goes"
              >
                Accept, allow edits
              </button>
              <button
                class="plan-inline-card__btn plan-inline-card__btn--danger"
                type="button"
                ?disabled=${busy}
                @click=${props.onReviseOpen}
                title="Send back for revision; agent stays in plan mode"
              >
                Revise
              </button>
            </div>
          `}
    </div>
  `;
}
