import { isCronSessionKey, parseAgentSessionKey } from "../../../../../src/routing/session-key.js";
import type { GatewaySessionRow, SessionsListResult, SessionRunStatus } from "../../types.ts";
import type { TaskBoardCardVM, TaskBoardHealth, TaskBoardStatus } from "../types.ts";

const ACTIVE_WARNING_MS = 30 * 60 * 1000;
const ACTIVE_STALE_MS = 2 * 60 * 60 * 1000;

function deriveActiveStatus(row: GatewaySessionRow): TaskBoardStatus {
  if (
    row.abortedLastRun ||
    row.status === "failed" ||
    row.status === "killed" ||
    row.status === "timeout"
  ) {
    return "error";
  }
  if (row.status === "running") {
    return "in_progress";
  }
  if (row.status === "done") {
    return "waiting";
  }
  if (!row.updatedAt) {
    return "queued";
  }
  return "waiting";
}

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

function deriveHealth(
  status: TaskBoardStatus,
  updatedAt: number | null | undefined,
  nowMs: number,
) {
  if (status === "error") {
    return "error" satisfies TaskBoardHealth;
  }
  if (!updatedAt) {
    return "warning" satisfies TaskBoardHealth;
  }
  const age = Math.max(0, nowMs - updatedAt);
  if (age >= ACTIVE_STALE_MS) {
    return "stale" satisfies TaskBoardHealth;
  }
  if (age >= ACTIVE_WARNING_MS) {
    return "warning" satisfies TaskBoardHealth;
  }
  return "healthy" satisfies TaskBoardHealth;
}

function resolveOwner(row: GatewaySessionRow): string {
  const parsed = parseAgentSessionKey(row.key);
  if (parsed?.agentId) {
    return parsed.agentId;
  }
  const display = row.displayName?.trim();
  if (display) {
    return display;
  }
  return row.key;
}

function resolveTitle(row: GatewaySessionRow): string {
  const label = row.label?.trim();
  if (label) {
    return label;
  }
  const display = row.displayName?.trim();
  if (display) {
    return display;
  }
  const parsed = parseAgentSessionKey(row.key);
  if (parsed?.agentId) {
    return parsed.rest ? `${parsed.agentId} · ${parsed.rest}` : parsed.agentId;
  }
  return row.key;
}

function normalizeStatusText(status?: SessionRunStatus): string | null {
  if (!status) {
    return null;
  }
  if (status === "running") {
    return "正在运行";
  }
  if (status === "done") {
    return "最近一轮已结束";
  }
  if (status === "failed") {
    return "最近一轮失败";
  }
  if (status === "killed") {
    return "最近一轮被终止";
  }
  if (status === "timeout") {
    return "最近一轮超时";
  }
  return status;
}

export function buildSessionTaskCards(
  result: SessionsListResult | null | undefined,
  nowMs = Date.now(),
): TaskBoardCardVM[] {
  const rows = result?.sessions ?? [];
  return rows
    .filter((row) => row?.key && !isCronSessionKey(row.key))
    .map((row) => {
      const status = deriveActiveStatus(row);
      const startedAt = row.startedAt ?? row.updatedAt ?? null;
      const updatedAt = row.updatedAt ?? null;
      const runningForSec =
        startedAt && status === "in_progress"
          ? Math.max(0, Math.floor((nowMs - startedAt) / 1000))
          : null;
      const waitingForSec =
        updatedAt && status !== "in_progress"
          ? Math.max(0, Math.floor((nowMs - updatedAt) / 1000))
          : null;
      const totalTokens = row.totalTokens ?? row.inputTokens ?? row.outputTokens ?? null;
      return {
        id: row.key,
        lane: "active",
        title: resolveTitle(row),
        owner: resolveOwner(row),
        status,
        health: deriveHealth(status, updatedAt, nowMs),
        progressPercent: deriveProgress(status),
        progressSource: "estimated",
        startedAt: startedAt ? new Date(startedAt).toISOString() : null,
        lastRunAt: updatedAt ? new Date(updatedAt).toISOString() : null,
        nextRunAt: null,
        runningForSec,
        waitingForSec,
        tokenUsage: {
          value: totalTokens,
          window: "session total",
          source: "sessions.list",
        },
        summary: row.displayName?.trim() || normalizeStatusText(row.status),
        blocker: status === "error" ? normalizeStatusText(row.status) : null,
        decisionNeeded: false,
        recentResult: normalizeStatusText(row.status),
        enabled: true,
        sourceOfTruth: ["sessions.list"],
      } satisfies TaskBoardCardVM;
    })
    .toSorted((a, b) => {
      const aRank = a.status === "error" ? 0 : a.status === "in_progress" ? 1 : 2;
      const bRank = b.status === "error" ? 0 : b.status === "in_progress" ? 1 : 2;
      if (aRank !== bRank) {
        return aRank - bRank;
      }
      return (b.runningForSec ?? b.waitingForSec ?? 0) - (a.runningForSec ?? a.waitingForSec ?? 0);
    });
}
