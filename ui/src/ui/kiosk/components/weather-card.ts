/**
 * Clock + current-conditions weather card.
 *
 * v1: text-only (clock, current temp, current conditions, simple
 * forecast list). The HACS clock-weather-card has animated icons
 * and rich layout; we keep this minimal and consistent with the
 * vanilla CSS token set. Visual fidelity polish is a v2 follow-up.
 */

import { LitElement, html, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";

export type WeatherForecastEntry = {
  /** ISO date or human label. */
  label: string;
  /** Conditions (e.g. "rainy", "partlycloudy"). */
  conditions: string;
  /** Low temperature. */
  low?: number;
  /** High temperature. */
  high?: number;
};

export class KioskWeatherCard extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property() title: string = "";
  /** Current conditions text. */
  @property() conditions: string = "";
  @property({ type: Number }) currentTemp: number | null = null;
  @property({ type: Number }) humidity: number | null = null;
  @property({ type: String }) unit: string = "C";
  @property({ type: String }) clock: string = "";
  @property({ type: String }) date: string = "";
  @property({ attribute: false }) forecast: WeatherForecastEntry[] = [];

  override render(): TemplateResult {
    return html`<div class="kiosk-card kiosk-weather" data-test-id="kiosk-weather">
      ${this.title ? html`<div class="kiosk-weather__title">${this.title}</div>` : ""}
      <div class="kiosk-weather__now">
        ${this.clock ? html`<div class="kiosk-weather__clock">${this.clock}</div>` : ""}
        ${this.date ? html`<div class="kiosk-weather__date">${this.date}</div>` : ""}
        ${this.currentTemp !== null
          ? html`<div class="kiosk-weather__temp">
              ${formatTemp(this.currentTemp)}&deg;${this.unit}
            </div>`
          : html``}
        ${this.conditions
          ? html`<div class="kiosk-weather__conditions">${this.conditions}</div>`
          : ""}
        ${this.humidity !== null
          ? html`<div class="kiosk-weather__humidity">${this.humidity}% humidity</div>`
          : ""}
      </div>
      ${this.forecast.length > 0
        ? html`<ul class="kiosk-weather__forecast">
            ${this.forecast.map(
              (row) => html`<li class="kiosk-weather__forecast-row">
                <span class="kiosk-weather__forecast-label">${row.label}</span>
                <span class="kiosk-weather__forecast-conditions">${row.conditions}</span>
                <span class="kiosk-weather__forecast-temps">
                  ${row.low !== undefined ? formatTemp(row.low) : "--"} /
                  ${row.high !== undefined ? formatTemp(row.high) : "--"}&deg;
                </span>
              </li>`,
            )}
          </ul>`
        : ""}
    </div>`;
  }
}

function formatTemp(value: number): string {
  if (!Number.isFinite(value)) return "--";
  return Math.round(value).toString();
}

if (!customElements.get("kiosk-weather-card")) {
  customElements.define("kiosk-weather-card", KioskWeatherCard);
}
