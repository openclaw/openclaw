import { describe, expect, it, vi } from "vitest";
import {
  HaStateBinding,
  HA_STATE_EVENT,
  HA_SUBSCRIBE_METHOD,
  HA_SERVICE_CALL_METHOD,
  type HaGatewayClient,
  type HaConnectionState,
} from "./ha-state-binding.js";

type GatewayEventFrame = { type: "event"; event: string; payload?: unknown };

class FakeGatewayClient implements HaGatewayClient {
  requestCalls: Array<{ method: string; params?: unknown }> = [];
  shouldRequestThrow: Error | null = null;
  responses: Map<string, unknown> = new Map();
  errorResponses: Map<string, Error> = new Map();
  private eventListeners = new Set<(evt: GatewayEventFrame) => void>();

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.requestCalls.push({ method, params });
    if (this.shouldRequestThrow) {
      const err = this.shouldRequestThrow;
      this.shouldRequestThrow = null;
      throw err;
    }
    if (this.errorResponses.has(method)) {
      throw this.errorResponses.get(method)!;
    }
    return (this.responses.get(method) as T) ?? (undefined as T);
  }

  addEventListener(listener: (evt: GatewayEventFrame) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  emit(evt: GatewayEventFrame): void {
    for (const listener of this.eventListeners) {
      listener(evt);
    }
  }
}

const SAMPLE_SNAPSHOT = {
  snapshot: [
    {
      entity_id: "sensor.battery_soc",
      state: { entity_id: "sensor.battery_soc", state: "97", attributes: {} },
    },
    {
      entity_id: "switch.gate_main",
      state: { entity_id: "switch.gate_main", state: "off", attributes: {} },
    },
  ],
};

describe("HaStateBinding", () => {
  describe("attach + subscribe", () => {
    it("calls home-assistant.subscribe and seeds the cache from the snapshot", async () => {
      const client = new FakeGatewayClient();
      client.responses.set(HA_SUBSCRIBE_METHOD, SAMPLE_SNAPSHOT);
      const binding = new HaStateBinding(client);

      await binding.attach();

      expect(client.requestCalls.map((c) => c.method)).toContain(HA_SUBSCRIBE_METHOD);
      expect(binding.get("sensor.battery_soc")).toEqual({
        entity_id: "sensor.battery_soc",
        state: "97",
        attributes: {},
      });
      expect(binding.get("switch.gate_main")).toEqual({
        entity_id: "switch.gate_main",
        state: "off",
        attributes: {},
      });
    });

    it("transitions live -> degraded if the subscribe request fails", async () => {
      const client = new FakeGatewayClient();
      client.errorResponses.set(HA_SUBSCRIBE_METHOD, new Error("not connected"));
      const binding = new HaStateBinding(client);

      await binding.attach();

      expect(binding.connectionState).toBe("degraded");
    });

    it("emits state changes after attach", async () => {
      const client = new FakeGatewayClient();
      client.responses.set(HA_SUBSCRIBE_METHOD, SAMPLE_SNAPSHOT);
      const binding = new HaStateBinding(client);
      await binding.attach();

      const seen: string[] = [];
      binding.subscribe("sensor.battery_soc", (state) => seen.push(state?.state ?? "(none)"));

      client.emit({
        type: "event",
        event: HA_STATE_EVENT,
        payload: {
          entity_id: "sensor.battery_soc",
          prev: { entity_id: "sensor.battery_soc", state: "97", attributes: {} },
          next: { entity_id: "sensor.battery_soc", state: "60", attributes: {} },
        },
      });

      expect(seen).toEqual(["60"]);
      expect(binding.get("sensor.battery_soc")?.state).toBe("60");
    });

    it("ignores events for unrelated topics", async () => {
      const client = new FakeGatewayClient();
      client.responses.set(HA_SUBSCRIBE_METHOD, SAMPLE_SNAPSHOT);
      const binding = new HaStateBinding(client);
      await binding.attach();

      const seen: unknown[] = [];
      binding.subscribe("sensor.battery_soc", (state) => seen.push(state));

      client.emit({
        type: "event",
        event: "something.else",
        payload: { entity_id: "sensor.battery_soc", next: null },
      });

      expect(seen).toHaveLength(0);
    });

    it("removes the entity from the cache when next is null", async () => {
      const client = new FakeGatewayClient();
      client.responses.set(HA_SUBSCRIBE_METHOD, SAMPLE_SNAPSHOT);
      const binding = new HaStateBinding(client);
      await binding.attach();

      client.emit({
        type: "event",
        event: HA_STATE_EVENT,
        payload: {
          entity_id: "sensor.battery_soc",
          prev: { entity_id: "sensor.battery_soc", state: "97", attributes: {} },
          next: null,
        },
      });

      expect(binding.get("sensor.battery_soc")).toBeUndefined();
    });
  });

  describe("subscribeAll", () => {
    it("delivers diffs for every entity to subscribeAll listeners", async () => {
      const client = new FakeGatewayClient();
      client.responses.set(HA_SUBSCRIBE_METHOD, { snapshot: [] });
      const binding = new HaStateBinding(client);
      await binding.attach();

      const all = vi.fn();
      binding.subscribeAll(all);

      client.emit({
        type: "event",
        event: HA_STATE_EVENT,
        payload: {
          entity_id: "switch.gate_main",
          prev: null,
          next: { entity_id: "switch.gate_main", state: "on", attributes: {} },
        },
      });

      expect(all).toHaveBeenCalledOnce();
    });
  });

  describe("connectionState transitions", () => {
    it("starts in idle, moves to live after attach succeeds", async () => {
      const client = new FakeGatewayClient();
      client.responses.set(HA_SUBSCRIBE_METHOD, SAMPLE_SNAPSHOT);
      const binding = new HaStateBinding(client);
      const seen: HaConnectionState[] = [];
      binding.onConnectionStateChange((s) => seen.push(s));

      expect(binding.connectionState).toBe("idle");

      await binding.attach();

      expect(binding.connectionState).toBe("live");
      expect(seen).toContain("attaching");
      expect(seen).toContain("live");
    });
  });

  describe("callService", () => {
    it("forwards the request to the gateway with the right method name", async () => {
      const client = new FakeGatewayClient();
      client.responses.set(HA_SUBSCRIBE_METHOD, SAMPLE_SNAPSHOT);
      client.responses.set(HA_SERVICE_CALL_METHOD, { dispatched: true });
      const binding = new HaStateBinding(client);
      await binding.attach();

      const result = await binding.callService({
        domain: "switch",
        service: "toggle",
        target: "switch.gate_main",
      });

      expect(client.requestCalls).toEqual(
        expect.arrayContaining([
          {
            method: HA_SERVICE_CALL_METHOD,
            params: {
              domain: "switch",
              service: "toggle",
              target: "switch.gate_main",
            },
          },
        ]),
      );
      expect(result).toEqual({ dispatched: true });
    });

    it("propagates ws gateway request rejection so the caller can show a flash", async () => {
      const client = new FakeGatewayClient();
      client.responses.set(HA_SUBSCRIBE_METHOD, SAMPLE_SNAPSHOT);
      client.errorResponses.set(HA_SERVICE_CALL_METHOD, new Error("service-denied"));
      const binding = new HaStateBinding(client);
      await binding.attach();

      await expect(
        binding.callService({
          domain: "lock",
          service: "unlock",
          target: "lock.front_door",
        }),
      ).rejects.toThrow(/service-denied/);
    });
  });

  describe("detach", () => {
    it("stops emitting after detach", async () => {
      const client = new FakeGatewayClient();
      client.responses.set(HA_SUBSCRIBE_METHOD, SAMPLE_SNAPSHOT);
      const binding = new HaStateBinding(client);
      await binding.attach();

      const seen: unknown[] = [];
      binding.subscribeAll((diff) => seen.push(diff));

      binding.detach();

      client.emit({
        type: "event",
        event: HA_STATE_EVENT,
        payload: {
          entity_id: "sensor.battery_soc",
          prev: null,
          next: { entity_id: "sensor.battery_soc", state: "1", attributes: {} },
        },
      });

      expect(seen).toHaveLength(0);
    });
  });
});
