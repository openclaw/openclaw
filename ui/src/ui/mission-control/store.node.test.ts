import { describe, expect, it } from "vitest";
import type { AppViewState } from "../app-view-state.ts";
import { buildMissionSnapshot } from "./store.ts";

function mkState(overrides: Record<string, unknown> = {}) {
  return {
    configForm: null,
    connected: true,
    lastError: null,
    execApprovalQueue: [],
    execApprovalsSnapshot: null,
    sessionsResult: null,
    eventLog: [],
    agentFilesList: null,
    agentFileContents: {},
    ...overrides,
  } as unknown as AppViewState;
}

describe("mission-control store derivation", () => {
  it("marks approvals live when queue exists", () => {
    const snap = buildMissionSnapshot(mkState({ execApprovalQueue: [{ id: "a1" }] }));
    expect(snap.provenance.approvals).toBe("live");
    expect(snap.systems.approvals.pendingCount).toBe(1);
  });

  it("marks approvals mixed when only the approvals snapshot is loaded", () => {
    const snap = buildMissionSnapshot(
      mkState({
        execApprovalsSnapshot: {
          path: "exec-approvals.json",
          exists: true,
          hash: "hash",
          file: {
            agents: {
              forge: { allowlist: [{ pattern: "pnpm test" }] },
            },
          },
        },
      }),
    );
    expect(snap.provenance.approvals).toBe("mixed");
    expect(snap.systems.approvals.allowlistEntryCount).toBe(1);
  });

  it("marks sessions live when session list exists", () => {
    const snap = buildMissionSnapshot(
      mkState({ sessionsResult: { sessions: [{ key: "agent:review:validate" }] } }),
    );
    expect(snap.provenance.sessions).toBe("live");
    expect(snap.systems.sessions.activeAgentSessions).toBe(1);
  });

  it("marks sessions unavailable when disconnected without live session data", () => {
    const snap = buildMissionSnapshot(mkState({ connected: false, sessionsResult: null }));
    expect(snap.provenance.sessions).toBe("unavailable");
  });

  it("marks approvals stale while approvals data is still loading", () => {
    const snap = buildMissionSnapshot(mkState({ execApprovalsLoading: true }));
    expect(snap.provenance.approvals).toBe("stale");
    expect(snap.pendingApprovals).toBe(0);
  });

  it("exposes normalized live systems state for mission systems view", () => {
    const snap = buildMissionSnapshot(
      mkState({
        sessionsResult: {
          count: 1,
          sessions: [{ key: "agent:review:validate", kind: "direct", updatedAt: Date.now() }],
        },
        cronStatus: { enabled: true, jobs: 2 },
        cronJobs: [{ id: "job-1", state: { lastStatus: "error" } }],
        logsFile: "/tmp/openclaw.log",
        logsEntries: [{ raw: "fatal", level: "fatal", time: "2026-03-16T00:00:00.000Z" }],
        logsLastFetchAt: Date.now(),
        chatModelCatalog: [{ id: "gpt-5", name: "GPT-5", provider: "openai" }],
      }),
    );

    expect(snap.systems.sessions.count).toBe(1);
    expect(snap.systems.cron.jobCount).toBe(2);
    expect(snap.systems.logs.errorCount).toBe(1);
    expect(snap.systems.models.count).toBe(1);
    expect(snap.provenance.cron).toBe("mixed");
    expect(snap.provenance.logs).toBe("live");
    expect(snap.provenance.models).toBe("live");
  });

  it("does not invent approval counts when live approval state is unavailable", () => {
    const snap = buildMissionSnapshot(mkState({ connected: false }));
    expect(snap.pendingApprovals).toBe(0);
    expect(snap.systems.approvals.pendingCount).toBe(0);
    expect(snap.provenance.approvals).toBe("unavailable");
  });

  it("degrades mission score when runtime degraded", () => {
    const ok = buildMissionSnapshot(mkState({ connected: true }));
    const bad = buildMissionSnapshot(mkState({ connected: false }));
    expect(bad.missionHealthScore).toBeLessThan(ok.missionHealthScore);
  });

  it("marks unloaded runtime slices unavailable until they are hydrated", () => {
    const snap = buildMissionSnapshot(mkState({ connected: true }));
    expect(snap.provenance.sessions).toBe("unavailable");
    expect(snap.provenance.cron).toBe("unavailable");
    expect(snap.provenance.logs).toBe("unavailable");
    expect(snap.provenance.models).toBe("unavailable");
    expect(snap.systems.cron).toEqual({
      enabled: null,
      jobCount: 0,
      configuredJobCount: 0,
      runCount: 0,
      failingJobCount: 0,
    });
    expect(snap.systems.logs.entryCount).toBe(0);
    expect(snap.systems.models.count).toBe(0);
  });

  it("preserves live runtime systems when adapters are loaded", () => {
    const snap = buildMissionSnapshot(
      mkState({
        connected: true,
        sessionsResult: {
          count: 2,
          sessions: [
            { key: "agent:forge:build", kind: "direct", updatedAt: Date.now() },
            { key: "global:main", kind: "global", updatedAt: Date.now() },
          ],
        },
        execApprovalQueue: [{ id: "req-1" }],
        cronStatus: { enabled: true, jobs: 2 },
        cronJobs: [{ id: "job-1", state: { lastStatus: "error" } }, { id: "job-2" }],
        cronRuns: [{ jobId: "job-1", ts: Date.now(), status: "error" }],
        logsEntries: [{ raw: "fatal", level: "fatal", time: "2026-03-16T00:00:00.000Z" }],
        logsFile: "/tmp/openclaw.log",
        chatModelCatalog: [{ id: "gpt-5", name: "GPT-5", provider: "openai" }],
        debugModels: [{ id: "claude-sonnet", name: "Claude Sonnet", provider: "anthropic" }],
      }),
    );

    expect(snap.provenance.sessions).toBe("live");
    expect(snap.provenance.approvals).toBe("live");
    expect(snap.provenance.cron).toBe("live");
    expect(snap.provenance.logs).toBe("live");
    expect(snap.provenance.models).toBe("live");
    expect(snap.systems.cron.failingJobCount).toBe(1);
    expect(snap.systems.logs.errorCount).toBe(1);
    expect(snap.systems.models.providerCount).toBe(2);
  });

  it("marks errored cron and logs slices unavailable when nothing usable was loaded", () => {
    const snap = buildMissionSnapshot(
      mkState({
        cronError: "cron failed",
        logsError: "logs failed",
      }),
    );
    expect(snap.provenance.cron).toBe("unavailable");
    expect(snap.provenance.logs).toBe("unavailable");
  });

  it("builds timeline with handoff, artifact, and memory events", () => {
    const snap = buildMissionSnapshot(
      mkState({
        agentFileContents: {
          "TASK_QUEUE.md": "- [ ] WI-1: build shell",
          "PROJECT_MEMORY.md": "- memory item",
        },
      }),
    );
    const kinds = new Set(snap.timeline.map((event) => event.kind));
    expect(kinds.has("handoff")).toBe(true);
    expect(kinds.has("artifact")).toBe(true);
    expect(kinds.has("memory")).toBe(true);
  });

  it("carries provenance metadata onto timeline events", () => {
    const snap = buildMissionSnapshot(mkState({ connected: false, sessionsResult: null }));
    expect(
      snap.timeline.every((event) =>
        ["live", "mixed", "seed-backed", "unavailable", "stale"].includes(event.provenance),
      ),
    ).toBe(true);
  });

  it("builds audit entries from dashboard mutation events", () => {
    const snap = buildMissionSnapshot(
      mkState({
        eventLog: [
          { ts: Date.now(), event: "config.apply", payload: { changed: true } },
          { ts: Date.now() - 10, event: "presence", payload: {} },
        ],
      }),
    );
    expect(snap.auditTrail.length).toBeGreaterThan(0);
    expect(snap.auditTrail[0]?.action).toBe("config.apply");
  });

  it("uses seed audit trail when mutation events are absent", () => {
    const snap = buildMissionSnapshot(mkState({ eventLog: [] }));
    expect(snap.auditTrail[0]?.action).toBe("seed.initialize");
  });
});
