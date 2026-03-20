import { parseAgentSessionKey } from "../../../../../src/routing/session-key.js";
import type { CronJob, CronRunLogEntry } from "../../types.ts";
import type { TaskBoardCardVM, TaskBoardHealth, TaskBoardStatus } from "../types.ts";

const CRON_WARNING_MS = 60 * 60 * 1000;
const CRON_STALE_MS = 6 * 60 * 60 * 1000;

function deriveProgress(status: TaskBoardStatus): number {
  switch (status) {
    case "queued":
      return 10;
    case "in_progress":
      return 40;
    case "waiting":
      return 70;
    case "blocked":
      return 50;
    case "done":
      return 100;
    case "paused":
      return 0;
    case "disabled":
      return 0;
    case "error":
      return 50;
    default:
      return 0;
  }
}

function buildLatestRunMap(entries: CronRunLogEntry[]): Map<string, CronRunLogEntry> {
  const map = new Map<string, CronRunLogEntry>();
  for (const entry of entries) {
    if (!entry?.jobId || map.has(entry.jobId)) {
      continue;
    }
    map.set(entry.jobId, entry);
  }
  return map;
}

function resolveOwner(job: CronJob): string {
  if (job.agentId?.trim()) {
    return job.agentId.trim();
  }
  const parsed = parseAgentSessionKey(job.sessionKey);
  if (parsed?.agentId) {
    return parsed.agentId;
  }
  return "system";
}

function deriveScheduledStatus(
  job: CronJob,
  latestRun: CronRunLogEntry | null | undefined,
): TaskBoardStatus {
  if (!job.enabled) {
    return "disabled";
  }
  if (job.state?.runningAtMs) {
    return "in_progress";
  }
  if (
    latestRun?.status === "error" ||
    job.state?.lastRunStatus === "error" ||
    job.state?.lastStatus === "error"
  ) {
    return "error";
  }
  return "waiting";
}

function deriveScheduledHealth(
  job: CronJob,
  latestRun: CronRunLogEntry | null | undefined,
  nowMs: number,
): TaskBoardHealth {
  if (!job.enabled) {
    return "warning";
  }
  if (job.state?.runningAtMs) {
    return "healthy";
  }
  if (
    latestRun?.status === "error" ||
    job.state?.lastRunStatus === "error" ||
    job.state?.lastStatus === "error"
  ) {
    return "error";
  }
  const reference = latestRun?.ts ?? job.state?.lastRunAtMs ?? job.updatedAtMs ?? null;
  if (!reference) {
    return "warning";
  }
  const age = Math.max(0, nowMs - reference);
  if (age >= CRON_STALE_MS) {
    return "stale";
  }
  if (age >= CRON_WARNING_MS) {
    return "warning";
  }
  return "healthy";
}

function resolveRecentResult(
  job: CronJob,
  latestRun: CronRunLogEntry | null | undefined,
): string | null {
  if (!job.enabled) {
    return "已禁用";
  }
  if (job.state?.runningAtMs) {
    return "运行中";
  }
  if (latestRun?.summary?.trim()) {
    return latestRun.summary.trim();
  }
  if (latestRun?.status === "ok") {
    return "最近一次运行正常";
  }
  if (latestRun?.status === "error") {
    return latestRun.error?.trim() || "最近一次运行失败";
  }
  if (job.state?.lastRunStatus === "ok") {
    return "最近一次运行正常";
  }
  if (job.state?.lastError?.trim()) {
    return job.state.lastError.trim();
  }
  return null;
}

export function buildCronTaskCards(
  jobs: CronJob[] | null | undefined,
  entries: CronRunLogEntry[] | null | undefined,
  nowMs = Date.now(),
): TaskBoardCardVM[] {
  const latestRuns = buildLatestRunMap(entries ?? []);
  return (jobs ?? [])
    .map((job) => {
      const latestRun = latestRuns.get(job.id);
      const status = deriveScheduledStatus(job, latestRun);
      const lastRunAtMs = latestRun?.ts ?? job.state?.lastRunAtMs ?? null;
      const nextRunAtMs = job.state?.nextRunAtMs ?? latestRun?.nextRunAtMs ?? null;
      const runningAtMs = job.state?.runningAtMs ?? null;
      return {
        id: job.id,
        lane: "scheduled",
        title: job.name,
        owner: resolveOwner(job),
        status,
        health: deriveScheduledHealth(job, latestRun, nowMs),
        progressPercent: deriveProgress(status),
        progressSource: "estimated",
        startedAt: runningAtMs ? new Date(runningAtMs).toISOString() : null,
        lastRunAt: lastRunAtMs ? new Date(lastRunAtMs).toISOString() : null,
        nextRunAt: nextRunAtMs ? new Date(nextRunAtMs).toISOString() : null,
        runningForSec: runningAtMs ? Math.max(0, Math.floor((nowMs - runningAtMs) / 1000)) : null,
        waitingForSec:
          !runningAtMs && lastRunAtMs
            ? Math.max(0, Math.floor((nowMs - lastRunAtMs) / 1000))
            : null,
        tokenUsage: {
          value: latestRun?.usage?.total_tokens ?? null,
          window: latestRun ? "last run" : null,
          source: latestRun ? "cron.runs" : null,
        },
        summary: job.description?.trim() || resolveRecentResult(job, latestRun),
        blocker: status === "error" ? resolveRecentResult(job, latestRun) : null,
        decisionNeeded: false,
        recentResult: resolveRecentResult(job, latestRun),
        enabled: job.enabled,
        sourceOfTruth: ["cron.list", "cron.runs"],
      } satisfies TaskBoardCardVM;
    })
    .toSorted((a, b) => {
      const aRank = a.health === "error" ? 0 : a.status === "disabled" ? 1 : 2;
      const bRank = b.health === "error" ? 0 : b.status === "disabled" ? 1 : 2;
      if (aRank !== bRank) {
        return aRank - bRank;
      }
      const aNext = a.nextRunAt ? Date.parse(a.nextRunAt) : Number.MAX_SAFE_INTEGER;
      const bNext = b.nextRunAt ? Date.parse(b.nextRunAt) : Number.MAX_SAFE_INTEGER;
      return aNext - bNext;
    });
}
