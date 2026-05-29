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

  it("opens linked cards from the card surface without hijacking action buttons", () => {
    const host = {};
    const state = getWorkboardState(host);
    const onOpenSession = vi.fn();
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Inspect a running task",
        status: "running",
        priority: "normal",
        labels: [],
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
        onOpenSession,
      }),
      container,
    );

    const card = container.querySelector<HTMLElement>(".workboard-card");
    card?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onOpenSession).toHaveBeenCalledWith("agent:main:dashboard:1");

    onOpenSession.mockClear();
    container
      .querySelector<HTMLButtonElement>('button[title="Delete card"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("shows Codex and Claude execution actions for unlinked cards", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Start this later",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
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
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    const startButtons = [
      ...container.querySelectorAll<HTMLButtonElement>(".workboard-card__start"),
    ];
    expect(startButtons.map((button) => button.textContent?.trim())).toEqual([
      "Start",
      "codex",
      "claude",
      "codex",
      "claude",
    ]);
    expect(startButtons.map((button) => button.title)).toEqual([
      "Run default agent",
      "Run codex",
      "Run claude",
      "Open codex",
      "Open claude",
    ]);
    expect(container.querySelector(".workboard-card")?.getAttribute("role")).toBeNull();
  });

  it("hides write controls for read-only operators", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Inspect only",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        canWrite: false,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.querySelector<HTMLButtonElement>('button[title="Edit card"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[title="Delete card"]')).toBeNull();
    expect(container.querySelectorAll<HTMLButtonElement>(".workboard-card__start")).toHaveLength(0);
    expect(
      container.querySelector<HTMLButtonElement>(".workboard-toolbar__actions .btn.primary"),
    ).toBeNull();
    expect(container.querySelector(".workboard-card")?.getAttribute("draggable")).toBe("false");
  });

  it("offers start controls when a linked session no longer exists", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Restart this",
        status: "blocked",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
        sessionKey: "agent:main:missing:1",
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
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.textContent).toContain("Session missing");
    expect(container.querySelectorAll<HTMLButtonElement>(".workboard-card__start")).toHaveLength(5);
  });

  it("opens a modal for new cards", () => {
    const host = {};
    getWorkboardState(host).loaded = true;
    const container = document.createElement("div");

    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    container
      .querySelector<HTMLButtonElement>(".workboard-toolbar__actions .btn.primary")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    render(
      renderWorkboard({
        host,
        client: null,
        connected: true,
        pluginEnabled: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("New card");
    expect(container.querySelector(".workboard-board")).toBeTruthy();
  });

  it("opens and plays the mini game", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    const container = document.createElement("div");
    const props = {
      host,
      client: null,
      connected: true,
      pluginEnabled: true,
      agentsList: null,
      sessions: [],
      onOpenSession: () => undefined,
      onRequestUpdate: () => undefined,
    };

    render(renderWorkboard(props), container);
    [...container.querySelectorAll<HTMLButtonElement>(".workboard-toolbar__actions .btn")]
      .find((button) => button.textContent?.includes("Mini game"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    render(renderWorkboard(props), container);

    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Card Chase");
    const controls = container.querySelector<HTMLElement>(".workboard-game__controls");
    controls
      ?.querySelector<HTMLButtonElement>('button[aria-label="Move right"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    render(renderWorkboard(props), container);

    expect(state.gamePlayerIndex).toBe(1);
    expect(container.querySelector(".workboard-game__stats")?.textContent).toContain("Moves 1");
  });

  it("renders card event history", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Tracked task",
        status: "review",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 2,
        events: [
          { id: "event-1", kind: "created", at: 1, toStatus: "todo" },
          { id: "event-2", kind: "moved", at: 2, fromStatus: "todo", toStatus: "review" },
        ],
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
        sessions: [],
        onOpenSession: () => undefined,
      }),
      container,
    );

    expect(container.querySelector(".workboard-events")?.textContent).toContain("Moved to Review");
  });

  it("opens an edit modal and submits card updates", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      {
        id: "card-1",
        title: "Rename me",
        notes: "Old notes",
        status: "todo",
        priority: "normal",
        labels: ["ui"],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const request = vi.fn(async () => ({
      card: {
        ...state.cards[0],
        title: "Renamed",
        priority: "high",
        updatedAt: 2,
      },
    }));
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
    const container = document.createElement("div");

    render(renderWorkboard(props), container);
    container
      .querySelector<HTMLButtonElement>('button[title="Edit card"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    render(renderWorkboard(props), container);

    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Edit card");
    const title = container.querySelector<HTMLInputElement>(".workboard-draft__title");
    expect(title?.value).toBe("Rename me");
    title!.value = "Renamed";
    title!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const priority = [
      ...container.querySelectorAll<HTMLSelectElement>(".workboard-draft__meta select"),
    ].at(1);
    priority!.value = "high";
    priority!.dispatchEvent(new Event("change", { bubbles: true }));
    container
      .querySelector<HTMLFormElement>(".workboard-draft")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledWith("workboard.cards.update", {
      id: "card-1",
      patch: expect.objectContaining({
        title: "Renamed",
        priority: "high",
      }),
    });
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

  it("does not offer synthetic heartbeat sessions when creating a card", () => {
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
            key: "agent:main:heartbeat",
            kind: "direct",
            displayName: "heartbeat",
            updatedAt: 2,
          },
          {
            key: "agent:main:dashboard:1",
            kind: "direct",
            displayName: "Dashboard session",
            updatedAt: 3,
          },
        ],
        onOpenSession: () => undefined,
      }),
      container,
    );

    const sessionOptions = [
      ...container.querySelectorAll<HTMLSelectElement>(".workboard-draft__meta select"),
    ].at(3);
    const labels = [...(sessionOptions?.querySelectorAll("option") ?? [])].map((option) =>
      option.textContent?.trim(),
    );
    expect(labels).toContain("Dashboard session");
    expect(labels).not.toContain("heartbeat");
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
