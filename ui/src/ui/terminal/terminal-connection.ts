// Protocol layer for the operator terminal: wraps the gateway client with typed
// terminal.* RPCs and fans the terminal.data / terminal.exit event stream out to
// per-session sinks. Kept DOM-free so it can be unit tested without ghostty-web.

/** Minimal gateway surface the terminal needs; GatewayBrowserClient satisfies it. */
export interface TerminalGatewayClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  addEventListener(listener: (evt: { event: string; payload: unknown }) => void): () => void;
}

export type TerminalOpenResult = {
  sessionId: string;
  agentId: string;
  shell: string;
  cwd: string;
  confined: boolean;
};

export type TerminalExitInfo = {
  exitCode: number | null;
  signal: number | null;
  reason?: string;
  error?: string;
};

type SessionSink = {
  onData: (data: string) => void;
  onExit: (info: TerminalExitInfo) => void;
};

/** An event buffered before its session sink was registered. */
type PendingEvent = { kind: "data"; data: string } | { kind: "exit"; info: TerminalExitInfo };

/** Routes the shared terminal event stream to the session that owns each id. */
export class TerminalConnection {
  private readonly client: TerminalGatewayClient;
  private readonly sinks = new Map<string, SessionSink>();
  // Events that arrive after the terminal.open RPC response but before the
  // caller registers its sink (the server wires the PTY before responding, so a
  // prompt/MOTD — or an instant exit — can race ahead). Buffered in arrival
  // order per session and flushed on register so nothing is dropped.
  private readonly pending = new Map<string, PendingEvent[]>();
  private unsubscribe: (() => void) | null = null;
  // Opens still awaiting their RPC response; keeps the subscription alive so
  // their early output is buffered even if every registered session closes.
  private pendingOpenCount = 0;

  // Bounds the pre-registration buffer so a session that never registers (e.g.
  // its open failed after the server started streaming) cannot grow unbounded.
  private static readonly MAX_PENDING_EVENTS = 512;

  constructor(client: TerminalGatewayClient) {
    this.client = client;
  }

  /** Starts listening for terminal events; idempotent. */
  private ensureSubscribed(): void {
    if (this.unsubscribe) {
      return;
    }
    this.unsubscribe = this.client.addEventListener((evt) => {
      if (evt.event === "terminal.data") {
        const payload = evt.payload as { sessionId?: string; data?: string } | undefined;
        if (payload?.sessionId && typeof payload.data === "string") {
          const sink = this.sinks.get(payload.sessionId);
          if (sink) {
            sink.onData(payload.data);
          } else {
            this.bufferEarly(payload.sessionId, { kind: "data", data: payload.data });
          }
        }
        return;
      }
      if (evt.event === "terminal.exit") {
        const payload = evt.payload as
          | {
              sessionId?: string;
              exitCode?: number | null;
              signal?: number | null;
              reason?: string;
              error?: string;
            }
          | undefined;
        if (payload?.sessionId) {
          const info: TerminalExitInfo = {
            exitCode: payload.exitCode ?? null,
            signal: payload.signal ?? null,
            reason: payload.reason,
            error: payload.error,
          };
          const sink = this.sinks.get(payload.sessionId);
          if (sink) {
            this.deliverExit(payload.sessionId, sink, info);
          } else {
            // An instant-exiting shell can emit exit before its sink registers;
            // buffer it so the UI does not keep a live tab for a dead session.
            this.bufferEarly(payload.sessionId, { kind: "exit", info });
          }
        }
      }
    });
  }

  /** Opens a session and registers its output/exit sinks before returning. */
  async open(
    params: { agentId?: string; cols: number; rows: number },
    sink: SessionSink,
  ): Promise<TerminalOpenResult> {
    this.ensureSubscribed();
    // Holds the subscription while the RPC is in flight so a concurrent
    // close/exit on another session cannot drop the listener and lose this
    // session's early output.
    this.pendingOpenCount += 1;
    let result: TerminalOpenResult;
    try {
      result = await this.client.request<TerminalOpenResult>("terminal.open", params);
    } catch (err) {
      // A rejected open (sandboxed agent, disabled terminal, missing PTY,
      // disconnect race) never registers a sink. Drop the listener when no
      // sessions remain so repeated failed opens across reconnects don't
      // accumulate listeners on the shared gateway client.
      this.pendingOpenCount -= 1;
      this.maybeUnsubscribe();
      throw err;
    }
    this.pendingOpenCount -= 1;
    this.sinks.set(result.sessionId, sink);
    // Replay any events that raced ahead of registration, in arrival order.
    const early = this.pending.get(result.sessionId);
    if (early) {
      this.pending.delete(result.sessionId);
      for (const event of early) {
        if (event.kind === "data") {
          sink.onData(event.data);
        } else {
          this.deliverExit(result.sessionId, sink, event.info);
        }
      }
    }
    return result;
  }

  /**
   * Delivers a terminal exit and drops the session's own sink. The connection
   * owns this cleanup (rather than the caller) because an exit can be replayed
   * during open() before the caller has recorded the session id, so caller-side
   * release would target an empty id and leak the sink.
   */
  private deliverExit(sessionId: string, sink: SessionSink, info: TerminalExitInfo): void {
    sink.onExit(info);
    this.sinks.delete(sessionId);
    this.pending.delete(sessionId);
    this.maybeUnsubscribe();
  }

  /** Buffers a pre-registration event, dropping the oldest once the cap is hit. */
  private bufferEarly(sessionId: string, event: PendingEvent): void {
    let buf = this.pending.get(sessionId);
    if (!buf) {
      buf = [];
      this.pending.set(sessionId, buf);
    }
    buf.push(event);
    if (buf.length > TerminalConnection.MAX_PENDING_EVENTS) {
      buf.shift();
    }
  }

  /** Sends client input; failures are swallowed since the exit event drives teardown. */
  async input(sessionId: string, data: string): Promise<void> {
    await this.client.request("terminal.input", { sessionId, data }).catch(() => undefined);
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.client.request("terminal.resize", { sessionId, cols, rows }).catch(() => undefined);
  }

  /** Closes a session server-side and drops its local sink. */
  async close(sessionId: string): Promise<void> {
    this.sinks.delete(sessionId);
    this.pending.delete(sessionId);
    await this.client.request("terminal.close", { sessionId }).catch(() => undefined);
    // The server emits this session's final terminal.exit while handling the
    // close RPC (the event frame precedes the response), and with the sink
    // already gone it lands in the early-event buffer. Drop it again or closed
    // ids accumulate for the lifetime of the subscription.
    this.pending.delete(sessionId);
    this.maybeUnsubscribe();
  }

  /** Number of live session sinks; used by the panel and tests. */
  get size(): number {
    return this.sinks.size;
  }

  /**
   * Drops the gateway subscription and all buffered state. The panel calls this
   * when it discards the connection (disconnect/disable) so the listener does
   * not outlive the connection and leak on the shared gateway client.
   */
  dispose(): void {
    this.sinks.clear();
    this.pending.clear();
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  private maybeUnsubscribe(): void {
    if (this.sinks.size === 0 && this.pendingOpenCount === 0 && this.unsubscribe) {
      // No live sessions and no opens in flight: drop the listener and any
      // orphaned early-output buffers too.
      this.pending.clear();
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}
