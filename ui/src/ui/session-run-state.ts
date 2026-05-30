import type { SessionRunStatus } from "./types.ts";

type SessionRunState = {
  hasActiveRun?: boolean;
  status?: SessionRunStatus;
};

export function isSessionRunActive(state: SessionRunState): boolean {
  if (state.hasActiveRun === false) {
    return false;
  }
  if (state.status) {
    return state.status === "running";
  }
  if (typeof state.hasActiveRun === "boolean") {
    return state.hasActiveRun;
  }
  return state.status === "running";
}
