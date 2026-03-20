import { describe, expect, it } from "vitest";
import { buildSessionTaskCards } from "./session-adapter.ts";

describe("buildSessionTaskCards", () => {
  it("excludes cron sessions and maps active session fields", () => {
    const now = Date.UTC(2026, 2, 20, 1, 0, 0);
    const startedAt = now - 5 * 60 * 1000;
    const updatedAt = now - 60 * 1000;

    const cards = buildSessionTaskCards(
      {
        ts: now,
        path: "",
        count: 2,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:ops-engineer:telegram:direct:5323237514",
            kind: "direct",
            label: "ops direct",
            updatedAt,
            startedAt,
            status: "running",
            totalTokens: 1234,
          },
          {
            key: "agent:ops-engineer:cron:gateway-watchdog",
            kind: "direct",
            updatedAt,
            status: "done",
            totalTokens: 999,
          },
        ],
      },
      now,
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: "agent:ops-engineer:telegram:direct:5323237514",
      lane: "active",
      title: "ops direct",
      owner: "ops-engineer",
      status: "in_progress",
      health: "healthy",
      progressPercent: 40,
      progressSource: "estimated",
      runningForSec: 300,
      waitingForSec: null,
      tokenUsage: {
        value: 1234,
        window: "session total",
        source: "sessions.list",
      },
      sourceOfTruth: ["sessions.list"],
    });
  });

  it("surfaces failed sessions as error cards and marks stale waiting sessions", () => {
    const now = Date.UTC(2026, 2, 20, 1, 0, 0);
    const failedAt = now - 30 * 1000;
    const staleAt = now - 3 * 60 * 60 * 1000;

    const cards = buildSessionTaskCards(
      {
        ts: now,
        path: "",
        count: 2,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:ops-engineer:main",
            kind: "direct",
            updatedAt: failedAt,
            status: "failed",
            displayName: "ops main",
          },
          {
            key: "agent:writer-ops:main",
            kind: "direct",
            updatedAt: staleAt,
            status: "done",
            displayName: "writer main",
          },
        ],
      },
      now,
    );

    expect(cards[0]).toMatchObject({
      owner: "ops-engineer",
      status: "error",
      health: "error",
      blocker: "最近一轮失败",
    });
    expect(cards[1]).toMatchObject({
      owner: "writer-ops",
      status: "waiting",
      health: "stale",
      waitingForSec: 3 * 60 * 60,
    });
  });
});
