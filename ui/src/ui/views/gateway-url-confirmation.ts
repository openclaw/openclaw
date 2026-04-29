import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { AppViewState } from "../app-view-state.ts";
import "../components/modal-dialog.ts";

export function renderGatewayUrlConfirmation(state: AppViewState) {
  const { pendingGatewayUrl } = state;
  if (!pendingGatewayUrl) {
    return nothing;
  }
  const titleId = "gateway-url-confirmation-title";
  const descriptionId = "gateway-url-confirmation-description";

  return html`
    <openclaw-modal-dialog
      label-id=${titleId}
      description-id=${descriptionId}
      @modal-cancel=${() => state.handleGatewayUrlCancel()}
    >
      <div class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div id=${titleId} class="exec-approval-title">
              ${t("channels.gatewayUrlConfirmation.title")}
            </div>
            <div id=${descriptionId} class="exec-approval-sub">
              ${t("channels.gatewayUrlConfirmation.subtitle")}
            </div>
          </div>
        </div>
        <div class="exec-approval-command mono">${pendingGatewayUrl}</div>
        <div class="callout danger" style="margin-top: 12px;">
          ${t("channels.gatewayUrlConfirmation.warning")}
        </div>
        <div class="exec-approval-actions">
          <button class="btn primary" @click=${() => state.handleGatewayUrlConfirm()}>
            ${t("common.confirm")}
          </button>
          <button class="btn" @click=${() => state.handleGatewayUrlCancel()}>
            ${t("common.cancel")}
          </button>
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}
