import { getSafeLocalStorage } from "../../local-storage.ts";
import {
  controlUiNowMs,
  recordControlUiPerformanceEvent,
  roundedControlUiDurationMs,
} from "../control-ui-performance.ts";

/**
 * Engine-agnostic main-thread stall detector.
 *
 * The Tauri desktop app renders in WKWebView, which does not implement the
 * Chromium-only `longtask` / `long-animation-frame` PerformanceObserver entry
 * types that {@link startControlUiResponsivenessObserver} relies on. To still
 * see when the main thread is blocked there — by rendering *or* by anything
 * else (RPC JSON parsing, event handlers, image work) — we run a fixed-interval
 * heartbeat and flag the gaps. A timer that should fire every 50ms but fires
 * 800ms late means the thread was blocked for ~750ms in between.
 *
 * Pair the emitted `control-ui.main-thread-block` events with the
 * `control-ui.render` timings: a block that lines up with a slow `chat` render
 * is render cost; a block with no matching render event is non-render work.
 *
 * Opt-in (it adds a recurring timer): enable with
 * `localStorage.setItem("openclaw:perf-heartbeat", "1")` and reload.
 */

const HEARTBEAT_INTERVAL_MS = 50;
// Only report gaps well beyond the interval + normal timer jitter.
const BLOCK_THRESHOLD_MS = 120;
const HEARTBEAT_FLAG_KEY = "openclaw:perf-heartbeat";

type MainThreadMonitorHost = Parameters<typeof recordControlUiPerformanceEvent>[0];

export type MainThreadBlockMonitor = { stop: () => void };

function heartbeatEnabled(): boolean {
  try {
    return getSafeLocalStorage()?.getItem(HEARTBEAT_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

export function startMainThreadBlockMonitor(
  host: MainThreadMonitorHost,
  opts?: { force?: boolean },
): MainThreadBlockMonitor | null {
  if (typeof setInterval !== "function" || typeof performance === "undefined") {
    return null;
  }
  // The desktop app forces it on (it ships the perf log sink); elsewhere it is
  // opt-in via localStorage so the recurring timer never runs unasked.
  if (!opts?.force && !heartbeatEnabled()) {
    return null;
  }
  let lastTickMs = controlUiNowMs();
  const timer = setInterval(() => {
    const nowMs = controlUiNowMs();
    const blockedMs = nowMs - lastTickMs - HEARTBEAT_INTERVAL_MS;
    lastTickMs = nowMs;
    if (blockedMs < BLOCK_THRESHOLD_MS) {
      return;
    }
    recordControlUiPerformanceEvent(
      host,
      "control-ui.main-thread-block",
      {
        tab: host.tab,
        blockedMs: roundedControlUiDurationMs(blockedMs),
      },
      { warn: true, maxBufferedEventsForType: 50 },
    );
  }, HEARTBEAT_INTERVAL_MS);
  return {
    stop: () => clearInterval(timer),
  };
}
