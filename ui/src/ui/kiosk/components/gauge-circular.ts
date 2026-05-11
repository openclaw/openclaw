/**
 * Circular gauge primitive (SVG arc).
 *
 * Visual model mirrors the HACS `modern-circular-gauge` card by selvalt7:
 * https://github.com/selvalt7/modern-circular-gauge
 *
 * Implementation notes (locked to that card's geometry for fidelity):
 *   - viewBox -50 -50 100 100, RADIUS = 47, stroke = 6.
 *   - Single 270deg arc path computed once from angle 0 to 270 (math
 *     convention; angle 0 = 3 o'clock).
 *   - The whole arc group is rotated by 135deg so the open gap sits at
 *     the bottom of the circle (classic gauge sweep from lower-left to
 *     lower-right).
 *   - Foreground "value" reveal is done with stroke-dasharray on the same
 *     path -- no second arc computation, no joins, smooth at every value.
 *   - Stroke-linecap is round so the value tip has the same pill cap as
 *     the original card.
 *
 * Segments: a list of color bands with a `from` threshold. The active
 * band (highest `from` <= value) colors the value arc. Smooth-gradient
 * mode from the original (conic-gradient via foreignObject) is not
 * implemented in v1 -- visually we get the same step-color reveal that
 * the kiosk plan called for.
 */

import { LitElement, html, svg, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";

export type GaugeColorSegment = {
  /** Inclusive lower bound; if the value >= this, the segment matches. */
  from: number;
  /** Hex or rgb() color string, or CSS variable reference. */
  color: string;
};

const DEFAULT_SEGMENTS: GaugeColorSegment[] = [{ from: 0, color: "var(--accent)" }];

// -- Geometry constants (match selvalt7/modern-circular-gauge) -------------

const RADIUS = 47;
const MAX_ANGLE = 270;
const STROKE_WIDTH = 6;
// rotateAngle = 360 - MAX_ANGLE / 2 - 90 = 360 - 135 - 90 = 135
const ROTATE_ANGLE = 360 - MAX_ANGLE / 2 - 90;
const TRACK_CIRCUMFERENCE = (RADIUS * 2 * Math.PI * MAX_ANGLE) / 360;

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
    const range = this.max - this.min;

    if (!Number.isFinite(value) || range <= 0) {
      return html`<div class="kiosk-gauge" data-empty="true">
        ${this.renderArc(0, "var(--muted)")}
        <div class="kiosk-gauge__numeral">--</div>
        ${this.renderName()}
      </div>`;
    }

    const clamped = Math.max(this.min, Math.min(this.max, value));
    const ratio = (clamped - this.min) / range;
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
    const arcLength = Math.max(ratio * TRACK_CIRCUMFERENCE, 0);
    const dasharray = `${arcLength} ${TRACK_CIRCUMFERENCE - arcLength}`;
    const path = describeArc(0, 0, RADIUS, 0, MAX_ANGLE);

    return svg`
      <svg viewBox="-50 -50 100 100" role="presentation" aria-hidden="true">
        <g transform="rotate(${ROTATE_ANGLE})">
          <path
            class="kiosk-gauge__track"
            d=${path}
            stroke="var(--border)"
            stroke-width=${STROKE_WIDTH}
            stroke-linecap="round"
            fill="none"
          />
          ${
            ratio > 0
              ? svg`<path
                  class="kiosk-gauge__value"
                  d=${path}
                  stroke=${color}
                  stroke-width=${STROKE_WIDTH}
                  stroke-linecap="round"
                  fill="none"
                  stroke-dasharray=${dasharray}
                />`
              : svg``
          }
        </g>
      </svg>
    `;
  }
}

function pickSegmentColor(value: number, segments: GaugeColorSegment[]): string {
  if (!segments || segments.length === 0) {
    return "var(--accent)";
  }
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

// -- SVG arc geometry (matches selvalt7/modern-circular-gauge svgArc) ------

function describeArc(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const start = toRadian(startDeg);
  const end = toRadian(endDeg);
  const delta = (end - start) % (2 * Math.PI);
  const startX = cx + r * Math.cos(start);
  const startY = cy + r * Math.sin(start);
  const endX = cx + r * Math.cos(start + delta);
  const endY = cy + r * Math.sin(start + delta);
  const largeArc = delta > Math.PI ? 1 : 0;
  const sweep = delta > 0 ? 1 : 0;
  return `M ${startX} ${startY} A ${r} ${r} 0 ${largeArc} ${sweep} ${endX} ${endY}`;
}

function toRadian(angleDeg: number): number {
  return (angleDeg / 180) * Math.PI;
}

if (!customElements.get("kiosk-gauge-circular")) {
  customElements.define("kiosk-gauge-circular", KioskGaugeCircular);
}
