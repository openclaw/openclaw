/**
 * Tap-to-toggle tile primitive.
 *
 * Renders a large touch target with icon, name, and state. On tap, emits
 * a `tile-tap` CustomEvent that Unit 8 wires to the gateway service-call
 * loop with optimistic state and reconciliation. The tile itself supports
 * three lifecycle attributes that callers drive:
 *   - data-pending="true" while the call is in flight
 *   - data-error="true" briefly on a denied / failed call
 *   - data-state reflects the current entity state ("on" / "off" / etc.)
 *
 * The tile does NOT do its own service-call dispatch -- that lives in
 * the wagner-way view (Unit 7) where the gateway client + binding are
 * available. Keeping dispatch out of the primitive lets the same
 * component appear in storybook-style harness pages without coupling.
 */

import { LitElement, html, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";

export type TileTapDetail = {
  entityId: string;
  domain: string;
  service: string;
  serviceData?: Record<string, unknown>;
};

export class KioskTileToggle extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** HA entity_id this tile controls. */
  @property() entityId: string = "";
  /** Domain to invoke (e.g. "switch", "cover", "automation"). */
  @property() domain: string = "switch";
  /** Service to invoke (e.g. "toggle"). */
  @property() service: string = "toggle";
  /** Display name. */
  @property() name: string = "";
  /** Current entity state for visual reflection ("on", "off", "open", ...). */
  @property() state: string = "unavailable";
  /** Pending visual while the optimistic call is in flight. */
  @property({ type: Boolean }) pending: boolean = false;
  /** Error visual on denied / failed call. Cleared by the host after a beat. */
  @property({ type: Boolean }) error: boolean = false;
  /** Optional last-flash error message (read by tests; rendered as title). */
  @property() errorMessage: string = "";
  /** Optional emoji or single-char icon shown in the leading icon slot. */
  @property() icon: string = "";

  override render(): TemplateResult {
    const stateLabel = displayStateLabel(this.state);
    return html`<button
      type="button"
      class="kiosk-tile"
      data-state=${this.state}
      data-pending=${this.pending ? "true" : "false"}
      data-error=${this.error ? "true" : "false"}
      data-test-id="kiosk-tile"
      title=${this.errorMessage || ""}
      ?disabled=${!this.entityId}
      @click=${this.onClick}
    >
      <span class="kiosk-tile__icon" aria-hidden="true"
        >${this.icon || iconForState(this.state)}</span
      >
      <span class="kiosk-tile__name">${this.name || this.entityId}</span>
      <span
        class="kiosk-tile__state ${stateLabel === "on" || stateLabel === "open"
          ? "kiosk-tile__state--on"
          : "kiosk-tile__state--off"}"
        >${stateLabel}</span
      >
    </button>`;
  }

  private onClick = (ev: MouseEvent): void => {
    ev.preventDefault();
    if (!this.entityId) return;
    const detail: TileTapDetail = {
      entityId: this.entityId,
      domain: this.domain,
      service: this.service,
    };
    this.dispatchEvent(
      new CustomEvent<TileTapDetail>("tile-tap", { detail, bubbles: true, composed: true }),
    );
  };
}

function displayStateLabel(state: string): string {
  if (!state || state === "unavailable") return "n/a";
  return state;
}

function iconForState(state: string): string {
  if (state === "on" || state === "open") return "*";
  return ".";
}

if (!customElements.get("kiosk-tile-toggle")) {
  customElements.define("kiosk-tile-toggle", KioskTileToggle);
}
