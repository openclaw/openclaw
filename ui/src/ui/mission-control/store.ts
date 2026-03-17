import type { AppViewState } from "../app-view-state.ts";
import { deriveLiveAdapters, parseProjectFiles } from "./adapters.ts";
import { missionControlSeed } from "./config.ts";
import { computeGuardrailWarnings } from "./guardrails.ts";
import type {
  MissionAuditEntry,
  MissionSnapshot,
  MissionStageId,
  MissionTimelineEvent,
  MissionWorkItem,
} from "./types.ts";

function readMissionFlag(state: AppViewState): boolean {
  const fromConfig = state.configForm as { featureFlags?: { missionControl?: unknown } } | null;
  if (typeof fromConfig?.featureFlags?.missionControl === "boolean") {
    return fromConfig.featureFlags.missionControl;
  }
  return missionControlSeed.featureEnabled;
}

function deriveRuntimeHealth(state: AppViewState): "ok" | "degraded" {
  if (!state.connected || Boolean(state.lastError)) {
    return "degraded";
  }
  return "ok";
}

function deriveWorkItems(
  parserWorkItems: MissionWorkItem[],
  explicitHandoffWorkItemIds: Set<string>,
  sourceState: MissionSnapshot["provenance"]["mission"],
): { items: MissionWorkItem[]; provenance: MissionSnapshot["provenance"]["workItems"] } {
  const applyDebt = (item: MissionWorkItem) => ({
    ...item,
    reviewDebt:
      item.stage === "execution" &&
      item.nextOwner === "review" &&
      !explicitHandoffWorkItemIds.has(item.id),
    updatedAt: Date.now(),
  });

  if (parserWorkItems.length > 0) {
    return {
      items: parserWorkItems.map(applyDebt),
      provenance: sourceState === "stale" ? "stale" : sourceState === "live" ? "live" : "mixed",
    };
  }

  return {
    items: missionControlSeed.workItems.map(applyDebt),
    provenance: "seed-backed",
  };
}

function nextStageFor(item: MissionWorkItem, stages: MissionStageId[]): MissionStageId | null {
  const idx = stages.indexOf(item.stage);
  if (idx < 0 || idx === stages.length - 1) {
    return null;
  }
  return stages[idx + 1] ?? null;
}

function derivePendingHandoffs(workItems: MissionWorkItem[]): number {
  return workItems.filter((item) => Boolean(item.nextOwner) && item.stage !== "done").length;
}

function deriveMissionHealth(runtimeHealth: "ok" | "degraded", pendingApprovals: number): number {
  let score = missionControlSeed.missionHealthScore;
  if (runtimeHealth === "degraded") {
    score -= 20;
  }
  score -= Math.min(15, pendingApprovals * 3);
  return Math.max(0, score);
}

function buildTimeline(
  workItems: MissionWorkItem[],
  handoffs: MissionSnapshot["handoffs"],
  memoryRecords: MissionSnapshot["memoryRecords"],
  provenance: {
    handoffs: MissionSnapshot["provenance"]["handoffs"];
    workItems: MissionSnapshot["provenance"]["workItems"];
    memory: MissionSnapshot["provenance"]["memory"];
  },
): MissionTimelineEvent[] {
  const handoffEvents: MissionTimelineEvent[] = handoffs.map((handoff, idx) => ({
    id: `timeline-handoff-${handoff.id}`,
    kind: "handoff",
    title: `${handoff.from} → ${handoff.to}`,
    detail: `${handoff.status} · artifacts: ${handoff.requiredArtifacts.join(", ") || "none"}`,
    ts: Date.now() - idx,
    workItemId: handoff.workItemId,
    linkage: handoff.linkage,
    provenance: provenance.handoffs,
  }));

  const artifactEvents: MissionTimelineEvent[] = workItems.map((item, idx) => ({
    id: `timeline-artifact-${item.id}`,
    kind: "artifact",
    title: item.title,
    detail: `artifact ${item.requiredArtifact ?? "artifact"}${item.requiredArtifactId ? `#${item.requiredArtifactId}` : ""}`,
    ts: Date.now() - 1000 - idx,
    workItemId: item.id,
    linkage: item.artifactLinkage ?? "inferred",
    provenance: provenance.workItems,
  }));

  const memoryEvents: MissionTimelineEvent[] = memoryRecords.slice(0, 8).map((record, idx) => ({
    id: `timeline-memory-${record.id}`,
    kind: "memory",
    title: record.title,
    detail: `confidence ${record.confidence}${record.sourceRefs.length ? ` · ${record.sourceRefs[0]}` : ""}`,
    ts: Date.now() - 2000 - idx,
    linkage: record.linkage,
    provenance: provenance.memory,
  }));

  return [...handoffEvents, ...artifactEvents, ...memoryEvents]
    .toSorted((a, b) => b.ts - a.ts)
    .slice(0, 24);
}

const MUTATION_EVENT_PATTERNS = [
  /config\.(apply|patch|save|update)/i,
  /cron\.(add|update|remove|run)/i,
  /sessions\.(patch|send|spawn|kill)/i,
  /exec\.(approve|approval)/i,
  /agent\.(file|save|write|update)/i,
];

function buildAuditTrail(
  state: AppViewState,
  provenance: MissionSnapshot["provenance"]["mission"],
): MissionAuditEntry[] {
  const events = Array.isArray(state.eventLog) ? state.eventLog : [];
  const mutationEvents = events.filter((entry) => {
    if (!entry || typeof entry.event !== "string") {
      return false;
    }
    if (MUTATION_EVENT_PATTERNS.some((pattern) => pattern.test(entry.event))) {
      return true;
    }
    const payload = entry.payload as { method?: unknown } | undefined;
    return (
      typeof payload?.method === "string" &&
      /(config\.|cron\.|sessions\.|exec\.|agent\.)/i.test(payload.method)
    );
  });

  if (mutationEvents.length === 0) {
    return missionControlSeed.auditTrail.map((entry) => ({
      ...entry,
      provenance,
    }));
  }

  return mutationEvents.slice(0, 20).map((entry, idx) => ({
    id: `audit-${entry.ts}-${idx}`,
    ts: entry.ts,
    action: entry.event,
    source: "dashboard",
    summary:
      typeof entry.payload === "string"
        ? entry.payload
        : entry.payload
          ? JSON.stringify(entry.payload).slice(0, 140)
          : "mutation event captured",
    provenance,
  }));
}

export function buildMissionSnapshot(state: AppViewState): MissionSnapshot {
  const featureEnabled = readMissionFlag(state);
  const runtimeHealth = deriveRuntimeHealth(state);

  const adapter = parseProjectFiles(state);
  const live = deriveLiveAdapters(state);
  const pendingApprovals =
    live.provenance.approvals === "seed-backed"
      ? missionControlSeed.pendingApprovals
      : live.approvals.pendingCount;
  const explicitHandoffWorkItemIds = new Set(adapter.handoffs.map((h) => h.workItemId));
  const workItemsResult = deriveWorkItems(
    adapter.workItems,
    explicitHandoffWorkItemIds,
    adapter.sourceState,
  );
  const workItems = workItemsResult.items;
  const pendingHandoffs = derivePendingHandoffs(workItems);

  const inferredHandoffs = workItems
    .filter((item) => item.nextOwner)
    .map((item) => ({
      id: `derived-${item.id}`,
      workItemId: item.id,
      from: item.owner,
      to: item.nextOwner!,
      status: item.blocked ? ("returned" as const) : ("queued" as const),
      requiredArtifacts: [item.requiredArtifact ?? "artifact"],
      linkage: "inferred" as const,
    }));

  const handoffs = adapter.handoffs.length > 0 ? adapter.handoffs : inferredHandoffs;

  const baseMemory =
    adapter.memoryRecords.length > 0 ? adapter.memoryRecords : missionControlSeed.memoryRecords;
  const memoryRecords = baseMemory.map((record) => ({
    ...record,
    linkage: record.sourceRefs?.length ? ("explicit" as const) : ("inferred" as const),
    sourceRefs:
      record.sourceRefs?.length > 0
        ? record.sourceRefs
        : workItems.flatMap((item) => {
            const next = nextStageFor(item, missionControlSeed.stages);
            return next ? [`${item.id}:${item.stage}->${next}`] : [];
          }),
  }));

  const agents = missionControlSeed.agents.map((agent) => {
    const hint = adapter.teamHints[agent.id];
    const normalized = {
      ...agent,
      allowedModes: hint?.allowedModes?.length ? hint.allowedModes : agent.allowedModes,
    };
    return {
      ...normalized,
      guardrailWarnings: computeGuardrailWarnings(normalized, workItems, memoryRecords).map(
        (warning) => `[${warning.severity}] ${warning.message}`,
      ),
    };
  });

  const memoryProvenance: MissionSnapshot["provenance"]["memory"] =
    adapter.memoryRecords.length > 0
      ? adapter.sourceState === "live"
        ? "live"
        : adapter.sourceState === "stale"
          ? "stale"
          : "mixed"
      : adapter.sourceState === "unavailable"
        ? "unavailable"
        : "seed-backed";

  const handoffProvenance: MissionSnapshot["provenance"]["handoffs"] =
    adapter.handoffs.length > 0
      ? adapter.sourceState === "live"
        ? "live"
        : adapter.sourceState === "stale"
          ? "stale"
          : "mixed"
      : inferredHandoffs.length > 0
        ? adapter.sourceState === "stale"
          ? "stale"
          : "mixed"
        : adapter.sourceState === "unavailable"
          ? "unavailable"
          : "seed-backed";

  const timeline = buildTimeline(workItems, handoffs, memoryRecords, {
    handoffs: handoffProvenance,
    workItems: workItemsResult.provenance,
    memory: memoryProvenance,
  });

  const auditEventCount = Array.isArray(state.eventLog) ? state.eventLog.length : 0;
  const auditProvenance: MissionSnapshot["provenance"]["mission"] =
    auditEventCount > 0
      ? state.connected
        ? "live"
        : "stale"
      : state.connected
        ? "seed-backed"
        : "unavailable";
  const auditTrail = buildAuditTrail(state, auditProvenance);

  return {
    ...missionControlSeed,
    featureEnabled,
    runtimeHealth,
    pendingApprovals,
    pendingHandoffs,
    missionHealthScore: deriveMissionHealth(runtimeHealth, pendingApprovals),
    agents,
    workItems,
    handoffs,
    memoryRecords,
    timeline,
    auditTrail,
    systems: {
      sessions:
        live.provenance.sessions === "seed-backed"
          ? missionControlSeed.systems.sessions
          : live.sessions,
      approvals: {
        ...live.approvals,
        pendingCount: pendingApprovals,
      },
      cron: live.provenance.cron === "seed-backed" ? missionControlSeed.systems.cron : live.cron,
      logs: live.provenance.logs === "seed-backed" ? missionControlSeed.systems.logs : live.logs,
      models:
        live.provenance.models === "seed-backed" ? missionControlSeed.systems.models : live.models,
    },
    provenance: {
      mission: adapter.sourceState,
      workItems: workItemsResult.provenance,
      handoffs: handoffProvenance,
      memory: memoryProvenance,
      approvals: live.provenance.approvals,
      sessions: live.provenance.sessions,
      cron: live.provenance.cron,
      logs: live.provenance.logs,
      models: live.provenance.models,
    },
    adapterNotes: [...adapter.notes, ...live.notes],
    linkageCoverage: adapter.coverage,
  };
}
