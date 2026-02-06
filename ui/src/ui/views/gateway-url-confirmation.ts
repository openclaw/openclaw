import { msg } from "@lit/localize";
import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state.ts";

export function renderGatewayUrlConfirmation(state: AppViewState) {
  const { pendingGatewayUrl } = state;
  if (!pendingGatewayUrl) {
    return nothing;
  }

  return html`
    <div class="exec-approval-overlay" role="dialog" aria-modal="true" aria-live="polite">
      <div class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">${msg("Change Gateway URL", { id: "gatewayUrl.title" })}</div>
            <div class="exec-approval-sub">${msg(
              "This will reconnect to a different gateway server",
              { id: "gatewayUrl.subtitle" },
            )}</div>
          </div>
        </div>
        <div class="exec-approval-command mono">${pendingGatewayUrl}</div>
        <div class="callout danger" style="margin-top: 12px;">
          ${msg("Only confirm if you trust this URL. Malicious URLs can compromise your system.", {
            id: "gatewayUrl.warning",
          })}
        </div>
        <div class="exec-approval-actions">
          <button
            class="btn primary"
            @click=${() => state.handleGatewayUrlConfirm()}
          >
            ${msg("Confirm", { id: "gatewayUrl.confirm" })}
          </button>
          <button
            class="btn"
            @click=${() => state.handleGatewayUrlCancel()}
          >
            ${msg("Cancel", { id: "gatewayUrl.cancel" })}
          </button>
        </div>
      </div>
    </div>
  `;
}
