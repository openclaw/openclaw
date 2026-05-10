/**
 * Circular gauge primitive (SVG arc).
 *
 * Public attributes:
 *   - value: number (current reading)
 *   - min:  number (default 0)
 *   - max:  number (required)
 *   - unit: string (e.g. "W", "%", "$")
 *   - name: string (caption shown beneath the numeral)
 *   - segments: ColorSegment[] (color bands; first matching `from` wins)
 *
 * Mirrors the visual fidelity of HACS modern-circular-gauge for v1's
 * Wagner Way overview but is a small Lit + SVG primitive, not a port.
 */

import { LitElement, html, svg, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";

export type GaugeColorSegment = {
  /** Inclusive lower bound; if the value >= this, the segment matches. */
  from: number;
  /** Hex or rgb() color string. */
  color: string;
};

const DEFAULT_SEGMENTS: GaugeColorSegment[] = [{ from: 0, color: "var(--accent)" }];

export class KioskGaugeCircular extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ type: Number }) value: number = 0;
  @property({ type: Number }) min: number = 0;
  @property({ type: Number }) max: number = 100;
  @property({ type: String }) unit: string = "";
  @property({ type: String }) name: string = "";
  @property({ attribute: false }) segments: GaugeColorSegment[] = DEFAULT_SEGMENTS;

  override render(): TemplateResult {
    const value = Number.isFinite(this.value) ? this.value : Number.NaN;
    const min = this.min;
    const max = this.max;
    const range = max - min;

    if (!Number.isFinite(value) || range <= 0) {
      return html`<div class="kiosk-gauge" data-empty="true">
        ${this.renderArc(0, "var(--muted)")}
        <div class="kiosk-gauge__numeral">--</div>
        ${this.renderName()}
      </div>`;
    }

    const clamped = Math.max(min, Math.min(max, value));
    const ratio = (clamped - min) / range;
    const color = pickSegmentColor(value, this.segments);

    return html`<div class="kiosk-gauge">
      ${this.renderArc(ratio, color)}
      <div class="kiosk-gauge__numeral">
        ${formatValue(value)}${this.unit
          ? html`<span class="kiosk-gauge__unit-suffix" aria-hidden="true">${this.unit}</span>`
          : ""}
      </div>
      ${this.renderName()}
    </div>`;
  }

  private renderName(): TemplateResult {
    return this.name ? html`<div class="kiosk-gauge__name">${this.name}</div>` : html``;
  }

  private renderArc(ratio: number, color: string): TemplateResult {
    // 270deg arc starting from -135deg (lower-left) to +135deg (lower-right).
    // Standard gauge sweep with a gap at the bottom.
    const radius = 80;
    const center = 100;
    const stroke = 12;
    const startAngle = -225;
    const endAngle = 45;
    const totalSweep = endAngle - startAngle;
    const valueAngle = startAngle + totalSweep * ratio;

    const bgPath = describeArc(center, center, radius, startAngle, endAngle);
    const valuePath = describeArc(center, center, radius, startAngle, valueAngle);

    return svg`
      <svg viewBox="0 0 200 200" role="presentation" aria-hidden="true">
        <path
          d=${bgPath}
          stroke="var(--border)"
          stroke-width=${stroke}
          stroke-linecap="round"
          fill="none"
        />
        ${
          ratio > 0
            ? svg`<path
              d=${valuePath}
              stroke=${color}
              stroke-width=${stroke}
              stroke-linecap="round"
              fill="none"
            />`
            : svg``
        }
      </svg>
    `;
  }
}

function pickSegmentColor(value: number, segments: GaugeColorSegment[]): string {
  if (!segments || segments.length === 0) {
    return "var(--accent)";
  }
  // Sort by `from` ascending; pick the highest `from` that the value is >=.
  const sorted = [...segments].sort((a, b) => a.from - b.from);
  let chosen = sorted[0].color;
  for (const segment of sorted) {
    if (value >= segment.from) {
      chosen = segment.color;
    }
  }
  return chosen;
}

function formatValue(value: number): string {
  if (!Number.isFinite(value)) return "--";
  if (Math.abs(value) >= 10000) {
    return Math.round(value).toLocaleString();
  }
  if (Math.abs(value) >= 100) {
    return Math.round(value).toString();
  }
  if (Math.abs(value) >= 10) {
    return value.toFixed(0);
  }
  return value.toFixed(1);
}

function polarToCartesian(cx: number, cy: number, radius: number, angleDeg: number) {
  const angleRad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(angleRad),
    y: cy + radius * Math.sin(angleRad),
  };
}

function describeArc(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
): string {
  const start = polarToCartesian(cx, cy, radius, endAngle);
  const end = polarToCartesian(cx, cy, radius, startAngle);
  const sweep = endAngle - startAngle;
  const largeArc = Math.abs(sweep) > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 0 ${end.x} ${end.y}`;
}

if (!customElements.get("kiosk-gauge-circular")) {
  customElements.define("kiosk-gauge-circular", KioskGaugeCircular);
}
