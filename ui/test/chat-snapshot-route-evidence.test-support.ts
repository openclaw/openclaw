import type { ApplicationRuntime } from "../src/app/bootstrap.ts";
import type { ApplicationContext, ApplicationContextRequest } from "../src/app/context.ts";
import type { ChatRouteData } from "../src/pages/chat/session-route-data.ts";
import type { MockGatewayWindow } from "../src/test-helpers/control-ui-e2e-contract.ts";

// Serialized after the mock Gateway in this suite's existing init script. The
// existing diagnostic console ring survives reloads and enters the private artifact.
export function captureSnapshotRouteEvidence(sessionPathParam: string): void {
  const methods = new Set(["sessions.resolve", "sessions.describe", "chat.startup"]);
  let sequence = 0;
  let activeRequest: { call: number; id?: string } | undefined;
  let calls = 0;
  const requests = new Map<string, { method: string; key: unknown }>();
  const routers = new WeakSet<ApplicationContext["router"]>();
  const clients = new WeakSet<NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>>();
  const stops: Array<() => void> = [];

  const record = (event: string, read: () => object | undefined) => {
    try {
      const facts = read();
      if (!facts) {
        return;
      }
      console.debug(
        "[snapshot-route] " +
          JSON.stringify({
            at: performance.timeOrigin + performance.now(),
            document: performance.timeOrigin,
            sequence: ++sequence,
            event,
            ...facts,
          }),
      );
    } catch {
      // Diagnostics must not replace an original result or exception.
    }
  };
  const identity = (value: unknown) => {
    type Row = { key?: string; sessionKey?: string; agentId?: string };
    const envelope = value as (Row & { session?: Row; sessionInfo?: Row }) | undefined;
    const row = envelope?.session ?? envelope?.sessionInfo ?? envelope;
    return { key: row?.key ?? row?.sessionKey ?? null, agentId: row?.agentId ?? null };
  };
  const requestKey = (value: unknown) => {
    const params = value as { reference?: { key?: string }; key?: string; sessionKey?: string };
    return params?.reference?.key ?? params?.key ?? params?.sessionKey ?? null;
  };
  const routeData = (value: unknown) => {
    const data = value as ChatRouteData | undefined;
    return data?.kind === "session"
      ? {
          kind: data.kind,
          key: data.sessionKey,
          agentId: data.agentId,
          cache: data.sessionResolutionFromCache,
          canonical: data.canonicalLocation?.pathname,
          source: data.canonicalLocationSource?.pathname,
          canonicalPending: Boolean(data.canonicalLocationReady),
        }
      : { kind: data?.kind ?? null };
  };
  const failure = (error: unknown) => (error instanceof Error ? error.name : "unknown");
  const observe = <T>(
    result: T,
    settled: (value: unknown) => void,
    rejected: (error: unknown) => void,
  ) => {
    if (result instanceof Promise) {
      void result.then(settled, rejected);
    } else {
      settled(result);
    }
    return result;
  };

  for (const method of ["pushState", "replaceState"] as const) {
    const original = history[method];
    history[method] = function (this: History, ...args) {
      record("history." + method, () => ({
        from: location.pathname,
        to: args[2] == null ? null : new URL(String(args[2]), location.href).pathname,
        source: new Error().stack,
      }));
      return original.apply(this, args);
    };
  }

  // oxlint-disable-next-line typescript/unbound-method -- The wrapper preserves the caller's receiver with apply.
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (this: WebSocket, ...args) {
    record("mock.request", () => {
      if (typeof args[0] !== "string") {
        return undefined;
      }
      const frame = JSON.parse(args[0]);
      if (!methods.has(frame.method)) {
        return undefined;
      }
      const key = requestKey(frame.params);
      requests.set(frame.id, { method: frame.method, key });
      if (activeRequest) {
        activeRequest.id = frame.id;
      }
      return { id: frame.id, method: frame.method, key };
    });
    return send.apply(this, args);
  };
  // oxlint-disable-next-line typescript/unbound-method -- The wrapper preserves the caller's receiver with call.
  const dispatch = WebSocket.prototype.dispatchEvent;
  WebSocket.prototype.dispatchEvent = function (this: WebSocket, event) {
    const result = dispatch.call(this, event);
    if (event instanceof MessageEvent) {
      record("mock.reply.dispatched", () => {
        const frame = JSON.parse(String(event.data));
        const request = requests.get(frame.id);
        if (!request || frame.type !== "res") {
          return undefined;
        }
        requests.delete(frame.id);
        return { id: frame.id, ...request, ok: frame.ok, reply: identity(frame.payload) };
      });
    }
    return result;
  };
  const mock = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
  const release = mock.resolveDeferred;
  mock.resolveDeferred = function (...args) {
    if (methods.has(args[0])) {
      record("mock.release", () => ({ method: args[0], reply: identity(args[1]) }));
    }
    return release.apply(this, args);
  };

  const attach = (context: ApplicationContext) => {
    // bootstrapApplication supplies the full router on the native context. Its
    // public capability is narrower; only this suite interposes on the loader.
    const router = context.router as ApplicationRuntime["router"];
    if (routers.has(router)) {
      return;
    }
    routers.add(router);
    for (const method of ["navigate", "navigateAndWait", "replace"] as const) {
      const original = context[method];
      Object.defineProperty(context, method, {
        ...Object.getOwnPropertyDescriptor(context, method),
        value(this: ApplicationContext, ...args: Parameters<typeof original>) {
          record("navigation." + method, () => ({
            routeId: args[0],
            pathname: args[1]?.pathname,
            source: new Error().stack,
          }));
          return original.apply(this, args);
        },
      });
    }
    const observeClient = () => {
      const client = context.gateway.snapshot.client;
      if (!client || clients.has(client)) {
        return;
      }
      clients.add(client);
      // oxlint-disable-next-line typescript/unbound-method -- The wrapper preserves the caller's receiver with apply.
      const request = client.request;
      client.request = function <T>(this: typeof client, ...args: Parameters<typeof request>) {
        const [method, params] = args;
        const invoke = request<T>;
        if (!methods.has(method)) {
          return invoke.apply(this, args);
        }
        const call = { call: ++calls, id: undefined as string | undefined };
        const previous = activeRequest;
        activeRequest = call;
        let result: Promise<T>;
        try {
          result = invoke.apply(this, args);
        } catch (error) {
          record("rpc.rejected", () => ({
            ...call,
            method,
            key: requestKey(params),
            reason: failure(error),
          }));
          throw error;
        } finally {
          activeRequest = previous;
        }
        return observe(
          result,
          (reply) =>
            record("rpc.consumed", () => ({
              ...call,
              method,
              key: requestKey(params),
              reply: identity(reply),
            })),
          (error) =>
            record("rpc.rejected", () => ({
              ...call,
              method,
              key: requestKey(params),
              reason: failure(error),
            })),
        );
      };
    };
    observeClient();
    stops.push(
      context.gateway.subscribe(() => {
        try {
          observeClient();
        } catch (error) {
          record("observer.error", () => ({ reason: failure(error) }));
        }
      }),
    );
    const route = router.getRoute("chat");
    const loader = route?.loader;
    if (route && loader) {
      route.loader = function (this: typeof route, owner, options) {
        const prior = routeData(router.getState().matches[0]?.data);
        // Entering a short reference has no known key yet. Revalidation asks
        // about the committed key; keep that distinct from a newly accepted key.
        const requestedKey = options.cause === "revalidate" && "key" in prior ? prior.key : null;
        const reference =
          new URLSearchParams(options.location.search).get(sessionPathParam) ??
          options.location.pathname;
        record("route.requested", () => ({ cause: options.cause, reference, requestedKey, prior }));
        options.signal.addEventListener(
          "abort",
          () =>
            record("route.aborted", () => ({
              reference,
              requestedKey,
              reason: failure(options.signal.reason),
              source: new Error().stack,
            })),
          { once: true },
        );
        let result: ReturnType<typeof loader>;
        try {
          result = loader.call(this, owner, options);
        } catch (error) {
          record("route.admission", () => ({
            decision: "rejected",
            reference,
            requestedKey,
            reason: failure(error),
          }));
          throw error;
        }
        return observe(
          result,
          (data) =>
            record("route.admission", () => {
              const admission = routeData(data);
              return {
                owner: "loader",
                decision:
                  options.signal.aborted || admission.kind !== "session" ? "rejected" : "accepted",
                reason: options.signal.aborted
                  ? "aborted"
                  : (("cache" in admission ? admission.cache : admission.kind) ??
                    "redirect-or-not-found"),
                reference,
                requestedKey,
                result: admission,
              };
            }),
          (error) =>
            record("route.admission", () => ({
              decision: "rejected",
              reference,
              requestedKey,
              reason: failure(error),
            })),
        );
      };
    }
    let previous = "";
    stops.push(
      router.subscribe((state) => {
        record("route.published", () => {
          const matches = [...state.matches, ...state.pendingMatches].map((match) => ({
            pending: state.pendingMatches.includes(match),
            pathname: match.location.pathname,
            status: match.status,
            fetching: match.isFetching,
            aborted: match.abortController.signal.aborted,
            data: routeData(match.data),
          }));
          const serialized = JSON.stringify(matches);
          if (serialized === previous) {
            return undefined;
          }
          previous = serialized;
          return { matches };
        });
      }),
    );
    record("observer.attached", () => ({}));
  };
  // Read the already-published native context once; do not subscribe a new
  // provider consumer, start the lazy readiness module, or dispatch an RPC.
  document.addEventListener(
    "context-provider",
    (event) => {
      const announcement = event as ApplicationContextRequest;
      if (
        announcement.context !== "openclaw.application" ||
        !(event.target instanceof HTMLElement)
      ) {
        return;
      }
      event.target.dispatchEvent(
        Object.assign(new Event("context-request", { bubbles: true }), {
          context: announcement.context,
          contextTarget: document.documentElement,
          callback: (context: ApplicationContext) => {
            try {
              attach(context);
            } catch (error) {
              record("observer.error", () => ({ reason: failure(error) }));
            }
          },
        }),
      );
    },
    true,
  );
  window.addEventListener("pagehide", () => stops.forEach((stop) => stop()), { once: true });
}
