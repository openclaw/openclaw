/**
 * Optimistic tile-tap dispatch + reconciliation controller.
 *
 * Tap arrives -> set pending=true -> dispatch via binding.callService ->
 * await echo (HA state_changed event) within reconcileTimeoutMs ->
 * clear pending. On rejection or timeout, flip to error state for
 * errorFlashMs then clear.
 *
 * Status map drives the tile primitives' data-pending / data-error
 * attributes. The wagner-way view subscribes to onStatusChange and
 * re-renders on every status flip.
 *
 * Hardening choices in v1:
 *   - per-entity in-flight guard: rapid double-taps while a call is
 *     pending are dropped. The reconciliation echo is the next
 *     possible event for that entity, not a queued second call.
 *   - timer injection: tests use a manual scheduler; production uses
 *     setTimeout/clearTimeout from globalThis.
 *   - failure messages: the gateway error message becomes the tile's
 *     errorMessage so the operator sees what HA / the bridge returned
 *     ("service-denied", "entity-denied", "ha_call_failed", etc).
 */

import type { HaStateBinding, HaStateChange } from "./ha-state-binding.js";

export type TileStatus = {
  pending: boolean;
  error: boolean;
  errorMessage: string;
};

const EMPTY_STATUS: TileStatus = { pending: false, error: false, errorMessage: "" };

/**
 * Mirrors the TileTapDetail shape emitted by `tile-toggle`. The controller
 * translates `entityId` to the wire-protocol `target` field on its way
 * through the binding.
 */
export type TileTapDispatch = {
  entityId: string;
  domain: string;
  service: string;
  serviceData?: Record<string, unknown>;
};

export type TileInteractionOptions = {
  binding: HaStateBinding;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  reconcileTimeoutMs?: number;
  errorFlashMs?: number;
};

export type StatusChangeListener = () => void;
export type Unsubscribe = () => void;

const DEFAULT_RECONCILE_TIMEOUT_MS = 3000;
const DEFAULT_ERROR_FLASH_MS = 1500;

type InFlight = {
  entityId: string;
  reconcileHandle: unknown;
};

export class TileInteractionController {
  private readonly binding: HaStateBinding;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly reconcileTimeoutMs: number;
  private readonly errorFlashMs: number;

  private statuses = new Map<string, TileStatus>();
  private inflight = new Map<string, InFlight>();
  private errorFlashHandles = new Map<string, unknown>();
  private listeners = new Set<StatusChangeListener>();
  private removeBindingListener: Unsubscribe | null = null;
  private detached = false;

  /** Read-only view of per-entity tile statuses. */
  get status(): ReadonlyMap<string, TileStatus> {
    return this.statuses;
  }

  constructor(options: TileInteractionOptions) {
    this.binding = options.binding;
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn =
      options.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.reconcileTimeoutMs = options.reconcileTimeoutMs ?? DEFAULT_RECONCILE_TIMEOUT_MS;
    this.errorFlashMs = options.errorFlashMs ?? DEFAULT_ERROR_FLASH_MS;

    this.removeBindingListener = this.binding.subscribeAll((change) => this.onStateChange(change));
  }

  detach(): void {
    this.detached = true;
    this.removeBindingListener?.();
    this.removeBindingListener = null;
    for (const flight of this.inflight.values()) {
      this.clearTimeoutFn(flight.reconcileHandle);
    }
    this.inflight.clear();
    for (const handle of this.errorFlashHandles.values()) {
      this.clearTimeoutFn(handle);
    }
    this.errorFlashHandles.clear();
  }

  onStatusChange(listener: StatusChangeListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async dispatch(args: TileTapDispatch): Promise<void> {
    if (this.detached) return;
    if (this.inflight.has(args.entityId)) {
      // Already in flight -- drop duplicate tap. The reconciliation echo
      // for the original tap is the right next event.
      return;
    }

    this.setStatus(args.entityId, { pending: true, error: false, errorMessage: "" });

    const reconcileHandle = this.setTimeoutFn(() => {
      this.onReconcileTimeout(args.entityId);
    }, this.reconcileTimeoutMs);
    this.inflight.set(args.entityId, { entityId: args.entityId, reconcileHandle });

    try {
      await this.binding.callService({
        domain: args.domain,
        service: args.service,
        target: args.entityId,
        ...(args.serviceData ? { serviceData: args.serviceData } : {}),
      });
      // Success: keep pending=true; the echo or timeout will clear it.
      // (Some installs return success quickly without an echo. The
      // reconcile timer guards that case.)
    } catch (cause) {
      this.completeInFlight(args.entityId);
      const message = cause instanceof Error ? cause.message : String(cause);
      this.flashError(args.entityId, message);
    }
  }

  // -- internals -----------------------------------------------------------

  private onStateChange(change: HaStateChange): void {
    if (this.detached) return;
    if (!this.inflight.has(change.entity_id)) {
      return;
    }
    this.completeInFlight(change.entity_id);
    // Successful reconciliation -- clear status (no error).
    this.setStatus(change.entity_id, { pending: false, error: false, errorMessage: "" });
  }

  private onReconcileTimeout(entityId: string): void {
    if (this.detached) return;
    if (!this.inflight.has(entityId)) return;
    this.completeInFlight(entityId);
    this.flashError(entityId, "timed out waiting for HA echo");
  }

  private completeInFlight(entityId: string): void {
    const flight = this.inflight.get(entityId);
    if (!flight) return;
    this.clearTimeoutFn(flight.reconcileHandle);
    this.inflight.delete(entityId);
  }

  private flashError(entityId: string, message: string): void {
    this.setStatus(entityId, { pending: false, error: true, errorMessage: message });
    const existing = this.errorFlashHandles.get(entityId);
    if (existing) {
      this.clearTimeoutFn(existing);
    }
    const handle = this.setTimeoutFn(() => {
      this.errorFlashHandles.delete(entityId);
      if (this.detached) return;
      this.setStatus(entityId, { ...EMPTY_STATUS });
    }, this.errorFlashMs);
    this.errorFlashHandles.set(entityId, handle);
  }

  private setStatus(entityId: string, next: TileStatus): void {
    const current = this.statuses.get(entityId);
    if (
      current &&
      current.pending === next.pending &&
      current.error === next.error &&
      current.errorMessage === next.errorMessage
    ) {
      return;
    }
    if (next.pending === false && next.error === false && next.errorMessage === "") {
      this.statuses.delete(entityId);
    } else {
      this.statuses.set(entityId, next);
    }
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (cause) {
        // eslint-disable-next-line no-console
        console.warn("[tile-interaction] listener threw", cause);
      }
    }
  }
}
