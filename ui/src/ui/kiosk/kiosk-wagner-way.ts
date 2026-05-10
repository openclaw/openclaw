/**
 * Wagner Way overview composition.
 *
 * Mirrors the layout of the user's existing Home Assistant Lovelace
 * "Wagner Way" view at v1 visual fidelity, using the OpenClaw-native
 * Lit primitives from `./components/`. Every entity reference goes
 * through a slot map so the household can rename or replace devices
 * without touching this file -- the slot keys are the contract, the
 * entity IDs are config.
 *
 * Sections, in source order:
 *   1. Badges row: people, phone/iPad batteries, alarms.
 *   2. House Info row: clock+weather card, energy flow card.
 *   3. Energy gauges row: Battery SOC, Solar Power.
 *   4. Power gauges row: Grid Power, House Power.
 *   5. Major Appliances row: Geyser, Pool, Jacuzzi, Total Clients, BTC.
 *   6. Quick Keys tile grid: gates, lights, pumps, blinds.
 *   7. Footer: Vacuums + Front Door Cam placeholders (v2 lands them).
 *
 * Each tile that maps to a deny-listed service or a missing slot is
 * rendered as a disabled placeholder rather than removed silently --
 * that surface tells the operator something is mis-configured.
 */

import { LitElement, html, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import "./components/gauge-circular.js";
import "./components/tile-toggle.js";
import "./components/badge-entity.js";
import "./components/weather-card.js";
import "./components/energy-flow-card.js";
import type { GaugeColorSegment } from "./components/gauge-circular.js";
import type { TileTapDetail } from "./components/tile-toggle.js";
import type { HaStateBinding } from "./ha-state-binding.js";
import { TileInteractionController } from "./tile-interaction-controller.js";

// -- Slot contract ----------------------------------------------------------

/**
 * Map of slot name -> HA entity_id. v1 ships a default that mirrors the
 * household's existing Lovelace YAML; the bootstrap or operator config
 * can override individual entries.
 */
export type WagnerWaySlots = Record<string, string>;

export const DEFAULT_WAGNER_WAY_SLOTS: WagnerWaySlots = {
  // Badges
  "person.audrey": "person.audrey_de_klerk",
  "battery.audrey_iphone": "sensor.audrey_platinum_iphone_battery_level",
  "person.michelle": "person.michele_van_wyk",
  "battery.michelle_iphone": "sensor.michelle_iphone_battery_level",
  "person.ijeani": "person.ijeani_van_wyk",
  "battery.ijeani_ipad": "sensor.ijeani_ipad_air_battery_level",
  "person.peter": "person.peter_van_wyk",
  "battery.peter_iphone": "sensor.peter_platinum_iphone_16_battery_level",
  "alarm.wagner": "alarm_control_panel.ring_alarm",
  "alarm.bourbon": "alarm_control_panel.alarm",
  // Weather + outdoor sensors
  "weather.primary": "weather.pirateweather",
  "sensor.outdoor_temp": "sensor.outdoor_temp",
  "sensor.outdoor_humidity": "sensor.outdoor_humidity",
  // Energy flow nodes
  "energy.solar_power": "sensor.deye_sunsynk_sol_ark_pv_power",
  "energy.solar_daily": "sensor.deye_sunsynk_sol_ark_pv_energy",
  "energy.grid_power": "sensor.deye_sunsynk_sol_ark_grid_power",
  "energy.grid_daily": "sensor.deye_sunsynk_sol_ark_grid_energy_in",
  "energy.load_power": "sensor.deye_sunsynk_sol_ark_load_power",
  "energy.load_daily": "sensor.deye_sunsynk_sol_ark_load_energy",
  "energy.battery_power": "sensor.deye_sunsynk_sol_ark_battery_power",
  "energy.battery_soc": "sensor.deye_sunsynk_sol_ark_battery_state_of_charge",
  // Major appliance gauges
  "gauge.geyser_power": "sensor.sonoff_10014e4497_power",
  "gauge.pool_pump_power": "sensor.sonoff_1001f43fa5_power",
  "gauge.jacuzzi_pump_power": "sensor.sonoff_1001f4478d_power",
  "gauge.total_clients": "sensor.tp_link_router_total_clients",
  "gauge.btc_price": "sensor.cryptoinfo_btc_price",
  // Quick Keys (tiles)
  "tile.gate_main": "switch.sonoff_10013c3266",
  "tile.garage_door": "switch.sonoff_10015c4e8e",
  "tile.entrance_lights": "switch.main_entrance_ligts_switch",
  "tile.braai_light": "switch.wagner_braai_light",
  "tile.geyser_main": "switch.sonoff_10014e4497",
  "tile.geyser_timer": "automation.geyser_timer",
  "tile.vintage_lights": "switch.sonoff_1000a8d0f7_1",
  "tile.jacuzzi_down_lights": "switch.sonoff_100230c71f_3",
  "tile.patio_lights": "switch.sonoff_1000a8d0f7_2",
  "tile.pool_pump": "switch.sonoff_1001f43fa5",
  "tile.jacuzzi_pump": "switch.sonoff_1001f4478d",
  "tile.office_lights": "switch.sonoff_1000c7e394",
  "tile.wall_lights": "switch.sonoff_100230c71f_2",
  "tile.left_blind": "cover.aqara_roller_blind_left",
  "tile.right_blind": "cover.aqara_roller_blind_right",
};

// -- Tile / badge / gauge declarations --------------------------------------

type BadgeSpec = {
  slot: string;
  name: string;
  unit?: string;
};

type GaugeSpec = {
  slot: string;
  name: string;
  unit: string;
  min: number;
  max: number;
  segments: GaugeColorSegment[];
};

type TileSpec = {
  slot: string;
  name: string;
  domain: string;
  service: string;
  icon?: string;
};

const BADGES: BadgeSpec[] = [
  { slot: "person.audrey", name: "Audrey" },
  { slot: "battery.audrey_iphone", name: "Audrey iPhone", unit: "%" },
  { slot: "person.michelle", name: "Michelle" },
  { slot: "battery.michelle_iphone", name: "Michelle iPhone", unit: "%" },
  { slot: "person.ijeani", name: "Ijeani" },
  { slot: "battery.ijeani_ipad", name: "Ijeani iPad", unit: "%" },
  { slot: "person.peter", name: "Peter" },
  { slot: "battery.peter_iphone", name: "Peter iPhone", unit: "%" },
  { slot: "alarm.wagner", name: "Wagner Alarm" },
  { slot: "alarm.bourbon", name: "Bourbon Alarm" },
];

const SOC_SEGMENTS: GaugeColorSegment[] = [
  { from: 0, color: "#ff0000" },
  { from: 40, color: "#fca103" },
  { from: 60, color: "#2bff00" },
  { from: 90, color: "#0bb6ef" },
];

const SOLAR_SEGMENTS: GaugeColorSegment[] = [
  { from: 0, color: "#ff0000" },
  { from: 1500, color: "#fca103" },
  { from: 3000, color: "#2bff00" },
  { from: 4500, color: "#0bb6ef" },
];

const POWER_SEGMENTS: GaugeColorSegment[] = [
  { from: 0, color: "#0bb6ef" },
  { from: 1500, color: "#2bff00" },
  { from: 2500, color: "#fca103" },
  { from: 4000, color: "#ff0000" },
];

const APPLIANCE_SEGMENTS: GaugeColorSegment[] = [
  { from: 0, color: "#0bb6ef" },
  { from: 500, color: "#2bff00" },
  { from: 900, color: "#fca103" },
  { from: 1500, color: "#ff0000" },
];

const GEYSER_SEGMENTS: GaugeColorSegment[] = [
  { from: 0, color: "#0bb6ef" },
  { from: 500, color: "#2bff00" },
  { from: 900, color: "#fca103" },
  { from: 1500, color: "#ff0000" },
];

const ENERGY_GAUGES: GaugeSpec[] = [
  {
    slot: "energy.battery_soc",
    name: "Battery SOC",
    unit: "%",
    min: 0,
    max: 100,
    segments: SOC_SEGMENTS,
  },
  {
    slot: "energy.solar_power",
    name: "Solar Power",
    unit: "W",
    min: 0,
    max: 5000,
    segments: SOLAR_SEGMENTS,
  },
];

const POWER_GAUGES: GaugeSpec[] = [
  {
    slot: "energy.grid_power",
    name: "Grid Power",
    unit: "W",
    min: 0,
    max: 6000,
    segments: POWER_SEGMENTS,
  },
  {
    slot: "energy.load_power",
    name: "House Power",
    unit: "W",
    min: 0,
    max: 6000,
    segments: POWER_SEGMENTS,
  },
];

const APPLIANCE_GAUGES: GaugeSpec[] = [
  {
    slot: "gauge.geyser_power",
    name: "Geyser",
    unit: "W",
    min: 0,
    max: 3000,
    segments: GEYSER_SEGMENTS,
  },
  {
    slot: "gauge.pool_pump_power",
    name: "Pool Pump",
    unit: "W",
    min: 0,
    max: 1500,
    segments: APPLIANCE_SEGMENTS,
  },
  {
    slot: "gauge.jacuzzi_pump_power",
    name: "Jacuzzi Pump",
    unit: "W",
    min: 0,
    max: 1500,
    segments: APPLIANCE_SEGMENTS,
  },
  {
    slot: "gauge.total_clients",
    name: "Total Clients",
    unit: "",
    min: 0,
    max: 250,
    segments: [{ from: 0, color: "#0bb6ef" }],
  },
  {
    slot: "gauge.btc_price",
    name: "Bitcoin",
    unit: "$",
    min: 40000,
    max: 140000,
    segments: [
      { from: 40000, color: "#0bb6ef" },
      { from: 80000, color: "#2bff00" },
      { from: 90000, color: "#fca103" },
      { from: 115000, color: "#ff0000" },
    ],
  },
];

const QUICK_KEY_TILES: TileSpec[] = [
  { slot: "tile.gate_main", name: "Main Gate", domain: "switch", service: "toggle" },
  { slot: "tile.garage_door", name: "Garage Door", domain: "switch", service: "toggle" },
  {
    slot: "tile.entrance_lights",
    name: "Main Entrance Lights",
    domain: "switch",
    service: "toggle",
  },
  { slot: "tile.braai_light", name: "Braai Light", domain: "switch", service: "toggle" },
  { slot: "tile.geyser_main", name: "Main Geyser", domain: "switch", service: "toggle" },
  { slot: "tile.geyser_timer", name: "Geyser Timer", domain: "automation", service: "toggle" },
  { slot: "tile.vintage_lights", name: "Vintage Lights", domain: "switch", service: "toggle" },
  {
    slot: "tile.jacuzzi_down_lights",
    name: "Jacuzzi Down Lights",
    domain: "switch",
    service: "toggle",
  },
  { slot: "tile.patio_lights", name: "Patio Lights", domain: "switch", service: "toggle" },
  { slot: "tile.pool_pump", name: "Pool Pump", domain: "switch", service: "toggle" },
  { slot: "tile.jacuzzi_pump", name: "Jacuzzi Pump", domain: "switch", service: "toggle" },
  { slot: "tile.office_lights", name: "Office Lights", domain: "switch", service: "toggle" },
  { slot: "tile.wall_lights", name: "Wall Lights", domain: "switch", service: "toggle" },
  { slot: "tile.left_blind", name: "Left Blind", domain: "cover", service: "toggle" },
  { slot: "tile.right_blind", name: "Right Blind", domain: "cover", service: "toggle" },
];

// -- Element ----------------------------------------------------------------

export class KioskWagnerWay extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** State binding from the kiosk shell. Tests pass a fake. */
  @property({ attribute: false }) binding: HaStateBinding | null = null;

  /** Slot -> entity_id map. Defaults to the household-wide Wagner Way slots. */
  @property({ attribute: false }) slots: WagnerWaySlots = DEFAULT_WAGNER_WAY_SLOTS;

  @state() private revision: number = 0;

  private removeBindingListener: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.attachToBinding();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.detachFromBinding();
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("binding")) {
      this.detachFromBinding();
      this.attachToBinding();
    }
  }

  /**
   * Visible for tests: the controller that handles optimistic
   * dispatch + reconciliation for tile taps.
   */
  getInteractionController(): TileInteractionController | null {
    return this.interactionController;
  }

  override render(): TemplateResult {
    return html`<section
      class="kiosk-wagner-way"
      data-test-id="kiosk-wagner-way"
      @tile-tap=${this.onTileTap}
    >
      ${this.renderBadges()} ${this.renderHouseInfoRow()} ${this.renderGaugeRow(ENERGY_GAUGES)}
      ${this.renderGaugeRow(POWER_GAUGES)} ${this.renderHeading("Major Appliances")}
      ${this.renderGaugeRow(APPLIANCE_GAUGES)} ${this.renderHeading("Quick Keys")}
      ${this.renderQuickKeys()} ${this.renderFooter()}
    </section>`;
  }

  // -- internal helpers ----------------------------------------------------

  private attachToBinding(): void {
    if (!this.binding) return;
    this.removeBindingListener = this.binding.subscribeAll(() => {
      this.revision += 1;
    });
    this.interactionController = new TileInteractionController({ binding: this.binding });
    this.removeStatusListener = this.interactionController.onStatusChange(() => {
      this.revision += 1;
    });
  }

  private detachFromBinding(): void {
    this.removeBindingListener?.();
    this.removeBindingListener = null;
    this.removeStatusListener?.();
    this.removeStatusListener = null;
    this.interactionController?.detach();
    this.interactionController = null;
  }

  private onTileTap = (ev: Event): void => {
    const detail = (ev as CustomEvent<TileTapDetail>).detail;
    if (!detail || !this.interactionController) return;
    void this.interactionController.dispatch(detail);
  };

  private resolve(slot: string): string | undefined {
    return this.slots[slot];
  }

  private numericState(slot: string): number | null {
    const id = this.resolve(slot);
    if (!id) return null;
    const value = this.binding?.get(id);
    if (!value) return null;
    const parsed = Number(value.state);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private rawState(slot: string): string {
    const id = this.resolve(slot);
    if (!id) return "unavailable";
    return this.binding?.get(id)?.state ?? "unavailable";
  }

  private renderHeading(label: string): TemplateResult {
    return html`<h2 class="kiosk-wagner-way__heading">${label}</h2>`;
  }

  private renderBadges(): TemplateResult {
    return html`<div class="kiosk-wagner-way__badges kiosk-grid kiosk-grid--badges">
      ${BADGES.map((spec) => {
        const id = this.resolve(spec.slot) ?? "";
        return html`<kiosk-badge-entity
          .entityId=${id}
          .name=${spec.name}
          .state=${this.rawState(spec.slot)}
          .unit=${spec.unit ?? ""}
        ></kiosk-badge-entity>`;
      })}
    </div>`;
  }

  private renderHouseInfoRow(): TemplateResult {
    const tempState = this.numericState("sensor.outdoor_temp");
    const humidityState = this.numericState("sensor.outdoor_humidity");
    const weather = this.binding?.get(this.resolve("weather.primary") ?? "");
    const conditions = (weather?.state as string) ?? "";
    return html`<div class="kiosk-wagner-way__row kiosk-wagner-way__row--house-info">
      <kiosk-weather-card
        title="Wagner Way"
        .conditions=${conditions}
        .currentTemp=${tempState}
        .humidity=${humidityState}
      ></kiosk-weather-card>
      <kiosk-energy-flow-card
        .solar=${this.energyNode("Solar", "energy.solar_power", "energy.solar_daily")}
        .grid=${this.energyNode("Grid", "energy.grid_power", "energy.grid_daily")}
        .home=${this.energyNode("Home", "energy.load_power", "energy.load_daily")}
        .battery=${this.energyNodeWithDetail(
          "Battery",
          "energy.battery_power",
          undefined,
          this.batterySocDetail(),
        )}
      ></kiosk-energy-flow-card>
    </div>`;
  }

  private energyNode(label: string, powerSlot: string, dailySlot?: string) {
    const power = this.numericState(powerSlot);
    if (power === null && (!dailySlot || this.numericState(dailySlot) === null)) {
      return null;
    }
    const daily = dailySlot ? this.numericState(dailySlot) : null;
    return {
      label,
      power: power,
      ...(daily !== null ? { daily } : {}),
    };
  }

  private energyNodeWithDetail(
    label: string,
    powerSlot: string,
    dailySlot: string | undefined,
    detail: string | undefined,
  ) {
    const node = this.energyNode(label, powerSlot, dailySlot);
    if (!node) return null;
    return detail ? { ...node, detail } : node;
  }

  private batterySocDetail(): string | undefined {
    const soc = this.numericState("energy.battery_soc");
    return soc !== null ? `${Math.round(soc)}% SOC` : undefined;
  }

  private renderGaugeRow(specs: GaugeSpec[]): TemplateResult {
    const cls = `kiosk-grid kiosk-grid--gauges-${specs.length === 5 ? 5 : specs.length === 2 ? 2 : 4}`;
    return html`<div class=${cls}>
      ${specs.map((spec) => {
        const value = this.numericState(spec.slot);
        return html`<kiosk-gauge-circular
          .value=${value ?? Number.NaN}
          .min=${spec.min}
          .max=${spec.max}
          .unit=${spec.unit}
          .name=${spec.name}
          .segments=${spec.segments}
        ></kiosk-gauge-circular>`;
      })}
    </div>`;
  }

  private renderQuickKeys(): TemplateResult {
    return html`<div class="kiosk-grid kiosk-grid--tiles" data-test-id="kiosk-quick-keys">
      ${QUICK_KEY_TILES.map((spec) => {
        const id = this.resolve(spec.slot) ?? "";
        const state = this.rawState(spec.slot);
        const status = id ? this.interactionController?.status.get(id) : undefined;
        return html`<kiosk-tile-toggle
          .entityId=${id}
          .domain=${spec.domain}
          .service=${spec.service}
          .name=${spec.name}
          .state=${state}
          .icon=${spec.icon ?? ""}
          .pending=${status?.pending ?? false}
          .error=${status?.error ?? false}
          .errorMessage=${status?.errorMessage ?? ""}
        ></kiosk-tile-toggle>`;
      })}
    </div>`;
  }

  private renderFooter(): TemplateResult {
    return html`<div class="kiosk-wagner-way__footer kiosk-grid kiosk-grid--tiles">
      <button
        type="button"
        class="kiosk-tile"
        data-state="placeholder"
        data-test-id="kiosk-vacuums-placeholder"
        disabled
      >
        <span class="kiosk-tile__icon" aria-hidden="true">V</span>
        <span class="kiosk-tile__name">Vacuums (v2)</span>
        <span class="kiosk-tile__state">soon</span>
      </button>
      <button
        type="button"
        class="kiosk-tile"
        data-state="placeholder"
        data-test-id="kiosk-cameras-placeholder"
        disabled
      >
        <span class="kiosk-tile__icon" aria-hidden="true">C</span>
        <span class="kiosk-tile__name">Front Door Cam (v2)</span>
        <span class="kiosk-tile__state">soon</span>
      </button>
    </div>`;
  }
}

if (!customElements.get("kiosk-wagner-way")) {
  customElements.define("kiosk-wagner-way", KioskWagnerWay);
}
