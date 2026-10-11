import { setFlagsFromString } from "node:v8";
import { isMainThread } from "node:worker_threads";

const startupFlags = `${process.execArgv.join(" ")} ${process.env.NODE_OPTIONS ?? ""}`;
const heapFlag = /--max[-_](?:old[-_]space[-_]size(?:[-_]percentage)?|heap[-_]size)(?:=|\s)/u;
const immutableFlags =
  /--(?:freeze[-_]flags[-_]after[-_]init|abort[-_]on[-_]contradictory[-_]flags)(?:=(?:true|1))?(?:\s|$)/u;

if (isMainThread && !process.versions.bun && heapFlag.test(startupFlags)) {
  if (immutableFlags.test(startupFlags)) {
    // These V8 modes abort natively on a flag change; JavaScript cannot catch it.
    process.emitWarning("V8 startup flags prevent enforcing per-worker heap limits.");
  } else {
    // Existing isolates retain their limits. Only future isolates read these overrides.
    setFlagsFromString("--max-old-space-size=0 --max-heap-size=0");
  }
}
