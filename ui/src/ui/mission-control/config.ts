import { MC_AGENTS, MC_FLAG_DEFAULT, MC_STAGES } from "./canonical.ts";
import type { MissionSnapshot } from "./types.ts";

const NOW = Date.now();

export const missionControlSeed: MissionSnapshot = {
  missionName: "Mission Control Rollout",
  featureEnabled: MC_FLAG_DEFAULT,
  missionHealthScore: 82,
  stages: [...MC_STAGES] as MissionSnapshot["stages"],
  agents:
    MC_AGENTS.length > 0
      ? MC_AGENTS.map((agent) => ({
          id: agent.id as "orbit" | "scout" | "atlas" | "forge" | "review" | "vault",
          displayName: agent.displayName,
          role: agent.role,
          allowedModes: agent.allowedModes,
          currentMode: agent.defaultMode,
        }))
      : [
          {
            id: "orbit",
            displayName: "Orbit",
            role: "Orchestrator",
            allowedModes: ["orchestrate"],
            currentMode: "orchestrate",
          },
          {
            id: "scout",
            displayName: "Scout",
            role: "Research Agent",
            allowedModes: ["research"],
            currentMode: "research",
          },
          {
            id: "atlas",
            displayName: "Atlas",
            role: "Planning and Drafting Agent",
            allowedModes: ["plan", "draft"],
            currentMode: "plan",
          },
          {
            id: "forge",
            displayName: "Forge",
            role: "Execution and Coding Agent",
            allowedModes: ["execute", "code"],
            currentMode: "code",
          },
          {
            id: "review",
            displayName: "Review",
            role: "Validation and Simulation Agent",
            allowedModes: ["validate", "simulate"],
            currentMode: "validate",
          },
          {
            id: "vault",
            displayName: "Vault",
            role: "Memory and Context Agent",
            allowedModes: ["memory_retrieve", "memory_store"],
            currentMode: "memory_store",
          },
        ],
  workItems: [
    {
      id: "wi-2",
      title: "Build Mission Control shell",
      stage: "execution",
      owner: "forge",
      nextOwner: "review",
      requiredArtifact: "code_patch",
      blocked: true,
      awaitingApproval: true,
      updatedAt: NOW,
      priority: "High",
    },
  ],
  handoffs: [
    {
      id: "handoff-4",
      workItemId: "wi-2",
      from: "forge",
      to: "review",
      status: "queued",
      requiredArtifacts: ["code_patch", "validation_report"],
      linkage: "explicit",
    },
  ],
  memoryRecords: [
    {
      id: "memory-1",
      key: "team/orbit-primary-role",
      title: "Orbit orchestrates non-trivial work",
      confidence: "explicit",
      sourceRefs: ["TEAM_OPERATING_MODEL.md"],
      linkage: "explicit",
    },
  ],
  timeline: [
    {
      id: "timeline-handoff-4",
      kind: "handoff",
      title: "Forge → Review",
      detail: "Queued handoff requires code_patch, validation_report",
      ts: NOW,
      workItemId: "wi-2",
      linkage: "explicit",
      provenance: "seed-backed",
    },
  ],
  auditTrail: [
    {
      id: "audit-seed-1",
      ts: NOW,
      action: "seed.initialize",
      source: "mission-control",
      summary: "Seed audit trail active until live mutation events are available.",
      provenance: "seed-backed",
    },
  ],
  pendingApprovals: 1,
  runtimeHealth: "ok",
  pendingHandoffs: 1,
  systems: {
    sessions: {
      count: 0,
      activeSessionKey: null,
      activeAgentSessions: 0,
      recentSessionKeys: [],
    },
    approvals: {
      pendingCount: 1,
      queuedRequestCount: 0,
      configuredAgentCount: 0,
      allowlistEntryCount: 0,
      loading: false,
      dirty: false,
    },
    cron: {
      enabled: null,
      jobCount: 0,
      configuredJobCount: 0,
      runCount: 0,
      failingJobCount: 0,
    },
    logs: {
      entryCount: 0,
      errorCount: 0,
      latestTimestamp: null,
      file: null,
      truncated: false,
    },
    models: {
      count: 0,
      providerCount: 0,
      providers: [],
      loading: false,
    },
  },
  provenance: {
    mission: "seed-backed",
    workItems: "seed-backed",
    handoffs: "seed-backed",
    memory: "seed-backed",
    approvals: "mixed",
    sessions: "mixed",
    cron: "seed-backed",
    logs: "seed-backed",
    models: "seed-backed",
  },
  adapterNotes: ["Seed default active until adapters provide parsed project files."],
  linkageCoverage: {
    workItemsExplicit: 0,
    workItemsInferred: 1,
    handoffsExplicit: 1,
    handoffsInferred: 0,
    memoryExplicit: 1,
    memoryInferred: 0,
    artifactsExplicit: 0,
    artifactsInferred: 1,
  },
};
