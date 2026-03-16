import { html } from "lit";
import { t } from "../../i18n/index.ts";

export function renderReseller() {
  return html`
    <div class="reseller-view">
      <div class="reseller-placeholder">
        <p class="reseller-placeholder__text">${t("reseller.placeholder")}</p>
      </div>
    </div>
  `;
}
