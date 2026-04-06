import { render } from "lit";
import { describe, expect, it } from "vitest";
import type {
  ClawAuditEntry,
  ClawControlState,
  ClawMissionDetail,
  ClawMissionSummary,
  ClawPendingDecision,
  ClawPreflightCheck,
} from "../../../../src/shared/claw-types.js";
import { renderClaw, type ClawViewProps } from "./claw.ts";

function createControl(): ClawControlState {
  return {
    autonomyEnabled: true,
    pauseAll: false,
    stopAllNowRequestedAt: null,
    updatedAt: "2026-04-05T10:00:00.000Z",
  };
}

function createPreflight(overrides: Partial<ClawPreflightCheck> = {}): ClawPreflightCheck {
  return {
    id: "browser-runtime",
    category: "browser",
    title: "Browser automation availability",
    status: "ready",
    summary: "Browser control is healthy and ready for browser-backed missions.",
    detail: null,
    blocker: false,
    ...overrides,
  };
}

function createDecision(overrides: Partial<ClawPendingDecision> = {}): ClawPendingDecision {
  return {
    id: "decision-1",
    kind: "start_approval",
    title: "Approve unattended continuation",
    summary:
      "Review the generated mission packet and approve once to let Claw continue autonomously.",
    requestedAt: "2026-04-05T10:00:00.000Z",
    status: "pending",
    ...overrides,
  };
}

function createMissionSummary(overrides: Partial<ClawMissionSummary> = {}): ClawMissionSummary {
  return {
    id: "mission-1",
    title: "Claw mission",
    goal: "Implement the requested Claw mission behavior.",
    status: "awaiting_approval",
    continuationPhase: null,
    createdAt: "2026-04-05T10:00:00.000Z",
    updatedAt: "2026-04-05T10:05:00.000Z",
    approvedAt: null,
    startedAt: null,
    endedAt: null,
    workspaceDir: "/workspace",
    missionDir: "/workspace/missions/mission-1",
    flowId: "flow-1",
    flowRevision: 1,
    flowStatus: "waiting",
    currentStep: "Awaiting approval for unattended continuation.",
    blockedSummary: null,
    requiresAttention: true,
    ...overrides,
  };
}

function createMission(overrides: Partial<ClawMissionDetail> = {}): ClawMissionDetail {
  const summary = createMissionSummary(overrides);
  return {
    ...summary,
    preflight: [createPreflight()],
    decisions: [createDecision()],
    files: [
      { name: "MISSION.md", path: "/workspace/missions/mission-1/MISSION.md", kind: "markdown" },
      {
        name: "PROJECT_PLAN.md",
        path: "/workspace/missions/mission-1/PROJECT_PLAN.md",
        kind: "markdown",
      },
    ],
    packet: {
      source: "planned",
      summary: "Ship the Claw mission flow end to end.",
      scopeIn: ["Mission runtime", "Gateway-backed mission UI"],
      scopeOut: ["New operator channels"],
      phases: ["Plan the mission packet", "Execute the runtime", "Verify the result"],
      tasks: ["Generate the mission packet", "Run the persistent mission loop"],
      doneCriteria: ["Verifier confirms the packet and runtime behavior"],
      lifecycleNote:
        "Mission packet planning and preflight may already have inspected or changed state before unattended continuation is approved.",
    },
    artifactsDir: "/workspace/missions/mission-1/artifacts",
    logsDir: "/workspace/missions/mission-1/logs",
    auditLogPath: "/workspace/missions/mission-1/AUDIT_LOG.jsonl",
    auditCount: 0,
    ...overrides,
  };
}

function createProps(overrides: Partial<ClawViewProps> = {}): ClawViewProps {
  const mission = createMission();
  return {
    loading: false,
    error: null,
    createBusy: false,
    actionBusy: false,
    goalDraft: "",
    missions: [mission],
    mission,
    selectedMissionId: mission.id,
    control: createControl(),
    inbox: [],
    auditLoading: false,
    auditEntries: [],
    auditFilters: {
      role: "",
      toolName: "",
      sideEffectClass: "",
      outcome: "",
    },
    artifactsLoading: false,
    artifacts: [],
    onGoalDraftChange: () => undefined,
    onCreateMission: () => undefined,
    onSelectMission: () => undefined,
    onApproveMission: () => undefined,
    onPauseMission: () => undefined,
    onResumeMission: () => undefined,
    onCancelMission: () => undefined,
    onRerunPreflight: () => undefined,
    onReplyDecision: () => undefined,
    onPauseAll: () => undefined,
    onSetAuditFilter: () => undefined,
    onStopAllNow: () => undefined,
    onSetAutonomy: () => undefined,
    onRefresh: () => undefined,
    ...overrides,
  };
}

describe("claw view", () => {
  it("shows unattended-continuation approval wording and packet sections", () => {
    const container = document.createElement("div");
    render(renderClaw(createProps()), container);
    const normalizedText = container.textContent?.replace(/\s+/g, " ").trim() ?? "";

    expect(normalizedText).toContain("unattended-continuation approval");
    expect(normalizedText).toContain(
      "Approval lets Claw continue autonomously without routine check-ins.",
    );
    expect(normalizedText).toContain("Scope & Plan");
    expect(normalizedText).toContain("Tasks & Verification");
    expect(normalizedText).toContain("Logs & Files");
    expect(normalizedText).toContain("Ship the Claw mission flow end to end.");
    expect(normalizedText).toContain("Verifier confirms the packet and runtime behavior");

    const approveButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Approve Continuation",
    );
    expect(approveButton).not.toBeUndefined();
    expect(approveButton?.disabled).toBe(false);
  });

  it("disables generic resume while recovery uncertainty is pending", () => {
    const container = document.createElement("div");
    const mission = createMission({
      status: "blocked",
      continuationPhase: "recovering",
      currentStep: "Awaiting operator confirmation before resuming recovery.",
      blockedSummary: "Recovery may replay partially completed verifier work.",
      decisions: [
        createDecision({
          kind: "recovery_uncertain",
          title: "Confirm recovery continuation",
          summary: "Recovery may replay partially completed verifier work.",
        }),
      ],
    });
    render(
      renderClaw(
        createProps({
          mission,
          missions: [mission],
          selectedMissionId: mission.id,
        }),
      ),
      container,
    );

    const resumeButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Resume",
    );
    expect(resumeButton).not.toBeUndefined();
    expect(resumeButton?.disabled).toBe(true);
    expect(container.textContent).toContain("Confirm recovery continuation");
    expect(container.textContent).toContain("Continue");
    expect(container.textContent).toContain("Pause");
    expect(container.textContent).toContain("Cancel");
  });

  it("renders audit metadata and applies audit filters", () => {
    const container = document.createElement("div");
    const auditEntries: ClawAuditEntry[] = [
      {
        id: "audit-1",
        missionId: "mission-1",
        at: "2026-04-05T10:00:00.000Z",
        actor: "system",
        role: "runner",
        phase: "running",
        type: "mission.runnerCycle",
        actionType: "mission.runnerCycle",
        toolName: "embedded_agent",
        targetSummary: "Run the mission loop",
        sideEffectClass: "local_mutation",
        intentSummary: "Runner advanced the mission",
        outcome: "completed",
        errorSummary: null,
        artifactRefs: [],
        checkpointRevision: 2,
        summary: "Runner advanced the mission",
        detail: null,
      },
      {
        id: "audit-2",
        missionId: "mission-1",
        at: "2026-04-05T10:01:00.000Z",
        actor: "system",
        role: "verifier",
        phase: "verifying",
        type: "mission.verifierCycle",
        actionType: "mission.verifierCycle",
        toolName: "embedded_agent",
        targetSummary: "Verify the done criteria",
        sideEffectClass: "local_mutation",
        intentSummary: "Verifier checked the done criteria",
        outcome: "completed",
        errorSummary: null,
        artifactRefs: [],
        checkpointRevision: 3,
        summary: "Verifier checked the done criteria",
        detail: null,
      },
    ];
    render(
      renderClaw(
        createProps({
          auditEntries,
          auditFilters: {
            role: "verifier",
            toolName: "",
            sideEffectClass: "",
            outcome: "",
          },
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Role");
    expect(container.textContent).toContain("Outcome");
    expect(container.textContent).toContain("Verifier checked the done criteria");
    expect(container.textContent).not.toContain("Runner advanced the mission");
  });
});
