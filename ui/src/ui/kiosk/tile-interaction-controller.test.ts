import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HA_STATE_EVENT,
  HA_SUBSCRIBE_METHOD,
  HA_SERVICE_CALL_METHOD,
  HaStateBinding,
  type GatewayEventFrame,
  type HaGatewayClient,
} from "./ha-state-binding.js";
import { TileInteractionController } from "./tile-interaction-controller.js";

class FakeClient implements HaGatewayClient {
  private listeners = new Set<(evt: GatewayEventFrame) => void>();
  responses = new Map<string, unknown>();
  errors = new Map<string, Error>();
  serviceCallCalls: Array<Record<string, unknown>> = [];

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (method === HA_SERVICE_CALL_METHOD) {
      this.serviceCallCalls.push((params ?? {}) as Record<string, unknown>);
    }
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
    for (const l of this.listeners) l(evt);
  }
}

class ManualScheduler {
  private next = 1;
  private pending = new Map<number, { fn: () => void; due: number }>();
  private now = 0;

  setTimeoutFn = (fn: () => void, ms: number): unknown => {
    const handle = this.next++;
    this.pending.set(handle, { fn, due: this.now + Math.max(0, ms) });
    return handle;
  };

  clearTimeoutFn = (h: unknown): void => {
    if (typeof h === "number") this.pending.delete(h);
  };

  advance(ms: number): void {
    this.now += ms;
    while (true) {
      const due = Array.from(this.pending.entries())
        .filter(([, t]) => t.due <= this.now)
        .sort((a, b) => a[1].due - b[1].due);
      if (due.length === 0) break;
      const [handle, { fn }] = due[0];
      this.pending.delete(handle);
      fn();
    }
  }
}

async function buildHarness(): Promise<{
  client: FakeClient;
  binding: HaStateBinding;
  scheduler: ManualScheduler;
  controller: TileInteractionController;
}> {
  const client = new FakeClient();
  client.responses.set(HA_SUBSCRIBE_METHOD, { snapshot: [] });
  const binding = new HaStateBinding(client);
  await binding.attach();

  const scheduler = new ManualScheduler();
  const controller = new TileInteractionController({
    binding,
    setTimeoutFn: scheduler.setTimeoutFn,
    clearTimeoutFn: scheduler.clearTimeoutFn,
    reconcileTimeoutMs: 3000,
    errorFlashMs: 1500,
  });

  return { client, binding, scheduler, controller };
}

function emitState(client: FakeClient, entity_id: string, state: string): void {
  client.emit({
    type: "event",
    event: HA_STATE_EVENT,
    payload: {
      entity_id,
      prev: null,
      next: { entity_id, state, attributes: {} },
    },
  });
}

describe("TileInteractionController", () => {
  beforeEach(() => {
    // ensure clean
  });
  afterEach(() => {
    // nothing global
  });

  it("happy path: dispatch sets pending, state echo clears it", async () => {
    const { client, controller } = await buildHarness();
    client.responses.set(HA_SERVICE_CALL_METHOD, { dispatched: true });

    const onChange = vi.fn();
    controller.onStatusChange(onChange);

    const dispatched = controller.dispatch({
      entityId: "switch.gate_main",
      domain: "switch",
      service: "toggle",
    });
    // pending is set synchronously before the gateway promise resolves
    expect(controller.status.get("switch.gate_main")?.pending).toBe(true);

    await dispatched;
    expect(client.serviceCallCalls).toEqual([
      { domain: "switch", service: "toggle", target: "switch.gate_main" },
    ]);
    expect(controller.status.get("switch.gate_main")?.pending).toBe(true);

    // State echo arrives -- pending clears and the entry leaves the
    // status map (no pending, no error -> nothing to display).
    emitState(client, "switch.gate_main", "on");
    expect(controller.status.get("switch.gate_main")).toBeUndefined();
    expect(onChange).toHaveBeenCalled();
  });

  it("forwards optional serviceData to the gateway request", async () => {
    const { client, controller } = await buildHarness();
    client.responses.set(HA_SERVICE_CALL_METHOD, { dispatched: true });

    await controller.dispatch({
      entityId: "cover.left_blind",
      domain: "cover",
      service: "set_cover_position",
      serviceData: { position: 50 },
    });

    expect(client.serviceCallCalls).toEqual([
      {
        domain: "cover",
        service: "set_cover_position",
        target: "cover.left_blind",
        serviceData: { position: 50 },
      },
    ]);
  });

  it("reconcile timeout: no echo within reconcileTimeoutMs reverts pending and flashes error", async () => {
    const { client, scheduler, controller } = await buildHarness();
    client.responses.set(HA_SERVICE_CALL_METHOD, { dispatched: true });

    await controller.dispatch({
      entityId: "switch.geyser",
      domain: "switch",
      service: "toggle",
    });
    expect(controller.status.get("switch.geyser")?.pending).toBe(true);

    scheduler.advance(3000);
    const status = controller.status.get("switch.geyser")!;
    expect(status.pending).toBe(false);
    expect(status.error).toBe(true);
    expect(status.errorMessage).toMatch(/timed.?out|timeout/i);

    // Error flashes briefly then clears.
    scheduler.advance(1500);
    // After the error-flash window clears, the controller drops the entry
    // from its status map (no pending, no error -> nothing to display).
    expect(controller.status.get("switch.geyser")).toBeUndefined();
  });

  it("service-denied: gateway rejection clears pending, sets error with message", async () => {
    const { client, scheduler, controller } = await buildHarness();
    client.errors.set(HA_SERVICE_CALL_METHOD, new Error("service-denied"));

    await controller.dispatch({
      entityId: "lock.front_door",
      domain: "lock",
      service: "unlock",
    });

    const status = controller.status.get("lock.front_door")!;
    expect(status.pending).toBe(false);
    expect(status.error).toBe(true);
    expect(status.errorMessage).toMatch(/service-denied/);

    scheduler.advance(1500);
    // After the error-flash window, the controller drops the entry.
    expect(controller.status.get("lock.front_door")).toBeUndefined();
  });

  it("ha_call_failed: ws-client failure surfaced as error", async () => {
    const { client, controller } = await buildHarness();
    client.errors.set(HA_SERVICE_CALL_METHOD, new Error("not subscribed"));

    await controller.dispatch({
      entityId: "switch.gate_main",
      domain: "switch",
      service: "toggle",
    });

    const status = controller.status.get("switch.gate_main")!;
    expect(status.error).toBe(true);
    expect(status.errorMessage).toMatch(/not subscribed/);
  });

  it("rapid taps on the same entity do not double-dispatch while one is in flight", async () => {
    const { client, controller } = await buildHarness();
    let resolveCall: (v: unknown) => void = () => undefined;
    client.responses.set(HA_SERVICE_CALL_METHOD, { dispatched: true });
    // Force the gateway to wait until we resolve manually -- replace request
    // with one that never resolves until we tell it to.
    const slowResponse = new Promise<unknown>((resolve) => {
      resolveCall = resolve;
    });
    const originalRequest = client.request.bind(client);
    client.request = ((method: string, params: unknown) => {
      if (method === HA_SERVICE_CALL_METHOD) {
        // Track the call but block until we resolve.
        client.serviceCallCalls.push((params ?? {}) as Record<string, unknown>);
        return slowResponse;
      }
      return originalRequest(method, params);
    }) as typeof client.request;

    const first = controller.dispatch({
      entityId: "switch.gate_main",
      domain: "switch",
      service: "toggle",
    });
    // A second tap while the first is pending -- should be ignored.
    const second = controller.dispatch({
      entityId: "switch.gate_main",
      domain: "switch",
      service: "toggle",
    });

    // Only one service call so far.
    expect(client.serviceCallCalls).toHaveLength(1);

    // Let the first one settle.
    resolveCall({ dispatched: true });
    await first;
    await second;

    expect(client.serviceCallCalls).toHaveLength(1);
  });

  it("does not crash if a state echo arrives for an entity that was never dispatched", async () => {
    const { client, controller } = await buildHarness();
    expect(() => emitState(client, "switch.unrelated", "on")).not.toThrow();
    expect(controller.status.get("switch.unrelated")).toBeUndefined();
  });

  it("detach unsubscribes so further state echos do not mutate status", async () => {
    const { client, controller, scheduler } = await buildHarness();
    client.responses.set(HA_SERVICE_CALL_METHOD, { dispatched: true });

    await controller.dispatch({
      entityId: "switch.gate_main",
      domain: "switch",
      service: "toggle",
    });
    expect(controller.status.get("switch.gate_main")?.pending).toBe(true);

    controller.detach();

    // Even though an echo arrives, controller is detached -- status should
    // not flip back. (Pending stays whatever it was at detach.)
    emitState(client, "switch.gate_main", "on");
    expect(controller.status.get("switch.gate_main")?.pending).toBe(true);

    // And no spurious timeout fires after detach.
    scheduler.advance(3000);
  });
});
