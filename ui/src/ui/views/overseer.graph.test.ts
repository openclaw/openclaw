import { describe, expect, it } from "vitest";

import type { OverseerGoalStatusResult } from "../types/overseer";
import type { ChannelsStatusSnapshot } from "../types";
import {
  buildOverseerGraphLayout,
  buildSystemGraphLayout,
  fitGraphViewport,
  zoomGraphViewport,
} from "./overseer.graph";

describe("overseer graph layouts", () => {
  it("builds plan nodes and edges", () => {
    const goal: OverseerGoalStatusResult["goal"] = {
      goalId: "G_1",
      title: "Demo goal",
      createdAt: 1,
      updatedAt: 2,
      status: "active",
      priority: "normal",
      tags: [],
      problemStatement: "Test plan",
      successCriteria: [],
      nonGoals: [],
      plan: {
        planVersion: 1,
        phases: [
          {
            id: "P1",
            name: "Phase 1",
            status: "in_progress",
            createdAt: 1,
            updatedAt: 1,
            tasks: [
              {
                id: "T1",
                name: "Task 1",
                status: "todo",
                createdAt: 1,
                updatedAt: 1,
                subtasks: [
                  {
                    id: "S1",
                    name: "Subtask 1",
                    status: "todo",
                    createdAt: 1,
                    updatedAt: 1,
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    const layout = buildOverseerGraphLayout(goal);
    expect(layout.nodes.some((node) => node.id === "goal:G_1")).toBe(true);
    expect(layout.nodes.some((node) => node.id === "P1")).toBe(true);
    expect(layout.nodes.some((node) => node.id === "T1")).toBe(true);
    expect(layout.nodes.some((node) => node.id === "S1")).toBe(true);
    expect(layout.edges.some((edge) => edge.from === "goal:G_1" && edge.to === "P1")).toBe(true);
    expect(layout.edges.some((edge) => edge.from === "P1" && edge.to === "T1")).toBe(true);
    expect(layout.edges.some((edge) => edge.from === "T1" && edge.to === "S1")).toBe(true);
    expect(layout.bounds.width).toBeGreaterThan(0);
    expect(layout.bounds.height).toBeGreaterThan(0);
  });

  it("builds system graph groups", () => {
    const channels: ChannelsStatusSnapshot = {
      ts: Date.now(),
      channelOrder: ["slack"],
      channelLabels: { slack: "Slack" },
      channels: { slack: { configured: true, running: false } },
      channelAccounts: {},
      channelDefaultAccountId: {},
    };
    const layout = buildSystemGraphLayout({
      nodes: [{ nodeId: "node-1", displayName: "Node 1", connected: true }],
      presenceEntries: [
        {
          instanceId: "instance-1",
          host: "gateway-host",
          mode: "local",
          lastInputSeconds: 12,
        },
      ],
      cronJobs: [
        {
          id: "job-1",
          name: "Heartbeat",
          enabled: true,
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
          schedule: { kind: "every", everyMs: 60000 },
          sessionTarget: "main",
          wakeMode: "now",
          payload: { kind: "systemEvent", text: "ping" },
        },
      ],
      skillsReport: {
        workspaceDir: "/tmp",
        managedSkillsDir: "/tmp/skills",
        skills: [
          {
            name: "Ripgrep",
            description: "Search tool",
            source: "core",
            filePath: "/tmp/rg",
            baseDir: "/tmp",
            skillKey: "rg",
            always: false,
            disabled: false,
            blockedByAllowlist: false,
            eligible: true,
            requirements: { bins: [], env: [], config: [], os: [] },
            missing: { bins: [], env: [], config: [], os: [] },
            configChecks: [],
            install: [],
          },
        ],
      },
      agents: {
        defaultId: "main",
        mainKey: "main",
        scope: "test",
        agents: [{ id: "main", identity: { name: "Main" } }],
      },
      sessions: {
        ts: Date.now(),
        path: "~/.clawdbot/agents/main/sessions.jsonl",
        count: 1,
        defaults: {
          model: null,
          contextTokens: null,
        },
        sessions: [{ key: "main", kind: "direct", updatedAt: Date.now() }],
      },
      channels,
    });

    expect(layout.nodes.some((node) => node.id === "gateway")).toBe(true);
    expect(layout.nodes.some((node) => node.id === "group:nodes")).toBe(true);
    expect(layout.nodes.some((node) => node.id === "group:agents")).toBe(true);
    expect(layout.nodes.some((node) => node.id === "group:sessions")).toBe(true);
    expect(layout.nodes.some((node) => node.id === "group:instances")).toBe(true);
    expect(layout.nodes.some((node) => node.id === "group:cron")).toBe(true);
    expect(layout.nodes.some((node) => node.id === "group:skills")).toBe(true);
    expect(layout.nodes.some((node) => node.id === "group:channels")).toBe(true);
  });

  it("computes viewport transforms", () => {
    const viewport = { scale: 1, offsetX: 0, offsetY: 0 };
    const fit = fitGraphViewport({ width: 400, height: 200 }, 800, 600);
    expect(fit.scale).toBeGreaterThan(0);
    const zoomed = zoomGraphViewport(viewport, 1.4, 100, 100);
    expect(zoomed.scale).toBeGreaterThan(1);
  });
});
