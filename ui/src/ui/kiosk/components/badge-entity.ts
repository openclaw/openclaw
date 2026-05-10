/**
 * Compact entity badge -- name + state in a chip-shaped pill.
 *
 * Used for the people / phone-battery / alarm row at the top of the
 * Wagner Way overview. Read-only; no tap action.
 */

import { LitElement, html, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";

export class KioskBadgeEntity extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property() entityId: string = "";
  @property() name: string = "";
  @property() state: string = "unavailable";
  @property() unit: string = "";

  override render(): TemplateResult {
    const isUnavailable = !this.state || this.state === "unavailable" || this.state === "unknown";
    const display = isUnavailable ? "n/a" : `${this.state}${this.unit ? this.unit : ""}`;
    return html`<span
      class="kiosk-badge"
      data-state=${this.state}
      data-unavailable=${isUnavailable ? "true" : "false"}
      data-test-id="kiosk-badge"
      title=${this.entityId}
    >
      <span class="kiosk-badge__name">${this.name || this.entityId}</span>
      <span class="kiosk-badge__state">${display}</span>
    </span>`;
  }
}

if (!customElements.get("kiosk-badge-entity")) {
  customElements.define("kiosk-badge-entity", KioskBadgeEntity);
}
