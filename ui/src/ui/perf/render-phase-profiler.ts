import { controlUiNowMs } from "../control-ui-performance.ts";

/**
 * Fine-grained, render-cycle-scoped timing for the chat transcript.
 *
 * The existing `recordControlUiRenderTiming` reports the *total* time a surface
 * spent rendering. This profiler breaks that total down into the hot phases
 * (markdown, syntax highlight, sanitize, JSON detection, chat-item build) so a
 * slow session switch can be attributed to a specific step instead of guessed.
 *
 * A "cycle" is one `renderMeasured(...)` call: `beginRenderPhases()` opens the
 * accumulator, instrumented hot paths add into it via `profilePhase` /
 * `recordPhase`, and `endRenderPhases()` returns the breakdown to attach to the
 * render-timing payload. Outside a cycle every helper is a no-op, so there is no
 * cost on non-measured code paths.
 */

export type RenderPhaseBucket = { totalMs: number; calls: number; maxMs: number };
export type RenderPhaseBreakdown = Record<string, RenderPhaseBucket>;

let activeBuckets: Map<string, RenderPhaseBucket> | null = null;

export function beginRenderPhases(): void {
  activeBuckets = new Map();
}

function addToBucket(label: string, durationMs: number): void {
  if (!activeBuckets) {
    return;
  }
  const bucket = activeBuckets.get(label) ?? { totalMs: 0, calls: 0, maxMs: 0 };
  bucket.totalMs += durationMs;
  bucket.calls += 1;
  if (durationMs > bucket.maxMs) {
    bucket.maxMs = durationMs;
  }
  activeBuckets.set(label, bucket);
}

/** Time a synchronous hot path and fold it into the current render cycle. */
export function profilePhase<T>(label: string, fn: () => T): T {
  if (!activeBuckets) {
    return fn();
  }
  const startedAtMs = controlUiNowMs();
  try {
    return fn();
  } finally {
    addToBucket(label, controlUiNowMs() - startedAtMs);
  }
}

/**
 * Record a phase whose duration is measured by the caller (or a 0ms counter,
 * e.g. a cache hit). Increments the call count even at 0ms.
 */
export function recordPhase(label: string, durationMs: number): void {
  addToBucket(label, Math.max(0, durationMs));
}

/** Close the current cycle and return a rounded, plain-object breakdown. */
export function endRenderPhases(): RenderPhaseBreakdown {
  if (!activeBuckets) {
    return {};
  }
  const breakdown: RenderPhaseBreakdown = {};
  for (const [label, bucket] of activeBuckets) {
    breakdown[label] = {
      totalMs: Math.round(bucket.totalMs * 10) / 10,
      calls: bucket.calls,
      maxMs: Math.round(bucket.maxMs * 10) / 10,
    };
  }
  activeBuckets = null;
  return breakdown;
}
