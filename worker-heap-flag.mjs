// Make per-Worker V8 heap budgets effective when the main process carries a heap flag.
//
// V8 applies --max-old-space-size process-wide, so a flag from NODE_OPTIONS or argv
// overrides every Worker's resourceLimits.maxOldGenerationSizeMb (openclaw#157575).
// The main isolate keeps the limit it was created with; clearing the flag here only
// affects isolates created later. Set OPENCLAW_WORKER_HEAP_FLAG_RESET=0 to opt out.
import { setFlagsFromString } from "node:v8";
import { isMainThread } from "node:worker_threads";

const HEAP_FLAG = /(^|\s)--max[-_]old[-_]space[-_]size(=|\s|$)/;

export function hasProcessHeapFlag(env = process.env, execArgv = process.execArgv) {
  return HEAP_FLAG.test(env.NODE_OPTIONS ?? "") || execArgv.some((arg) => HEAP_FLAG.test(arg));
}

export function resetWorkerHeapFlag(env = process.env, execArgv = process.execArgv) {
  if (!isMainThread || env.OPENCLAW_WORKER_HEAP_FLAG_RESET === "0") {
    return false;
  }
  if (!hasProcessHeapFlag(env, execArgv)) {
    return false;
  }
  try {
    setFlagsFromString("--max-old-space-size=0"); // 0 = unset for isolates created later
    return true;
  } catch {
    return false; // never block startup on this
  }
}

resetWorkerHeapFlag();
