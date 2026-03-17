import type { AppViewState } from "../app-view-state.ts";
import type {
  MissionAgentId,
  MissionApprovalsSignal,
  MissionHandoff,
  MissionCronSignal,
  MissionLogsSignal,
  MissionMemoryRecord,
  MissionModelsSignal,
  MissionSessionsSignal,
  MissionProvenance,
  MissionWorkItem,
} from "./types.ts";

export type SourceState = "live" | "mixed" | "seed-backed" | "unavailable" | "stale";

type SourceClass = "indexed-file-content" | "preloaded-cache" | "none";
type Freshness = "fresh" | "stale" | "unknown";

type ResolvedFile = {
  name: string;
  content: string | null;
  sourceClass: SourceClass;
  authoritative: boolean;
  discoveredAt: number;
  loadedAt: number | null;
  sourceUpdatedAtMs: number | null;
  freshness: Freshness;
  staleReason: string | null;
  status: "ok" | "missing" | "malformed";
};

export type AdapterOutput = {
  workItems: MissionWorkItem[];
  handoffs: MissionHandoff[];
  memoryRecords: MissionMemoryRecord[];
  teamHints: Record<string, { allowedModes?: string[] }>;
  sourceState: SourceState;
  notes: string[];
  coverage: {
    workItemsExplicit: number;
    workItemsInferred: number;
    handoffsExplicit: number;
    handoffsInferred: number;
    memoryExplicit: number;
    memoryInferred: number;
    artifactsExplicit: number;
    artifactsInferred: number;
  };
  sourceReport: ResolvedFile[];
};

export type LiveAdapterOutput = {
  sessions: MissionSessionsSignal;
  approvals: MissionApprovalsSignal;
  cron: MissionCronSignal;
  logs: MissionLogsSignal;
  models: MissionModelsSignal;
  provenance: {
    sessions: MissionProvenance;
    approvals: MissionProvenance;
    cron: MissionProvenance;
    logs: MissionProvenance;
    models: MissionProvenance;
  };
  notes: string[];
};

const STALE_MS = 10 * 60 * 1000;

function now() {
  return Date.now();
}

function resolveIndexedMeta(state: AppViewState, filename: string) {
  return state.agentFilesList?.files?.find((f) => f.name === filename && !f.missing) ?? null;
}

function resolveFile(state: AppViewState, filename: string): ResolvedFile {
  const discoveredAt = now();
  const indexedMeta = resolveIndexedMeta(state, filename);
  const directContent = state.agentFileContents[filename];

  if (indexedMeta && typeof directContent === "string" && directContent.trim()) {
    const sourceUpdatedAtMs = indexedMeta.updatedAtMs ?? null;
    const freshness: Freshness =
      typeof sourceUpdatedAtMs === "number"
        ? discoveredAt - sourceUpdatedAtMs <= STALE_MS
          ? "fresh"
          : "stale"
        : "unknown";
    const staleReason =
      freshness === "stale"
        ? `older than ${Math.floor(STALE_MS / 60000)}m`
        : freshness === "unknown"
          ? "missing source timestamp"
          : null;

    return {
      name: filename,
      content: directContent,
      sourceClass: "indexed-file-content",
      authoritative: freshness === "fresh",
      discoveredAt,
      loadedAt: discoveredAt,
      sourceUpdatedAtMs,
      freshness,
      staleReason,
      status: "ok",
    };
  }

  const cached = Object.entries(state.agentFileContents).find(([name, content]) => {
    return name.endsWith(filename) && typeof content === "string" && content.trim();
  });

  if (cached) {
    return {
      name: filename,
      content: cached[1],
      sourceClass: "preloaded-cache",
      authoritative: false,
      discoveredAt,
      loadedAt: discoveredAt,
      sourceUpdatedAtMs: null,
      freshness: "stale",
      staleReason: "preloaded cache without indexed freshness metadata",
      status: "ok",
    };
  }

  return {
    name: filename,
    content: null,
    sourceClass: "none",
    authoritative: false,
    discoveredAt,
    loadedAt: null,
    sourceUpdatedAtMs: null,
    freshness: "unknown",
    staleReason: null,
    status: "missing",
  };
}

function parseTaskQueue(markdown: string): MissionWorkItem[] {
  const lines = markdown.split("\n");
  return lines
    .map((line, index) => ({ line: line.trim(), lineNo: index + 1 }))
    .filter((entry) => entry.line.startsWith("- ["))
    .map(({ line, lineNo }) => {
      const done = line.startsWith("- [x]") || line.startsWith("- [X]");
      const cleaned = line.replace(/^- \[[ xX]\]\s*/, "").trim();
      const explicitId = cleaned.match(/^([A-Za-z][A-Za-z0-9_-]+):\s+/)?.[1] ?? null;
      const title = explicitId ? cleaned.replace(/^([A-Za-z][A-Za-z0-9_-]+):\s+/, "") : cleaned;
      return {
        id: explicitId ?? `taskq-ln${lineNo}`,
        title,
        stage: done ? ("done" as const) : ("execution" as const),
        owner: "forge" as MissionAgentId,
        nextOwner: done ? undefined : ("review" as MissionAgentId),
        requiredArtifact: done ? "execution_output" : "code_patch",
        requiredArtifactId: undefined,
        artifactLinkage: "inferred" as const,
        blocked: false,
        awaitingApproval: false,
        reviewDebt: !done,
        updatedAt: now(),
        priority: "Medium" as const,
      };
    });
}

function parseProjectMemory(markdown: string): MissionMemoryRecord[] {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-") || line.startsWith("*"))
    .slice(0, 12)
    .map((line, idx) => {
      const body = line.replace(/^[-*]\s*/, "");
      const explicitId = body.match(/^([A-Za-z][A-Za-z0-9_-]+):\s+/)?.[1] ?? null;
      const title = explicitId ? body.replace(/^([A-Za-z][A-Za-z0-9_-]+):\s+/, "") : body;
      return {
        id: explicitId ?? `pmem-ln${idx + 1}`,
        key: `project/memory/${explicitId ?? idx + 1}`,
        title,
        confidence: "strongly_supported" as const,
        sourceRefs: ["PROJECT_MEMORY.md"],
        linkage: explicitId ? ("explicit" as const) : ("inferred" as const),
      };
    });
}

function parseTeamOperatingModel(markdown: string): Record<string, { allowedModes?: string[] }> {
  const hints: Record<string, { allowedModes?: string[] }> = {};
  const sections = markdown.split(/^###\s+/gm).map((part) => part.trim());
  for (const section of sections) {
    const lower = section.toLowerCase();
    const modes = Array.from(section.matchAll(/`([a-z_]+)`/g)).map((m) => m[1]);
    if (lower.startsWith("1) orbit") || lower.startsWith("orbit")) {
      hints.orbit = { allowedModes: modes.length ? modes : ["orchestrate"] };
    } else if (lower.startsWith("2) scout") || lower.startsWith("scout")) {
      hints.scout = { allowedModes: modes.length ? modes : ["research"] };
    } else if (lower.startsWith("3) atlas") || lower.startsWith("atlas")) {
      hints.atlas = { allowedModes: modes.length ? modes : ["plan", "draft"] };
    } else if (lower.startsWith("4) forge") || lower.startsWith("forge")) {
      hints.forge = { allowedModes: modes.length ? modes : ["execute", "code"] };
    } else if (lower.startsWith("5) review") || lower.startsWith("review")) {
      hints.review = { allowedModes: modes.length ? modes : ["validate", "simulate"] };
    } else if (lower.startsWith("6) vault") || lower.startsWith("vault")) {
      hints.vault = { allowedModes: modes.length ? modes : ["memory_retrieve", "memory_store"] };
    }
  }
  return hints;
}

function parseSeedJson(seedText: string): {
  workItems: MissionWorkItem[];
  handoffs: MissionHandoff[];
  memoryRecords: MissionMemoryRecord[];
  malformed: boolean;
  artifactCoverage: { explicit: number; inferred: number };
} {
  try {
    const parsed = JSON.parse(seedText) as {
      workItems?: Array<Record<string, unknown>>;
      handoffs?: Array<Record<string, unknown>>;
      memoryRecords?: Array<Record<string, unknown>>;
      artifacts?: Array<Record<string, unknown>>;
    };

    const artifactsById = new Map<string, Record<string, unknown>>();
    if (Array.isArray(parsed.artifacts)) {
      for (const artifact of parsed.artifacts) {
        if (typeof artifact.id === "string") {
          artifactsById.set(artifact.id, artifact);
        }
      }
    }

    let artifactsExplicit = 0;
    let artifactsInferred = 0;

    const workItems: MissionWorkItem[] = Array.isArray(parsed.workItems)
      ? parsed.workItems
          .filter((item) => typeof item.id === "string" && typeof item.title === "string")
          .map((item) => {
            const producedIds = Array.isArray(item.producedArtifactIds)
              ? item.producedArtifactIds.map((v) => String(v)).filter((v) => artifactsById.has(v))
              : [];
            const explicitArtifactId = producedIds[0] ?? undefined;
            if (explicitArtifactId) {
              artifactsExplicit += 1;
            } else {
              artifactsInferred += 1;
            }
            const stage =
              typeof item.stage === "string"
                ? (item.stage as MissionWorkItem["stage"])
                : "execution";
            const owner =
              typeof item.ownerAgentId === "string"
                ? (item.ownerAgentId as MissionAgentId)
                : "forge";
            const nextOwner =
              typeof item.nextAgentId === "string"
                ? (item.nextAgentId as MissionAgentId)
                : undefined;
            const requiredArtifact = Array.isArray(item.requiredArtifacts)
              ? String(item.requiredArtifacts[0] ?? "artifact")
              : undefined;
            return {
              id: String(item.id),
              title: String(item.title),
              stage,
              owner,
              nextOwner,
              requiredArtifact,
              requiredArtifactId: explicitArtifactId,
              artifactLinkage: explicitArtifactId ? ("explicit" as const) : ("inferred" as const),
              blocked: Array.isArray(item.blockerIds) ? item.blockerIds.length > 0 : false,
              awaitingApproval: Array.isArray(item.approvalIds)
                ? item.approvalIds.length > 0
                : false,
              reviewDebt: item.needsReview === true,
              updatedAt: now(),
              priority: "High",
            };
          })
      : [];

    const handoffs: MissionHandoff[] = Array.isArray(parsed.handoffs)
      ? parsed.handoffs
          .filter((item) => typeof item.id === "string" && typeof item.workItemId === "string")
          .map((item) => {
            const from =
              typeof item.fromAgentId === "string" ? (item.fromAgentId as MissionAgentId) : "forge";
            const to =
              typeof item.toAgentId === "string" ? (item.toAgentId as MissionAgentId) : "review";
            const status =
              typeof item.status === "string"
                ? (item.status as MissionHandoff["status"])
                : "queued";
            return {
              id: String(item.id),
              workItemId: String(item.workItemId),
              from,
              to,
              status,
              requiredArtifacts: Array.isArray(item.requiredArtifacts)
                ? item.requiredArtifacts.map((v) => String(v))
                : [],
              linkage: "explicit",
            };
          })
      : [];

    const memoryRecords: MissionMemoryRecord[] = Array.isArray(parsed.memoryRecords)
      ? parsed.memoryRecords
          .filter((item) => typeof item.id === "string" && typeof item.key === "string")
          .map((item) => ({
            id: String(item.id),
            key: String(item.key),
            title: String(item.title ?? item.key),
            confidence: item.confidence === "explicit" ? "explicit" : "strongly_supported",
            sourceRefs: Array.isArray(item.sourceRefs) ? item.sourceRefs.map((v) => String(v)) : [],
            linkage: "explicit",
          }))
      : [];

    return {
      workItems,
      handoffs,
      memoryRecords,
      malformed: false,
      artifactCoverage: { explicit: artifactsExplicit, inferred: artifactsInferred },
    };
  } catch {
    return {
      workItems: [],
      handoffs: [],
      memoryRecords: [],
      malformed: true,
      artifactCoverage: { explicit: 0, inferred: 0 },
    };
  }
}

export function parseProjectFiles(state: AppViewState): AdapterOutput {
  const taskQueue = resolveFile(state, "TASK_QUEUE.md");
  const projectMemory = resolveFile(state, "PROJECT_MEMORY.md");
  const teamModel = resolveFile(state, "TEAM_OPERATING_MODEL.md");
  const instructions = resolveFile(state, "PROJECT_INSTRUCTIONS.md");
  const seedData = resolveFile(state, "06_seed_data.json");

  const seedParsed =
    seedData.content !== null
      ? parseSeedJson(seedData.content)
      : {
          workItems: [],
          handoffs: [],
          memoryRecords: [],
          malformed: false,
          artifactCoverage: { explicit: 0, inferred: 0 },
        };

  const taskQueueItems = taskQueue.content ? parseTaskQueue(taskQueue.content) : [];
  const memoryFromMd = projectMemory.content ? parseProjectMemory(projectMemory.content) : [];
  const teamHints = teamModel.content ? parseTeamOperatingModel(teamModel.content) : {};

  const workItems = seedParsed.workItems.length > 0 ? seedParsed.workItems : taskQueueItems;
  const handoffs = seedParsed.handoffs;
  const memoryRecords =
    seedParsed.memoryRecords.length > 0 ? seedParsed.memoryRecords : memoryFromMd;

  const resolved = [taskQueue, projectMemory, teamModel, instructions, seedData];
  const authoritativeCount = resolved.filter((f) => f.authoritative).length;
  const anyMalformed = seedParsed.malformed;
  const anyReadable = resolved.some((f) => f.content !== null);
  const hasStaleIndexed = resolved.some(
    (f) => f.sourceClass === "indexed-file-content" && f.freshness === "stale",
  );

  const sourceState: SourceState = anyMalformed
    ? "unavailable"
    : authoritativeCount >= 3
      ? "live"
      : hasStaleIndexed
        ? "stale"
        : anyReadable
          ? "mixed"
          : "seed-backed";

  const notes: string[] = [];
  for (const file of resolved) {
    if (file.status === "missing") {
      notes.push(`${file.name} missing`);
    }
    if (file.freshness === "stale") {
      notes.push(`${file.name} stale (${file.staleReason ?? "unknown reason"})`);
    }
    if (file.freshness === "unknown" && file.sourceClass !== "none") {
      notes.push(`${file.name} freshness unknown`);
    }
  }
  if (seedParsed.malformed) {
    notes.push("06_seed_data.json malformed; adapter marked unavailable");
  }

  const coverage = {
    workItemsExplicit: workItems.filter((w) => !w.id.startsWith("taskq-ln")).length,
    workItemsInferred: workItems.filter((w) => w.id.startsWith("taskq-ln")).length,
    handoffsExplicit: handoffs.filter((h) => h.linkage === "explicit").length,
    handoffsInferred: handoffs.filter((h) => h.linkage === "inferred").length,
    memoryExplicit: memoryRecords.filter((m) => m.linkage === "explicit").length,
    memoryInferred: memoryRecords.filter((m) => m.linkage === "inferred").length,
    artifactsExplicit: seedParsed.artifactCoverage.explicit,
    artifactsInferred:
      seedParsed.artifactCoverage.inferred +
      taskQueueItems.filter((w) => !w.requiredArtifactId).length,
  };

  return {
    workItems,
    handoffs,
    memoryRecords,
    teamHints,
    sourceState,
    notes,
    coverage,
    sourceReport: resolved,
  };
}

function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNonNegativeInt(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function classifyLiveSignal(params: {
  connected: boolean;
  hasData: boolean;
  loading?: boolean;
  error?: string | null;
  allowSeedBacked?: boolean;
}): MissionProvenance {
  if (params.hasData) {
    return params.connected ? (params.error ? "mixed" : "live") : "stale";
  }
  if (params.loading) {
    return "stale";
  }
  if (params.allowSeedBacked && params.connected && !params.error) {
    return "seed-backed";
  }
  return "unavailable";
}

function deriveSessions(state: AppViewState): {
  value: MissionSessionsSignal;
  provenance: MissionProvenance;
} {
  const hasSessionsResult = state.sessionsResult != null;
  const rows = Array.isArray(state.sessionsResult?.sessions) ? state.sessionsResult.sessions : [];
  const count = asNonNegativeInt(state.sessionsResult?.count, rows.length);
  const activeAgentSessions = rows.filter((row) =>
    asTrimmedString(row?.key)?.startsWith("agent:"),
  ).length;
  const recentSessionKeys = Array.from(
    new Set(
      rows.map((row) => asTrimmedString(row?.key)).filter((key): key is string => key !== null),
    ),
  ).slice(0, 3);
  const provenance = classifyLiveSignal({
    connected: state.connected,
    hasData: hasSessionsResult,
    loading: state.sessionsLoading,
    error: state.sessionsError,
  });
  return {
    value: {
      count,
      activeSessionKey: asTrimmedString(state.sessionKey),
      activeAgentSessions,
      recentSessionKeys,
    },
    provenance,
  };
}

function deriveApprovals(state: AppViewState): {
  value: MissionApprovalsSignal;
  provenance: MissionProvenance;
} {
  const queue = Array.isArray(state.execApprovalQueue) ? state.execApprovalQueue : [];
  const agents = state.execApprovalsSnapshot?.file?.agents;
  const configuredAgents = agents && typeof agents === "object" ? Object.values(agents) : [];
  const allowlistEntryCount = configuredAgents.reduce((total, agent) => {
    return total + asNonNegativeInt(Array.isArray(agent?.allowlist) ? agent.allowlist.length : 0);
  }, 0);
  const hasSnapshot = state.execApprovalsSnapshot != null;
  const provenance: MissionProvenance =
    queue.length > 0
      ? "live"
      : hasSnapshot
        ? state.connected
          ? "mixed"
          : "stale"
        : classifyLiveSignal({
            connected: state.connected,
            hasData: false,
            loading: state.execApprovalsLoading,
            allowSeedBacked: true,
          });
  return {
    value: {
      pendingCount: asNonNegativeInt(queue.length),
      queuedRequestCount: asNonNegativeInt(queue.length),
      configuredAgentCount: asNonNegativeInt(configuredAgents.length),
      allowlistEntryCount,
      loading: Boolean(state.execApprovalsLoading),
      dirty: Boolean(state.execApprovalsDirty),
    },
    provenance,
  };
}

function deriveCron(state: AppViewState): {
  value: MissionCronSignal;
  provenance: MissionProvenance;
} {
  const hasJobsSurface = Array.isArray(state.cronJobs);
  const hasRunsSurface = Array.isArray(state.cronRuns);
  const jobs = hasJobsSurface ? state.cronJobs : [];
  const runs = hasRunsSurface ? state.cronRuns : [];
  const failingJobCount = jobs.filter((job) => job.state?.lastStatus === "error").length;
  const hasStatus = state.cronStatus != null;
  const hasData = hasStatus || jobs.length > 0 || runs.length > 0;
  const baseProvenance = classifyLiveSignal({
    connected: state.connected,
    hasData,
    loading: state.cronLoading || state.cronJobsLoadingMore || state.cronRunsLoadingMore,
    error: state.cronError,
  });
  const provenance =
    baseProvenance === "live" &&
    ((hasStatus && state.cronStatus?.jobs != null && state.cronStatus.jobs !== jobs.length) ||
      (hasStatus && jobs.length === 0 && runs.length === 0) ||
      (!hasStatus && (jobs.length > 0 || runs.length > 0)))
      ? "mixed"
      : baseProvenance;
  return {
    value: {
      enabled: state.cronStatus?.enabled ?? null,
      jobCount: asNonNegativeInt(state.cronStatus?.jobs, jobs.length),
      configuredJobCount: asNonNegativeInt(jobs.length),
      runCount: asNonNegativeInt(runs.length),
      failingJobCount: asNonNegativeInt(failingJobCount),
    },
    provenance,
  };
}

function deriveLogs(state: AppViewState): {
  value: MissionLogsSignal;
  provenance: MissionProvenance;
} {
  const hasEntriesSurface = Array.isArray(state.logsEntries);
  const entries = hasEntriesSurface ? state.logsEntries : [];
  const latestTimestamp =
    entries.map((entry) => asTrimmedString(entry?.time)).find((value) => value !== null) ?? null;
  const errorCount = entries.filter(
    (entry) => entry.level === "error" || entry.level === "fatal",
  ).length;
  const hasData = entries.length > 0 || state.logsFile != null || state.logsLastFetchAt != null;
  const provenance = classifyLiveSignal({
    connected: state.connected,
    hasData,
    loading: state.logsLoading,
    error: state.logsError,
  });
  return {
    value: {
      entryCount: asNonNegativeInt(entries.length),
      errorCount: asNonNegativeInt(errorCount),
      latestTimestamp,
      file: asTrimmedString(state.logsFile),
      truncated: Boolean(state.logsTruncated),
    },
    provenance,
  };
}

function deriveConfiguredModelProviders(state: AppViewState): string[] {
  const models = (state.configForm as { models?: { providers?: unknown } } | null)?.models;
  if (!models || typeof models.providers !== "object" || models.providers === null) {
    return [];
  }
  return Object.entries(models.providers)
    .filter(([, value]) => value && typeof value === "object")
    .map(([key]) => key.trim())
    .filter(Boolean)
    .toSorted();
}

function deriveModels(state: AppViewState): {
  value: MissionModelsSignal;
  provenance: MissionProvenance;
} {
  const hasCatalogSurface = Array.isArray(state.chatModelCatalog);
  const hasDebugSurface = Array.isArray(state.debugModels);
  const catalog = hasCatalogSurface ? state.chatModelCatalog : [];
  const debugModels = hasDebugSurface ? state.debugModels : [];
  const suggestions = Array.isArray(state.cronModelSuggestions)
    ? state.cronModelSuggestions.map((value) => value.trim()).filter(Boolean)
    : [];
  const configuredProviders = deriveConfiguredModelProviders(state);
  const merged = new Map<string, string>();
  for (const model of [...catalog, ...debugModels]) {
    const id = asTrimmedString(model?.id) ?? "";
    if (!id) {
      continue;
    }
    const provider = asTrimmedString(model?.provider) ?? "";
    merged.set(id, provider);
  }
  for (const id of suggestions) {
    if (!merged.has(id)) {
      merged.set(id, "");
    }
  }
  const providers = Array.from(
    new Set(
      Array.from(merged.values())
        .map((provider) => provider.trim())
        .filter(Boolean),
    ),
  ).toSorted();
  const hasCatalog = catalog.length > 0;
  const hasDebug = debugModels.length > 0;
  const hasLiveCatalog = hasCatalog || hasDebug;
  const hasHints = suggestions.length > 0 || configuredProviders.length > 0;
  const hasData = merged.size > 0 || configuredProviders.length > 0;
  const provenance =
    hasLiveCatalog || !hasHints
      ? classifyLiveSignal({
          connected: state.connected,
          hasData,
          loading: state.chatModelsLoading || state.debugLoading,
        })
      : state.connected
        ? "mixed"
        : "stale";
  return {
    value: {
      count: asNonNegativeInt(merged.size),
      providerCount: asNonNegativeInt(Math.max(providers.length, configuredProviders.length)),
      providers: Array.from(new Set([...providers, ...configuredProviders])).toSorted(),
      loading: Boolean(state.chatModelsLoading || state.debugLoading),
    },
    provenance,
  };
}

export function deriveLiveAdapters(state: AppViewState): LiveAdapterOutput {
  const sessions = deriveSessions(state);
  const approvals = deriveApprovals(state);
  const cron = deriveCron(state);
  const logs = deriveLogs(state);
  const models = deriveModels(state);

  const notes: string[] = [];
  if (sessions.provenance === "seed-backed") {
    notes.push("Sessions not loaded yet; Mission Control is using fallback session state.");
  }
  if (approvals.provenance === "seed-backed") {
    notes.push("Approvals snapshot unavailable; pending approval count is fallback-backed.");
  }
  if (cron.provenance === "seed-backed") {
    notes.push("Cron state not loaded yet.");
  }
  if (logs.provenance === "seed-backed") {
    notes.push("Logs have not been fetched yet.");
  }
  if (models.provenance === "seed-backed") {
    notes.push("Model catalog not loaded yet.");
  }

  return {
    sessions: sessions.value,
    approvals: approvals.value,
    cron: cron.value,
    logs: logs.value,
    models: models.value,
    provenance: {
      sessions: sessions.provenance,
      approvals: approvals.provenance,
      cron: cron.provenance,
      logs: logs.provenance,
      models: models.provenance,
    },
    notes,
  };
}
