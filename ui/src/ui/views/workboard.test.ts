import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { getWorkboardState } from "../controllers/workboard.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import { renderWorkboard } from "./workboard.ts";

describe("renderWorkboard", () => {
  it("renders board columns and preloaded cards", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Wire dashboard tab",
        notes: "Call plugin gateway methods from the Workboard page.",
        status: "todo",
        priority: "high",
        labels: ["ui"],
        agentId: "main",
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
        sessionKey: "agent:main:dashboard:1",
      },
    ];
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [
          {
            key: "agent:main:dashboard:1",
            kind: "direct",
            displayName: "Dashboard session",
            updatedAt: 2,
            hasActiveRun: true,
            status: "running",
          },
        ],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.textContent).toContain("Todo");
    expect(container.textContent).toContain("Wire dashboard tab");
    expect(container.textContent).toContain("Running");
    expect(container.textContent).toContain("Dashboard session");
    expect(container.querySelectorAll(".workboard-column")).toHaveLength(6);
    expect(container.querySelector(".workboard-card__priority")?.textContent).toContain("high");
  });

  it("offers existing sessions when creating a card", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.draftOpen = true;
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [
          {
            key: "agent:main:dashboard:1",
            kind: "direct",
            displayName: "Existing session",
            updatedAt: 2,
          },
        ],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.textContent).toContain("No linked session");
    expect(container.textContent).toContain("Existing session");
  });

  it("shows an enablement message when the optional plugin is disabled", () => {
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host: {},
        client: null,
        connected: true,
        pluginEnabled: false,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.textContent).toContain("Workboard is disabled");
    expect(container.querySelector(".workboard-column")).toBeNull();
  });

  it("does not retry a failed initial load on every render", async () => {
    const host = {};
    const container = document.createElement("div");
    const request = vi.fn(async () => {
      throw new Error("workboard unavailable");
    });
    const props = {
      host,
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
      pluginEnabled: true,
      agentsList: null,
      sessions: [],
      onOpenSession: () => undefined,
      onRequestUpdate: () => undefined,
    };

    render(renderWorkboard(props), container);
    await Promise.resolve();
    await Promise.resolve();
    render(renderWorkboard(props), container);
    await Promise.resolve();

    expect(request).toHaveBeenCalledOnce();
    expect(getWorkboardState(host).error).toBe("workboard unavailable");
  });
});
