export type MissionAgentId = "orbit" | "scout" | "atlas" | "forge" | "review" | "vault";

export type MissionStageId =
  | "intake"
  | "context"
  | "research"
  | "planning"
  | "drafting"
  | "execution"
  | "review"
  | "final_synthesis"
  | "memory_sync"
  | "done"
  | "blocked";

export type MissionPriority = "Critical" | "High" | "Medium" | "Low";

export type MissionWorkItem = {
  id: string;
  title: string;
  stage: MissionStageId;
  owner: MissionAgentId;
  nextOwner?: MissionAgentId;
  requiredArtifact?: string;
  requiredArtifactId?: string;
  artifactLinkage?: "explicit" | "inferred";
  blocked?: boolean;
  awaitingApproval?: boolean;
  reviewDebt?: boolean;
  updatedAt: number;
  priority: MissionPriority;
};

export type MissionProvenance = "live" | "mixed" | "seed-backed" | "unavailable" | "stale";

export type MissionHandoff = {
  id: string;
  workItemId: string;
  from: MissionAgentId;
  to: MissionAgentId;
  status: "queued" | "accepted" | "returned" | "completed";
  requiredArtifacts: string[];
  linkage: "explicit" | "inferred";
};

export type MissionMemoryRecord = {
  id: string;
  key: string;
  title: string;
  confidence: "explicit" | "strongly_supported";
  sourceRefs: string[];
  linkage: "explicit" | "inferred";
};

export type MissionAgentCard = {
  id: MissionAgentId;
  displayName: string;
  role: string;
  allowedModes: string[];
  currentMode?: string;
  guardrailWarnings?: string[];
};

export type MissionSessionsSignal = {
  count: number;
  activeSessionKey: string | null;
  activeAgentSessions: number;
  recentSessionKeys: string[];
};

export type MissionApprovalsSignal = {
  pendingCount: number;
  queuedRequestCount: number;
  configuredAgentCount: number;
  allowlistEntryCount: number;
  loading: boolean;
  dirty: boolean;
};

export type MissionCronSignal = {
  enabled: boolean | null;
  jobCount: number;
  configuredJobCount: number;
  runCount: number;
  failingJobCount: number;
};

export type MissionLogsSignal = {
  entryCount: number;
  errorCount: number;
  latestTimestamp: string | null;
  file: string | null;
  truncated: boolean;
};

export type MissionModelsSignal = {
  count: number;
  providerCount: number;
  providers: string[];
  loading: boolean;
};

export type MissionTimelineEvent = {
  id: string;
  kind: "handoff" | "artifact" | "memory";
  title: string;
  detail: string;
  ts: number;
  workItemId?: string;
  linkage: "explicit" | "inferred";
  provenance: MissionProvenance;
};

export type MissionAuditEntry = {
  id: string;
  ts: number;
  action: string;
  source: string;
  summary: string;
  provenance: MissionProvenance;
};

export type MissionSnapshot = {
  missionName: string;
  featureEnabled: boolean;
  stages: MissionStageId[];
  agents: MissionAgentCard[];
  workItems: MissionWorkItem[];
  handoffs: MissionHandoff[];
  memoryRecords: MissionMemoryRecord[];
  timeline: MissionTimelineEvent[];
  auditTrail: MissionAuditEntry[];
  pendingApprovals: number;
  runtimeHealth: "ok" | "degraded";
  pendingHandoffs: number;
  missionHealthScore: number;
  systems: {
    sessions: MissionSessionsSignal;
    approvals: MissionApprovalsSignal;
    cron: MissionCronSignal;
    logs: MissionLogsSignal;
    models: MissionModelsSignal;
  };
  provenance: {
    mission: MissionProvenance;
    workItems: MissionProvenance;
    handoffs: MissionProvenance;
    memory: MissionProvenance;
    approvals: MissionProvenance;
    sessions: MissionProvenance;
    cron: MissionProvenance;
    logs: MissionProvenance;
    models: MissionProvenance;
  };
  adapterNotes: string[];
  linkageCoverage: {
    workItemsExplicit: number;
    workItemsInferred: number;
    handoffsExplicit: number;
    handoffsInferred: number;
    memoryExplicit: number;
    memoryInferred: number;
    artifactsExplicit: number;
    artifactsInferred: number;
  };
};
