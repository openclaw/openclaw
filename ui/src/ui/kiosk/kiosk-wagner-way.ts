/**
 * Wagner Way overview Lit element -- placeholder shell.
 *
 * Real composition lands in Unit 7. This stub exists so that
 * `kiosk-bootstrap.ts` can mount a complete tree even before Unit 7
 * lands; tests that only need the shell + connection pill don't depend
 * on the full overview layout.
 */
import { LitElement, html, type TemplateResult } from "lit";

export class KioskWagnerWay extends LitElement {
  override createRenderRoot() {
    return this;
  }

  override render(): TemplateResult {
    return html`<div class="kiosk-wagner-way" data-test-id="kiosk-wagner-way-placeholder">
      <p>Wagner Way overview composition lands in Unit 7.</p>
    </div>`;
  }
}

if (!customElements.get("kiosk-wagner-way")) {
  customElements.define("kiosk-wagner-way", KioskWagnerWay);
}
