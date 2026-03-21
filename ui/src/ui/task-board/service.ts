import type { GatewayBrowserClient } from "../gateway.ts";
import type { CronJobsListResult, CronRunsResult, SessionsListResult } from "../types.ts";
import { buildCronTaskCards } from "./adapters/cron-adapter.ts";
import { buildSessionTaskCards } from "./adapters/session-adapter.ts";
import type { TaskBoardCardVM } from "./types.ts";

export type TaskBoardState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  taskBoardLoading: boolean;
  taskBoardError: string | null;
  taskBoardCards: TaskBoardCardVM[];
  taskBoardLastLoadedAt: number | null;
};

export async function loadTaskBoard(state: TaskBoardState) {
  if (!state.client || !state.connected || state.taskBoardLoading) {
    return;
  }
  state.taskBoardLoading = true;
  state.taskBoardError = null;
  try {
    const [sessionsResult, cronJobsResult, cronRunsResult] = await Promise.all([
      state.client.request<SessionsListResult>("sessions.list", {
        activeMinutes: 24 * 60,
        limit: 200,
        includeGlobal: true,
        includeUnknown: false,
      }),
      state.client.request<CronJobsListResult>("cron.list", {
        includeDisabled: true,
        enabled: "all",
        limit: 200,
        offset: 0,
        sortBy: "nextRunAtMs",
        sortDir: "asc",
      }),
      state.client.request<CronRunsResult>("cron.runs", {
        scope: "all",
        limit: 200,
        offset: 0,
        sortDir: "desc",
        status: "all",
      }),
    ]);
    const nowMs = Date.now();
    state.taskBoardCards = [
      ...buildSessionTaskCards(sessionsResult, nowMs),
      ...buildCronTaskCards(cronJobsResult?.jobs ?? [], cronRunsResult?.entries ?? [], nowMs),
    ];
    state.taskBoardLastLoadedAt = nowMs;
  } catch (err) {
    state.taskBoardError = String(err);
  } finally {
    state.taskBoardLoading = false;
  }
}
