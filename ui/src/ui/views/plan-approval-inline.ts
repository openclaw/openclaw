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
  connected: boolean;
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
  // PR-10 AskUserQuestion: required when request.question is present.
  // Routed by the host to sessions.patch { planApproval: { action:
  // "answer", answer: <text> } }. Same approval-card shell renders the
  // question prompt + one button per option (and optional Other field).
  onAnswerOption?: (answer: string) => void;
  /**
   * PR-13 Bug 2: question-card "Other" inline-textarea state. Caller
   * owns these (mirrors the reviseOpen/reviseDraft pattern) so backing
   * out of the textarea returns to the option list instead of (as
   * window.prompt cancellation did) appearing to exit the sequence.
   */
  questionOtherOpen?: boolean;
  questionOtherDraft?: string;
  onQuestionOtherOpen?: () => void;
  onQuestionOtherCancel?: () => void;
  onQuestionOtherDraftChange?: (text: string) => void;
  onQuestionOtherSubmit?: () => void;
}

export function renderInlinePlanApproval(
  props: InlinePlanApprovalProps,
): TemplateResult | typeof nothing {
  if (!props.request) {
    return nothing;
  }
  const { request, busy, error, reviseOpen } = props;
  const actionsDisabled = busy || !props.connected;
  // PR-10 AskUserQuestion: when the approval payload carries a
  // question, render a different card shape (question prompt + N
  // option buttons) instead of the standard plan approval triad.
  if (request.question) {
    return renderInlineQuestion(props);
  }
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
      ${!props.connected
        ? html`<div class="plan-inline-card__error">
            Reconnect to resolve this plan. The approval stays pending while offline.
          </div>`
        : nothing}
      ${reviseOpen
        ? html`
            <textarea
              class="plan-inline-card__revise-input"
              placeholder="What should change? (optional, sent to the agent as feedback)"
              rows="3"
              .value=${props.reviseDraft}
              ?disabled=${actionsDisabled}
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
                ?disabled=${actionsDisabled}
                @click=${props.onReviseSubmit}
              >
                Send revision
              </button>
              <button
                class="plan-inline-card__btn"
                type="button"
                ?disabled=${actionsDisabled}
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
                ?disabled=${actionsDisabled}
                @click=${props.onApprove}
                title="Execute the plan as proposed — no edits"
              >
                Accept
              </button>
              <button
                class="plan-inline-card__btn"
                type="button"
                ?disabled=${actionsDisabled}
                @click=${props.onAcceptWithEdits}
                title="Approve and let the agent adjust steps as it goes"
              >
                Accept, allow edits
              </button>
              <button
                class="plan-inline-card__btn plan-inline-card__btn--danger"
                type="button"
                ?disabled=${actionsDisabled}
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

/**
 * PR-10: question variant of the inline approval card. Same visual
 * shell as the plan approval card but renders the question prompt +
 * one button per option (plus an optional "Other..." textarea when
 * `allowFreetext` is true). Click → onAnswerOption(text).
 */
function renderInlineQuestion(props: InlinePlanApprovalProps): TemplateResult {
  const { request, busy, error } = props;
  const question = request!.question!;
  // PR-13 Bug 2: render the "Other" inline textarea when the user has
  // clicked Other and not yet submitted/cancelled. Mirrors the revise
  // UX so backing out (Cancel button or Escape key) returns to the
  // option list instead of (as window.prompt cancellation appeared to
  // do) exiting the entire sequence.
  const otherOpen = props.questionOtherOpen === true;
  // PR-11 review fix (Copilot #3104741709): the props interface types
  // `onAnswerOption` as optional + uses optional-chaining at the call
  // site, so a host that forgets to wire `onPlanApprovalAnswer`
  // would render interactive-looking buttons that silently no-op.
  // When the handler is missing, disable the buttons + surface a
  // visible warning so the wiring gap is obvious instead of mute.
  const answerHandlerMissing = typeof props.onAnswerOption !== "function";
  const answerButtonsDisabled = busy || !props.connected || answerHandlerMissing;
  return html`
    <div class="plan-inline-card" role="region" aria-label="Agent question">
      <div class="plan-inline-card__header">
        <div class="plan-inline-card__title">
          <strong>Agent has a question</strong>
          <span class="plan-inline-card__summary">— ${question.prompt}</span>
        </div>
      </div>
      <div class="plan-inline-card__meta">
        ${question.options.length} options${question.allowFreetext ? " + free text" : ""}
      </div>
      ${error ? html`<div class="plan-inline-card__error">${error}</div>` : nothing}
      ${!props.connected
        ? html`<div class="plan-inline-card__error">
            Reconnect to answer this question. The prompt stays pending while offline.
          </div>`
        : nothing}
      ${answerHandlerMissing
        ? html`<div class="plan-inline-card__error">
            ⚠️ Question handler not wired (host did not pass
            <code>onPlanApprovalAnswer</code>). Buttons disabled.
          </div>`
        : nothing}
      ${otherOpen
        ? html`
            <textarea
              class="plan-inline-card__revise-input"
              placeholder="Type your answer to the question above…"
              rows="3"
              .value=${props.questionOtherDraft ?? ""}
              ?disabled=${busy || !props.connected}
              @input=${(e: Event) =>
                props.onQuestionOtherDraftChange?.((e.target as HTMLTextAreaElement).value)}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  props.onQuestionOtherSubmit?.();
                } else if (e.key === "Escape") {
                  // PR-13 Bug 2: Escape returns to options, doesn't
                  // dismiss the card.
                  e.preventDefault();
                  props.onQuestionOtherCancel?.();
                }
              }}
            ></textarea>
            <div class="plan-inline-card__actions">
              <button
                class="plan-inline-card__btn plan-inline-card__btn--primary"
                type="button"
                ?disabled=${busy ||
                !props.connected ||
                !(props.questionOtherDraft && props.questionOtherDraft.trim().length > 0)}
                @click=${() => props.onQuestionOtherSubmit?.()}
                title="Send the typed answer"
              >
                Send answer
              </button>
              <button
                class="plan-inline-card__btn"
                type="button"
                ?disabled=${busy || !props.connected}
                @click=${() => props.onQuestionOtherCancel?.()}
                title="Back to the option list"
              >
                Back to options
              </button>
            </div>
          `
        : html`
            <div class="plan-inline-card__actions plan-inline-card__actions--question">
              ${question.options.map(
                (option, idx) => html`
                  <button
                    class="plan-inline-card__btn ${idx === 0
                      ? "plan-inline-card__btn--primary"
                      : ""}"
                    type="button"
                    ?disabled=${answerButtonsDisabled}
                    @click=${() => props.onAnswerOption?.(option)}
                    title=${answerHandlerMissing
                      ? "Disabled: question handler not wired"
                      : `Answer: ${option}`}
                  >
                    ${option}
                  </button>
                `,
              )}
              ${question.allowFreetext
                ? html`
                    <button
                      class="plan-inline-card__btn plan-inline-card__btn--secondary"
                      type="button"
                      ?disabled=${answerButtonsDisabled}
                      @click=${() => props.onQuestionOtherOpen?.()}
                      title=${answerHandlerMissing
                        ? "Disabled: question handler not wired"
                        : "Type a free-text answer"}
                    >
                      Other…
                    </button>
                  `
                : nothing}
            </div>
          `}
    </div>
  `;
}
