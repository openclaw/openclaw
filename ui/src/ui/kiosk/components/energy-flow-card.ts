/**
 * Static energy-flow card.
 *
 * Renders the four-quadrant low-carbon flow diagram (solar / grid /
 * home / battery) at v1 visual fidelity: nodes with current power
 * readings, edge values for daily totals. The HACS sunsynk-power-flow
 * card has animated dots and SVG line styling; we keep this minimal
 * and rely on the tokens from base.css. Fidelity polish is v2.
 */

import { LitElement, html, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";

export type EnergyNodeReading = {
  /** Display label, e.g. "Solar", "Grid", "Home", "Battery". */
  label: string;
  /** Current instantaneous power (W). */
  power: number | null;
  /** Daily total (kWh). */
  daily?: number;
  /** Optional secondary info (e.g. battery SOC %). */
  detail?: string;
};

export class KioskEnergyFlowCard extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) solar: EnergyNodeReading | null = null;
  @property({ attribute: false }) grid: EnergyNodeReading | null = null;
  @property({ attribute: false }) home: EnergyNodeReading | null = null;
  @property({ attribute: false }) battery: EnergyNodeReading | null = null;

  override render(): TemplateResult {
    return html`<div class="kiosk-card kiosk-energy-flow" data-test-id="kiosk-energy-flow">
      <div class="kiosk-energy-flow__grid">
        ${renderNode("solar", this.solar)} ${renderNode("grid", this.grid)}
        ${renderNode("battery", this.battery)} ${renderNode("home", this.home)}
      </div>
    </div>`;
  }
}

function renderNode(slot: string, node: EnergyNodeReading | null): TemplateResult {
  if (!node) {
    return html`<div
      class="kiosk-energy-flow__node kiosk-energy-flow__node--${slot}"
      data-empty="true"
    >
      <div class="kiosk-energy-flow__label">${slot}</div>
      <div class="kiosk-energy-flow__power">--</div>
    </div>`;
  }
  return html`<div class="kiosk-energy-flow__node kiosk-energy-flow__node--${slot}">
    <div class="kiosk-energy-flow__label">${node.label}</div>
    <div class="kiosk-energy-flow__power">
      ${node.power !== null && Number.isFinite(node.power) ? formatPower(node.power) : "--"}
    </div>
    ${node.daily !== undefined
      ? html`<div class="kiosk-energy-flow__daily">${node.daily.toFixed(1)} kWh</div>`
      : ""}
    ${node.detail ? html`<div class="kiosk-energy-flow__detail">${node.detail}</div>` : ""}
  </div>`;
}

function formatPower(watts: number): string {
  if (Math.abs(watts) >= 1000) {
    return `${(watts / 1000).toFixed(2)} kW`;
  }
  return `${Math.round(watts)} W`;
}

if (!customElements.get("kiosk-energy-flow-card")) {
  customElements.define("kiosk-energy-flow-card", KioskEnergyFlowCard);
}
