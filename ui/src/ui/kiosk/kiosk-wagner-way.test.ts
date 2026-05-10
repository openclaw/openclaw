import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "./kiosk-wagner-way.js";
import {
  HA_STATE_EVENT,
  HA_SUBSCRIBE_METHOD,
  HaStateBinding,
  type GatewayEventFrame,
  type HaGatewayClient,
} from "./ha-state-binding.js";
import { DEFAULT_WAGNER_WAY_SLOTS, type KioskWagnerWay } from "./kiosk-wagner-way.js";

class FakeClient implements HaGatewayClient {
  private listeners = new Set<(evt: GatewayEventFrame) => void>();
  responses = new Map<string, unknown>();

  async request<T = unknown>(method: string, _params?: unknown): Promise<T> {
    return (this.responses.get(method) as T) ?? (undefined as T);
  }

  addEventListener(listener: (evt: GatewayEventFrame) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(evt: GatewayEventFrame): void {
    for (const l of this.listeners) l(evt);
  }
}

function makeStateEvent(entity_id: string, state: string): GatewayEventFrame {
  return {
    type: "event",
    event: HA_STATE_EVENT,
    payload: {
      entity_id,
      prev: null,
      next: { entity_id, state, attributes: {} },
    },
  };
}

async function flush(times = 2): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

async function mountView(): Promise<{
  el: KioskWagnerWay;
  client: FakeClient;
  binding: HaStateBinding;
}> {
  const client = new FakeClient();
  client.responses.set(HA_SUBSCRIBE_METHOD, {
    snapshot: [
      {
        entity_id: DEFAULT_WAGNER_WAY_SLOTS["energy.battery_soc"],
        state: {
          entity_id: DEFAULT_WAGNER_WAY_SLOTS["energy.battery_soc"],
          state: "97",
          attributes: {},
        },
      },
      {
        entity_id: DEFAULT_WAGNER_WAY_SLOTS["tile.gate_main"],
        state: {
          entity_id: DEFAULT_WAGNER_WAY_SLOTS["tile.gate_main"],
          state: "off",
          attributes: {},
        },
      },
    ],
  });
  const binding = new HaStateBinding(client);
  await binding.attach();

  const el = document.createElement("kiosk-wagner-way") as KioskWagnerWay;
  el.binding = binding;
  document.body.appendChild(el);
  await el.updateComplete;
  await flush();
  await el.updateComplete;

  return { el, client, binding };
}

describe("kiosk-wagner-way", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders all 7 sections", async () => {
    const { el } = await mountView();

    expect(el.querySelector('[data-test-id="kiosk-wagner-way"]')).toBeTruthy();
    expect(el.querySelectorAll(".kiosk-wagner-way__badges").length).toBe(1);
    expect(el.querySelector("kiosk-weather-card")).toBeTruthy();
    expect(el.querySelector("kiosk-energy-flow-card")).toBeTruthy();
    expect(el.querySelectorAll("kiosk-gauge-circular").length).toBeGreaterThanOrEqual(9);
    expect(el.querySelector('[data-test-id="kiosk-quick-keys"]')).toBeTruthy();
    expect(el.querySelector('[data-test-id="kiosk-vacuums-placeholder"]')).toBeTruthy();
    expect(el.querySelector('[data-test-id="kiosk-cameras-placeholder"]')).toBeTruthy();
  });

  it("renders all Quick Keys tiles from the default slot map", async () => {
    const { el } = await mountView();
    const tiles = el.querySelectorAll("kiosk-tile-toggle");
    // 15 tiles in the v1 Quick Keys grid (matches DEFAULT_WAGNER_WAY_SLOTS).
    expect(tiles.length).toBe(15);
  });

  it("re-renders when a state-change event arrives for an allow-listed entity", async () => {
    const { el, client } = await mountView();

    // Initial battery_soc value is 97 from the snapshot.
    const batteryGauge = Array.from(el.querySelectorAll("kiosk-gauge-circular")).find(
      (g) => (g as HTMLElement & { name?: string }).name === "Battery SOC",
    );
    expect(batteryGauge).toBeTruthy();
    const beforeRevision = (el as unknown as { revision: number }).revision;

    client.emit(makeStateEvent(DEFAULT_WAGNER_WAY_SLOTS["energy.battery_soc"], "60"));
    await flush();
    await el.updateComplete;

    expect((el as unknown as { revision: number }).revision).toBe(beforeRevision + 1);
  });

  it("renders n/a for entities that have no cached state yet", async () => {
    const { el } = await mountView();

    // The bourbon alarm slot has no snapshot entry; its badge should show n/a.
    const badges = Array.from(el.querySelectorAll("kiosk-badge-entity"));
    const bourbon = badges.find(
      (b) => (b as HTMLElement & { name?: string }).name === "Bourbon Alarm",
    );
    expect(bourbon?.textContent).toContain("n/a");
  });

  it("propagates tile-tap events from a child tile up the tree", async () => {
    const { el } = await mountView();
    const seen: Array<unknown> = [];
    el.addEventListener("tile-tap", (ev) => seen.push((ev as CustomEvent).detail));

    const tiles = el.querySelectorAll("kiosk-tile-toggle");
    const gateTile = Array.from(tiles).find(
      (t) => (t as HTMLElement & { name?: string }).name === "Main Gate",
    );
    expect(gateTile).toBeTruthy();
    gateTile?.querySelector("button")?.click();

    expect(seen).toEqual([
      {
        entityId: DEFAULT_WAGNER_WAY_SLOTS["tile.gate_main"],
        domain: "switch",
        service: "toggle",
      },
    ]);
  });

  it("integration: tile tap dispatches via the controller and reconciles on state echo", async () => {
    const { el, client } = await mountView();
    // Block the gateway service-call promise until we explicitly resolve.
    let resolveCall: (v: unknown) => void = () => undefined;
    const slowCall = new Promise<unknown>((resolve) => {
      resolveCall = resolve;
    });
    const originalRequest = client.request.bind(client);
    client.request = ((method: string, params: unknown) => {
      if (method === "home-assistant.serviceCall") {
        return slowCall;
      }
      return originalRequest(method, params);
    }) as typeof client.request;

    const controller = el.getInteractionController();
    expect(controller).toBeTruthy();

    // Tap the Main Gate tile.
    const tiles = el.querySelectorAll("kiosk-tile-toggle");
    const gateTile = Array.from(tiles).find(
      (t) => (t as HTMLElement & { name?: string }).name === "Main Gate",
    );
    expect(gateTile).toBeTruthy();
    gateTile!.querySelector("button")!.click();

    // Status reflects pending while the gateway call is in flight.
    const gateEntity = DEFAULT_WAGNER_WAY_SLOTS["tile.gate_main"];
    expect(controller!.status.get(gateEntity)?.pending).toBe(true);

    // HA echoes the new state. Controller reconciles, status clears.
    client.emit(makeStateEvent(gateEntity, "on"));
    expect(controller!.status.get(gateEntity)).toBeUndefined();

    // Resolve the slow gateway promise so vitest doesn't leave it open.
    resolveCall({ dispatched: true });
    await flush(2);
  });

  it("renders disabled placeholders for Vacuums and Front Door Cam", async () => {
    const { el } = await mountView();

    const vacuums = el.querySelector(
      '[data-test-id="kiosk-vacuums-placeholder"]',
    ) as HTMLButtonElement | null;
    const cameras = el.querySelector(
      '[data-test-id="kiosk-cameras-placeholder"]',
    ) as HTMLButtonElement | null;

    expect(vacuums?.disabled).toBe(true);
    expect(cameras?.disabled).toBe(true);
    expect(vacuums?.textContent).toContain("v2");
    expect(cameras?.textContent).toContain("v2");
  });
});
