import { describe, expect, it } from "vitest";
import type { AppViewState } from "../app-view-state.ts";
import { deriveLiveAdapters, parseProjectFiles } from "./adapters.ts";

function mkState(overrides: Record<string, unknown> = {}) {
  return {
    agentFilesList: null,
    agentFileContents: {},
    ...overrides,
  } as unknown as AppViewState;
}

describe("mission-control adapters provenance branches", () => {
  it("seed-backed when nothing is available", () => {
    const out = parseProjectFiles(mkState());
    expect(out.sourceState).toBe("seed-backed");
  });

  it("mixed for preloaded-only content", () => {
    const out = parseProjectFiles(
      mkState({
        agentFileContents: {
          "TASK_QUEUE.md": "- [ ] WI-1: build shell",
        },
      }),
    );
    expect(out.sourceState).toBe("mixed");
    expect(out.notes.some((n: string) => n.includes("stale"))).toBe(true);
  });

  it("live when indexed content is fresh for primary files", () => {
    const now = Date.now();
    const out = parseProjectFiles(
      mkState({
        agentFilesList: {
          files: [
            { name: "TASK_QUEUE.md", missing: false, updatedAtMs: now },
            { name: "PROJECT_MEMORY.md", missing: false, updatedAtMs: now },
            { name: "TEAM_OPERATING_MODEL.md", missing: false, updatedAtMs: now },
            { name: "PROJECT_INSTRUCTIONS.md", missing: false, updatedAtMs: now },
          ],
        },
        agentFileContents: {
          "TASK_QUEUE.md": "- [ ] WI-1: build shell",
          "PROJECT_MEMORY.md": "- M1: memory item",
          "TEAM_OPERATING_MODEL.md": "### 3) Atlas\nModes:\n- `plan`\n- `draft`",
          "PROJECT_INSTRUCTIONS.md": "instructions",
        },
      }),
    );
    expect(out.sourceState).toBe("live");
  });

  it("stale when indexed content is present but exceeds freshness window", () => {
    const stale = Date.now() - 11 * 60 * 1000;
    const out = parseProjectFiles(
      mkState({
        agentFilesList: {
          files: [
            { name: "TASK_QUEUE.md", missing: false, updatedAtMs: stale },
            { name: "PROJECT_MEMORY.md", missing: false, updatedAtMs: stale },
            { name: "TEAM_OPERATING_MODEL.md", missing: false, updatedAtMs: stale },
          ],
        },
        agentFileContents: {
          "TASK_QUEUE.md": "- [ ] WI-1: stale",
          "PROJECT_MEMORY.md": "- memory",
          "TEAM_OPERATING_MODEL.md": "### Orbit",
        },
      }),
    );
    expect(out.sourceState).toBe("stale");
  });

  it("unavailable for malformed seed json", () => {
    const out = parseProjectFiles(
      mkState({
        agentFileContents: {
          "06_seed_data.json": "{ bad json",
        },
      }),
    );
    expect(out.sourceState).toBe("unavailable");
  });
});

describe("mission-control live adapters", () => {
  it("treats loaded runtime surfaces as live and normalizes counts", () => {
    const out = deriveLiveAdapters(
      mkState({
        connected: true,
        sessionKey: " agent:forge:build ",
        sessionsResult: {
          count: -3,
          sessions: [
            { key: "agent:forge:build", kind: "direct", updatedAt: Date.now() },
            { key: "agent:forge:build", kind: "direct", updatedAt: Date.now() },
            { key: "global:main", kind: "global", updatedAt: Date.now() },
          ],
        },
        execApprovalQueue: [{ id: "req-1" }],
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
        cronStatus: { enabled: true, jobs: 3 },
        cronJobs: [{ id: "job-1", state: { lastStatus: "error" } }],
        cronRuns: [{ jobId: "job-1", ts: Date.now(), status: "error" }],
        logsFile: " /tmp/openclaw.log ",
        logsEntries: [
          { raw: "error", level: "error", time: "" },
          { raw: "info", level: "info", time: "2026-03-16T00:01:00.000Z" },
        ],
        logsLastFetchAt: Date.now(),
        chatModelCatalog: [{ id: "gpt-5", name: "GPT-5", provider: "openai" }],
        debugModels: [{ id: "claude-sonnet", name: "Claude Sonnet", provider: "anthropic" }],
      }),
    );

    expect(out.sessions).toEqual({
      count: 3,
      activeSessionKey: "agent:forge:build",
      activeAgentSessions: 2,
      recentSessionKeys: ["agent:forge:build", "global:main"],
    });
    expect(out.approvals.allowlistEntryCount).toBe(1);
    expect(out.approvals.pendingCount).toBe(1);
    expect(out.cron.failingJobCount).toBe(1);
    expect(out.cron.jobCount).toBe(3);
    expect(out.logs.errorCount).toBe(1);
    expect(out.logs.file).toBe("/tmp/openclaw.log");
    expect(out.logs.latestTimestamp).toBe("2026-03-16T00:01:00.000Z");
    expect(out.models.providers).toEqual(["anthropic", "openai"]);
    expect(out.provenance.sessions).toBe("live");
    expect(out.provenance.approvals).toBe("live");
    expect(out.provenance.cron).toBe("mixed");
    expect(out.provenance.logs).toBe("live");
    expect(out.provenance.models).toBe("live");
  });

  it("treats approvals snapshots without queue activity as mixed", () => {
    const out = deriveLiveAdapters(
      mkState({
        connected: true,
        execApprovalsSnapshot: {
          path: "exec-approvals.json",
          exists: true,
          hash: "hash",
          file: {
            agents: {
              forge: { allowlist: [{ pattern: "pnpm test" }, { pattern: "pnpm build" }] },
              review: { allowlist: [{ pattern: "git status" }] },
            },
          },
        },
      }),
    );

    expect(out.provenance.approvals).toBe("mixed");
    expect(out.approvals.pendingCount).toBe(0);
    expect(out.approvals.configuredAgentCount).toBe(2);
    expect(out.approvals.allowlistEntryCount).toBe(3);
  });

  it("falls back safely when runtime data is missing", () => {
    const out = deriveLiveAdapters(mkState({ connected: false, logsEntries: null }));
    expect(out.sessions.count).toBe(0);
    expect(out.approvals.allowlistEntryCount).toBe(0);
    expect(out.cron.jobCount).toBe(0);
    expect(out.logs.entryCount).toBe(0);
    expect(out.models.count).toBe(0);
    expect(out.provenance).toEqual({
      sessions: "unavailable",
      approvals: "unavailable",
      cron: "unavailable",
      logs: "unavailable",
      models: "unavailable",
    });
  });

  it("marks connected but loading runtime surfaces as stale", () => {
    const out = deriveLiveAdapters(
      mkState({
        connected: true,
        sessionsLoading: true,
        execApprovalsLoading: true,
        cronLoading: true,
        logsLoading: true,
        chatModelsLoading: true,
      }),
    );
    expect(out.provenance).toEqual({
      sessions: "stale",
      approvals: "stale",
      cron: "stale",
      logs: "stale",
      models: "stale",
    });
    expect(out.notes).toEqual([]);
  });

  it("marks errored cron and logs surfaces unavailable when no usable data exists", () => {
    const out = deriveLiveAdapters(
      mkState({
        connected: true,
        cronError: "cron failed",
        logsError: "logs failed",
      }),
    );

    expect(out.provenance.cron).toBe("unavailable");
    expect(out.provenance.logs).toBe("unavailable");
  });

  it("marks model hints without a live catalog as mixed", () => {
    const out = deriveLiveAdapters(
      mkState({
        connected: true,
        cronModelSuggestions: ["gpt-5.2", "gpt-5.2"],
        configForm: {
          models: {
            providers: {
              openai: { apiKey: "x" },
            },
          },
        },
      }),
    );

    expect(out.models.count).toBe(1);
    expect(out.models.providerCount).toBe(1);
    expect(out.models.providers).toEqual(["openai"]);
    expect(out.provenance.models).toBe("mixed");
  });
});
