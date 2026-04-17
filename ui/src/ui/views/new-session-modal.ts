import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state.ts";

export function renderNewSessionModal(state: AppViewState) {
  if (!state.newSessionModalOpen) {
    return nothing;
  }

  return html`
    <div
      class="exec-approval-overlay"
      role="dialog"
      aria-modal="true"
      aria-live="polite"
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Escape") {
          state.handleNewSessionCancel();
        }
      }}
    >
      <div class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">New Session</div>
            <div class="exec-approval-sub">Enter a name for your new session</div>
          </div>
        </div>
        <label class="field">
          <input
            type="text"
            placeholder="e.g. stocks, games, work"
            maxlength="64"
            .value=${state.newSessionName}
            @input=${(e: Event) => {
              state.newSessionName = (e.target as HTMLInputElement).value;
            }}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") {
                void state.handleNewSessionConfirm();
              }
            }}
            autofocus
          />
        </label>
        <div class="exec-approval-actions" style="margin-top: 16px;">
          <button class="btn primary" @click=${() => void state.handleNewSessionConfirm()}>
            Create
          </button>
          <button class="btn" @click=${() => state.handleNewSessionCancel()}>Cancel</button>
        </div>
      </div>
    </div>
  `;
}
