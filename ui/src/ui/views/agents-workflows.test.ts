import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CronJob, GatewaySessionRow, SessionsListResult } from "../types.ts";
import type { AgentRoomSessionsState } from "./agents-room.ts";
import {
  WORKFLOW_MAPS,
  dropWorkflowStepBefore,
  moveWorkflowStepOrder,
  renderAgentWorkflows,
  resolveOrderedWorkflowStepIds,
} from "./agents-workflows.ts";

function sessionState(sessions: GatewaySessionRow[]): AgentRoomSessionsState {
  return {
    loading: false,
    error: null,
    result: {
      ts: Date.now(),
      path: "/sessions",
      count: sessions.length,
      defaults: {},
      sessions,
    } as SessionsListResult,
  };
}

function cronJob(overrides: Partial<CronJob>): CronJob {
  return {
    id: "job",
    name: "Workflow job",
    enabled: true,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    schedule: { kind: "every", everyMs: 60_000 } as never,
    sessionTarget: { kind: "main" } as never,
    wakeMode: "always" as never,
    payload: { kind: "agentTurn", message: "Workflow probe" } as never,
    ...overrides,
  };
}

describe("agent workflow maps", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("defines the Live Agent Workspace project workflow categories", () => {
    expect(WORKFLOW_MAPS.map((map) => map.label)).toEqual([
      "Shared Command",
      "Prediction Markets",
      "YouTube Content Engine",
      "Product and Build Lab",
      "Executive and Personal Ops",
      "Music Studio",
    ]);

    for (const map of WORKFLOW_MAPS) {
      expect(map.steps.length, map.id).toBeGreaterThan(0);
      for (const step of map.steps) {
        expect(step.agents.length, step.id).toBeGreaterThan(0);
        expect(step.programs.length, step.id).toBeGreaterThan(0);
        expect(step.approval.trim(), step.id).not.toBe("");
        expect(step.handoff.trim(), step.id).not.toBe("");
      }
    }
  });

  it("keeps custom workflow order stable while appending missing default steps", () => {
    const ordered = resolveOrderedWorkflowStepIds("markets", {
      markets: ["markets-risk", "markets-watch", "unknown-step"],
    });

    expect(ordered.slice(0, 2)).toEqual(["markets-risk", "markets-watch"]);
    expect(ordered).toContain("markets-research");
    expect(ordered).not.toContain("unknown-step");
  });

  it("moves and drops workflow steps deterministically", () => {
    expect(moveWorkflowStepOrder("youtube", {}, "youtube-brief", "back").slice(0, 2)).toEqual([
      "youtube-brief",
      "youtube-trends",
    ]);
    expect(dropWorkflowStepBefore("youtube", {}, "youtube-publish-learn", "youtube-brief")).toEqual(
      ["youtube-trends", "youtube-publish-learn", "youtube-brief", "youtube-package"],
    );
  });

  it("renders selectable visual workflow cards with Codex and program context", async () => {
    const container = document.createElement("div");
    const selectRoom = vi.fn();
    const selectStep = vi.fn();
    const orderChange = vi.fn();

    render(
      renderAgentWorkflows({
        agents: [
          { id: "main", name: "Control Director" } as never,
          { id: "codex", name: "Codex" } as never,
        ],
        workflowMaps: {
          selectedRoomId: "core",
          selectedStepId: "core-codex",
          orders: {},
        },
        onSelectRoom: selectRoom,
        onSelectStep: selectStep,
        onOrderChange: orderChange,
        onResetRoom: () => undefined,
      }),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("OpenClaw Agent Workflow Maps");
    expect(container.textContent).toContain("Codex implementation gate");
    expect(container.textContent).toContain("Codex only by explicit summon");
    expect(container.textContent).toContain("pnpm tests");

    container.querySelector<HTMLElement>(".agent-workflows-rooms button:nth-child(2)")?.click();
    expect(selectRoom).toHaveBeenCalledWith("markets");

    container
      .querySelector<HTMLElement>(".agent-workflow-step__actions button:last-child")
      ?.click();
    expect(orderChange).toHaveBeenCalledWith("core", [
      "core-route",
      "core-intake",
      "core-memory",
      "core-codex",
    ]);
  });

  it("surfaces active session signals and inspection guidance for selected workflow steps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-07T16:00:00Z"));
    const container = document.createElement("div");

    render(
      renderAgentWorkflows({
        agents: [
          { id: "main", name: "Todd Stanski" } as never,
          { id: "codex", name: "Codex" } as never,
        ],
        workflowMaps: {
          selectedRoomId: "core",
          selectedStepId: "core-codex",
          orders: {},
        },
        sessions: sessionState([
          {
            key: "agent:codex:main",
            kind: "direct",
            displayName: "Implementing workflow dashboard",
            updatedAt: Date.now(),
            status: "running",
            hasActiveRun: true,
          },
        ]),
        onSelectRoom: () => undefined,
        onSelectStep: () => undefined,
        onOrderChange: () => undefined,
        onResetRoom: () => undefined,
      }),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("Current Signal");
    expect(container.textContent).toContain("Active");
    expect(container.textContent).toContain("Next Inspection Target");
    expect(container.textContent).toContain("Next Expected Run");
    expect(container.textContent).toContain("Last Success");
    expect(container.textContent).toContain("Last Failure");
    expect(container.textContent).toContain("Implementing workflow dashboard");
    expect(container.textContent).toContain("Agent details and recent session history");
  });

  it("flags related cron errors as workflow review signals", async () => {
    const container = document.createElement("div");

    render(
      renderAgentWorkflows({
        agents: [{ id: "main", name: "Control Director" } as never],
        workflowMaps: {
          selectedRoomId: "core",
          selectedStepId: "core-intake",
          orders: {},
        },
        cron: {
          status: { enabled: true, jobs: 1 },
          loading: false,
          error: null,
          jobs: [
            cronJob({
              id: "core-intake-check",
              name: "Core intake check",
              agentId: "main",
              state: {
                lastRunAtMs: Date.now(),
                lastStatus: "error",
                lastError: "Intake probe failed",
                consecutiveErrors: 1,
              },
            }),
          ],
        },
        onSelectRoom: () => undefined,
        onSelectStep: () => undefined,
        onOrderChange: () => undefined,
        onResetRoom: () => undefined,
      }),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("Needs review");
    expect(container.textContent).toContain("Intake probe failed");
    expect(container.textContent).toContain("Cron Jobs and recent session history");
    expect(container.textContent).toContain("1 scheduled jobs visible");
    expect(container.textContent).toContain("Core intake check");
  });

  it("uses Kalshi dashboard failures as prediction market review signals", async () => {
    const container = document.createElement("div");

    render(
      renderAgentWorkflows({
        agents: [{ id: "polymarket-risk-controller", name: "Risk Controller" } as never],
        workflowMaps: {
          selectedRoomId: "markets",
          selectedStepId: "markets-risk",
          orders: {},
        },
        kalshiDashboard: {
          generated_at_utc: "2026-05-07T15:45:00Z",
          live_readiness: {
            checks: {
              paper_log_ok: true,
              outcome_log_ok: true,
              risk_controller_ok: false,
              no_live_trading_ok: true,
              forward_paper_queue_ok: true,
              evidence_report_ok: true,
            },
          },
        } as never,
        onSelectRoom: () => undefined,
        onSelectStep: () => undefined,
        onOrderChange: () => undefined,
        onResetRoom: () => undefined,
      }),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("Needs review");
    expect(container.textContent).toContain(
      "Kalshi dashboard, Cron Jobs, and Prediction Markets agents",
    );
    expect(container.textContent).toContain("Current Signal");
  });
});
