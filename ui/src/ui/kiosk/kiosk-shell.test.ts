import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "./kiosk-shell.js";
import {
  HA_STATE_EVENT,
  HA_SUBSCRIBE_METHOD,
  type GatewayEventFrame,
  type HaGatewayClient,
} from "./ha-state-binding.js";
import type { KioskShell } from "./kiosk-shell.js";

class FakeClient implements HaGatewayClient {
  private listeners = new Set<(evt: GatewayEventFrame) => void>();
  responses = new Map<string, unknown>();
  errors = new Map<string, Error>();

  async request<T = unknown>(method: string, _params?: unknown): Promise<T> {
    if (this.errors.has(method)) {
      throw this.errors.get(method)!;
    }
    return (this.responses.get(method) as T) ?? (undefined as T);
  }

  addEventListener(listener: (evt: GatewayEventFrame) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(evt: GatewayEventFrame): void {
    for (const l of this.listeners) {
      l(evt);
    }
  }
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function mountShell(client: HaGatewayClient | null): Promise<KioskShell> {
  const el = document.createElement("kiosk-shell") as KioskShell;
  el.client = client;
  document.body.appendChild(el);
  await el.updateComplete;
  await flush();
  await el.updateComplete;
  return el;
}

describe("kiosk-shell", () => {
  beforeEach(() => {
    document.documentElement.classList.remove("kiosk-mode");
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
    document.documentElement.classList.remove("kiosk-mode");
  });

  it("adds kiosk-mode body class on mount and removes it on unmount", async () => {
    const client = new FakeClient();
    client.responses.set(HA_SUBSCRIBE_METHOD, { snapshot: [] });
    const el = await mountShell(client);

    expect(document.documentElement.classList.contains("kiosk-mode")).toBe(true);

    el.remove();
    expect(document.documentElement.classList.contains("kiosk-mode")).toBe(false);
  });

  it("renders the connection pill and reflects connection state transitions", async () => {
    const client = new FakeClient();
    client.responses.set(HA_SUBSCRIBE_METHOD, { snapshot: [] });
    const el = await mountShell(client);

    const pill = el.querySelector('[data-test-id="kiosk-connection-pill"]');
    expect(pill).toBeTruthy();
    expect(pill?.textContent?.trim()).toBe("live");
  });

  it("shows reconnecting when subscribe rejects", async () => {
    const client = new FakeClient();
    client.errors.set(HA_SUBSCRIBE_METHOD, new Error("not connected"));
    const el = await mountShell(client);

    const pill = el.querySelector('[data-test-id="kiosk-connection-pill"]');
    expect(pill?.textContent?.trim()).toBe("reconnecting");
  });

  it("renders the placeholder until the client is provided", async () => {
    const el = await mountShell(null);

    expect(el.textContent).toMatch(/Connecting to Home Assistant/i);
  });

  it("exposes the binding so child views can subscribe", async () => {
    const client = new FakeClient();
    client.responses.set(HA_SUBSCRIBE_METHOD, {
      snapshot: [
        {
          entity_id: "sensor.battery_soc",
          state: { entity_id: "sensor.battery_soc", state: "97", attributes: {} },
        },
      ],
    });
    const el = await mountShell(client);

    const binding = el.getBinding();
    expect(binding).toBeTruthy();
    expect(binding?.get("sensor.battery_soc")?.state).toBe("97");

    // After mount, a state-change push should update the binding cache.
    client.emit({
      type: "event",
      event: HA_STATE_EVENT,
      payload: {
        entity_id: "sensor.battery_soc",
        prev: { entity_id: "sensor.battery_soc", state: "97", attributes: {} },
        next: { entity_id: "sensor.battery_soc", state: "60", attributes: {} },
      },
    });
    expect(binding?.get("sensor.battery_soc")?.state).toBe("60");
  });
});
