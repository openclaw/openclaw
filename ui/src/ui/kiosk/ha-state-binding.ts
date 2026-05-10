/**
 * Browser-side reactive cache for Home Assistant entity state, plus
 * the gateway request seam for service calls.
 *
 * Lifecycle:
 *   1. caller constructs HaStateBinding(client)
 *   2. await binding.attach() -- calls `home-assistant.subscribe`, seeds
 *      the cache from the returned snapshot, transitions to `live`
 *   3. for every `plugin.home-assistant.state` push, the binding updates
 *      its cache and notifies per-entity / subscribeAll listeners
 *   4. caller invokes binding.callService({...}) on tile taps
 *   5. binding.detach() unsubscribes the gateway listener
 *
 * This is the browser counterpart to extensions/home-assistant's
 * gateway-bridge. The wire-protocol constants are duplicated here on
 * purpose -- the UI does not import from the extension package, the
 * boundary keeps them as independent contracts that must agree on the
 * three string literals below. A test in each package locks the
 * literals so drift fails fast.
 */

export const HA_STATE_EVENT = "plugin.home-assistant.state";
export const HA_SUBSCRIBE_METHOD = "home-assistant.subscribe";
export const HA_SERVICE_CALL_METHOD = "home-assistant.serviceCall";

// -- gateway client contract (subset of GatewayBrowserClient we depend on) --

export type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
};

export type GatewayEventListener = (evt: GatewayEventFrame) => void;

export interface HaGatewayClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  addEventListener(listener: GatewayEventListener): () => void;
}

// -- entity-state types ----------------------------------------------------

export type HaEntityState = {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
};

export type HaStateChange = {
  entity_id: string;
  prev: HaEntityState | null;
  next: HaEntityState | null;
};

export type HaConnectionState = "idle" | "attaching" | "live" | "degraded" | "detached";

export type HaConnectionStateListener = (state: HaConnectionState) => void;
export type HaEntityListener = (state: HaEntityState | null) => void;
export type HaDiffListener = (change: HaStateChange) => void;
export type Unsubscribe = () => void;

// -- service-call payloads -------------------------------------------------

export type HaServiceCallArgs = {
  domain: string;
  service: string;
  target: string;
  serviceData?: Record<string, unknown>;
};

export type HaServiceCallResult = { dispatched: true };

// -- implementation --------------------------------------------------------

type SubscribeResponse = {
  snapshot?: Array<{ entity_id: string; state: HaEntityState }>;
};

export class HaStateBinding {
  connectionState: HaConnectionState = "idle";

  private readonly client: HaGatewayClient;
  private cache = new Map<string, HaEntityState>();
  private perEntityListeners = new Map<string, Set<HaEntityListener>>();
  private allListeners = new Set<HaDiffListener>();
  private connectionListeners = new Set<HaConnectionStateListener>();
  private removeGatewayListener: Unsubscribe | null = null;

  constructor(client: HaGatewayClient) {
    this.client = client;
  }

  async attach(): Promise<void> {
    if (this.connectionState !== "idle" && this.connectionState !== "degraded") {
      return;
    }
    this.transitionConnection("attaching");
    this.removeGatewayListener?.();
    this.removeGatewayListener = this.client.addEventListener((evt) => this.onEvent(evt));
    try {
      const response = await this.client.request<SubscribeResponse>(HA_SUBSCRIBE_METHOD);
      const snapshot = Array.isArray(response?.snapshot) ? response!.snapshot : [];
      this.cache.clear();
      for (const entry of snapshot) {
        if (entry && entry.entity_id && entry.state) {
          this.cache.set(entry.entity_id, entry.state);
        }
      }
      this.transitionConnection("live");
    } catch (cause) {
      this.transitionConnection("degraded");
      // eslint-disable-next-line no-console
      console.warn("[ha-state-binding] subscribe failed", cause);
    }
  }

  detach(): void {
    if (this.removeGatewayListener) {
      this.removeGatewayListener();
      this.removeGatewayListener = null;
    }
    this.transitionConnection("detached");
  }

  get(entity_id: string): HaEntityState | undefined {
    return this.cache.get(entity_id);
  }

  subscribe(entity_id: string, listener: HaEntityListener): Unsubscribe {
    let bucket = this.perEntityListeners.get(entity_id);
    if (!bucket) {
      bucket = new Set();
      this.perEntityListeners.set(entity_id, bucket);
    }
    bucket.add(listener);
    return () => {
      const b = this.perEntityListeners.get(entity_id);
      if (!b) return;
      b.delete(listener);
      if (b.size === 0) {
        this.perEntityListeners.delete(entity_id);
      }
    };
  }

  subscribeAll(listener: HaDiffListener): Unsubscribe {
    this.allListeners.add(listener);
    return () => {
      this.allListeners.delete(listener);
    };
  }

  onConnectionStateChange(listener: HaConnectionStateListener): Unsubscribe {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  async callService(args: HaServiceCallArgs): Promise<HaServiceCallResult> {
    const params: Record<string, unknown> = {
      domain: args.domain,
      service: args.service,
      target: args.target,
    };
    if (args.serviceData) {
      params.serviceData = args.serviceData;
    }
    return this.client.request<HaServiceCallResult>(HA_SERVICE_CALL_METHOD, params);
  }

  // -- internals -----------------------------------------------------------

  private onEvent(evt: GatewayEventFrame): void {
    if (evt.event !== HA_STATE_EVENT) {
      return;
    }
    const change = parseStateChange(evt.payload);
    if (!change) {
      return;
    }
    if (change.next) {
      this.cache.set(change.entity_id, change.next);
    } else {
      this.cache.delete(change.entity_id);
    }
    this.notify(change);
  }

  private notify(change: HaStateChange): void {
    const perEntity = this.perEntityListeners.get(change.entity_id);
    if (perEntity) {
      for (const listener of perEntity) {
        try {
          listener(change.next);
        } catch (cause) {
          // eslint-disable-next-line no-console
          console.warn("[ha-state-binding] entity listener threw", cause);
        }
      }
    }
    for (const listener of this.allListeners) {
      try {
        listener(change);
      } catch (cause) {
        // eslint-disable-next-line no-console
        console.warn("[ha-state-binding] all-listener threw", cause);
      }
    }
  }

  private transitionConnection(next: HaConnectionState): void {
    if (this.connectionState === next) return;
    this.connectionState = next;
    for (const listener of this.connectionListeners) {
      try {
        listener(next);
      } catch (cause) {
        // eslint-disable-next-line no-console
        console.warn("[ha-state-binding] connection listener threw", cause);
      }
    }
  }
}

function parseStateChange(payload: unknown): HaStateChange | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.entity_id !== "string") {
    return null;
  }
  return {
    entity_id: p.entity_id,
    prev: parseEntityState(p.prev),
    next: parseEntityState(p.next),
  };
}

function parseEntityState(value: unknown): HaEntityState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.entity_id !== "string" || typeof v.state !== "string") {
    return null;
  }
  return {
    entity_id: v.entity_id,
    state: v.state,
    attributes: (v.attributes as Record<string, unknown>) ?? {},
    ...(typeof v.last_changed === "string" ? { last_changed: v.last_changed } : {}),
    ...(typeof v.last_updated === "string" ? { last_updated: v.last_updated } : {}),
  };
}
