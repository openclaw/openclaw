import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderSnesStudio, resetSnesStudioStateForTests } from "./snes-studio.ts";

type TestHost = NonNullable<Parameters<typeof renderSnesStudio>[0]>;

function renderStudio(host: TestHost, container: HTMLElement) {
  render(renderSnesStudio(host), container);
}

function buttonByText(container: HTMLElement, text: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
}

function clickButton(container: HTMLElement, text: string) {
  const button = buttonByText(container, text);
  expect(button, `button containing ${text}`).not.toBeUndefined();
  button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function typeGamePrompt(container: HTMLElement, value: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>(
    ".snes-arcade-start textarea, .snes-guided-idea textarea",
  );
  expect(textarea).not.toBeNull();
  textarea!.value = value;
  textarea!.dispatchEvent(new Event("input", { bubbles: true }));
}

function typeGuidedThingPrompt(container: HTMLElement, value: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>(
    ".snes-guided-thing-prompt textarea",
  );
  expect(textarea).not.toBeNull();
  textarea!.value = value;
  textarea!.dispatchEvent(new Event("input", { bubbles: true }));
}

function typeSelectedThingPrompt(container: HTMLElement, value: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>(".snes-ai-selected-panel textarea");
  expect(textarea).not.toBeNull();
  textarea!.value = value;
  textarea!.dispatchEvent(new Event("input", { bubbles: true }));
}

function typeArcadeAreaPrompt(container: HTMLElement, value: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>(".snes-arcade-ask-bar textarea");
  expect(textarea).not.toBeNull();
  textarea!.value = value;
  textarea!.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flushAsyncUi(container: HTMLElement, host: TestHost) {
  await Promise.resolve();
  await Promise.resolve();
  renderStudio(host, container);
}

async function waitForText(container: HTMLElement, host: TestHost, text: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    renderStudio(host, container);
    if (container.textContent?.includes(text)) {
      return;
    }
  }
  expect(container.textContent).toContain(text);
}

function createGame(container: HTMLElement, host: TestHost) {
  clickButton(container, "Build With OpenClaw");
  renderStudio(host, container);
}

describe("renderSnesStudio AI Arcade Builder", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "?__openclaw_skip_auto_agent_team=1");
    const clearStorage = (globalThis.localStorage as { clear?: unknown } | undefined)?.clear;
    if (typeof clearStorage === "function") {
      clearStorage.call(globalThis.localStorage);
    }
    resetSnesStudioStateForTests();
    document.body.replaceChildren();
  });

  it("starts with one obvious AI-first creation path", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);

    expect(container.querySelector(".snes-arcade-builder--start")).not.toBeNull();
    expect(container.querySelectorAll(".snes-arcade-start textarea")).toHaveLength(1);
    expect(container.textContent).toContain("AI Arcade Builder");
    expect(container.textContent).toContain("What game do you want to make?");
    expect(container.textContent).toContain("Build With OpenClaw");
    expect(container.textContent).toContain("Robot mountain adventure");
    expect(container.textContent).toContain("Spooky forest coin quest");
    expect(container.textContent).toContain("Underwater rescue");
    expect(container.textContent).toContain("Graphics Style");
    expect(container.textContent).toContain("Classic Colorful SNES Platformer");
    expect(container.textContent).toContain(
      "Using original SNES-safe art inspired by classic platformers.",
    );
    expect(container.textContent).toContain("Codex Architect");
    expect(container.textContent).toContain("OpenClaw Game Team");
    expect(container.textContent).toContain("Codex Review Gate");
    expect(container.textContent).toContain("Codex QA Gate");
    expect(container.textContent).toContain("Codex is reserved");
    expect(container.textContent).toContain("Live AI team");
    expect(container.textContent).toContain("Gateway production route not verified");
    expect(container.textContent).toContain("Run Live Production Check");
    expect(container.textContent).toContain("Live AI Team Status");
    expect(container.textContent).toContain("Checking soon");
    expect(container.querySelector(".snes-mode-rail")).toBeNull();
    expect(container.querySelector<HTMLDetailsElement>(".snes-ai-expert-studio")?.open).toBe(false);
  });

  it("creates a playable side-scroller from one prompt and walks into Play & Change", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    typeGamePrompt(
      container,
      'Make "Crystal Button Quest" with a robot hero, gentle enemies, gems, music, saves, three beginner levels, and Super Mario World graphics.',
    );
    createGame(container, host);

    expect(container.textContent).toContain("Crystal Button Quest");
    expect(container.textContent).toContain("Local OpenClaw fallback game built");
    expect(container.textContent).toContain("Codex blueprint ready");
    expect(container.textContent).toContain("OpenClaw Game Team filled");
    expect(container.textContent).toContain("Codex approved for playtest");
    expect(container.textContent).toContain("Classic Colorful SNES Platformer");
    expect(container.textContent).toContain(
      "Using original SNES-safe art inspired by classic platformers.",
    );
    expect(container.textContent).toContain("Game Plan");
    expect(container.textContent).toContain("3 chapters");
    expect(container.textContent).toContain("a playable first level");

    clickButton(container, "Build Levels");
    renderStudio(host, container);
    expect(container.textContent).toContain("Opening");
    expect(container.textContent).toContain("Finale");

    clickButton(container, "Play & Change");
    renderStudio(host, container);
    expect(container.textContent).toContain("Use the emulator as the editor");
    expect(container.textContent).toContain("60 Hz runtime playtest");
    expect(container.textContent).toContain("ntsc 60hz");
    expect(container.textContent).toContain("Replay parity");
    expect(container.querySelector(".snes-emulator-canvas")).not.toBeNull();
    expect(container.querySelector("canvas.snes-runtime-canvas")).not.toBeNull();
    expect(container.querySelector(".snes-playtest__marker--hero")?.textContent).toContain("Hero");
    expect(container.querySelector(".snes-playtest__marker--enemy")?.textContent).toContain(
      "Enemy",
    );
    expect(container.querySelector(".snes-playtest__marker--item")?.textContent).toContain("Item");
    const askBar = container.querySelector(".snes-arcade-ask-bar");
    const playtest = container.querySelector(".snes-playtest");
    expect(askBar).not.toBeNull();
    expect(playtest).not.toBeNull();
    expect(
      Boolean(askBar!.compareDocumentPosition(playtest!) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);

    clickButton(container, "Run Right");
    renderStudio(host, container);
    expect(container.textContent).toContain("Hero moved right");
  });

  it("routes Ask Live OpenClaw through the connected Gateway and shows a review", async () => {
    const request = vi.fn().mockResolvedValue({
      response: JSON.stringify({
        summary: "Live OpenClaw preview",
        rationale: ["Renamed the game from the live agent preview."],
        operations: [{ op: "replace", path: "/name", value: "Live Agent Quest" }],
      }),
    });
    const host = { client: { request }, connected: true, requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    typeGamePrompt(container, "Make a live agent robot quest.");
    createGame(container, host);
    clickButton(container, "Idea");
    renderStudio(host, container);
    clickButton(container, "Ask Live OpenClaw");
    await flushAsyncUi(container, host);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe("agent");
    expect(container.textContent).toContain("Live agent preview ready");
    expect(container.textContent).toContain("Review Before Apply");
    expect(container.textContent).toContain("Live OpenClaw preview");
    expect(buttonByText(container, "Apply Change")).not.toBeUndefined();
  });

  it("routes the staged Codex/OpenClaw production check through Gateway", async () => {
    let runIndex = 0;
    let createIndex = 0;
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === "agents.list") {
        return { agents: [{ id: "main" }] };
      }
      if (method === "agents.create") {
        const ids = [
          "snes-game-director",
          "snes-level-designer",
          "snes-gameplay-designer",
          "snes-art-audio",
          "snes-hardware-qa",
        ];
        return { ok: true, agentId: ids[createIndex++] };
      }
      if (method === "agents.runtime.status") {
        return { localModels: { available: true, installedAvailable: true } };
      }
      if (method === "agent") {
        runIndex += 1;
        return { runId: `snes-live-run-${runIndex}`, status: "accepted" };
      }
      if (method === "agent.wait") {
        return { status: "ok" };
      }
      if (method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    summary: "Live production stage patch",
                    rationale: ["Verified one staged Gateway production lane."],
                    operations: [{ op: "replace", path: "/name", value: "Live Production Quest" }],
                  }),
                },
              ],
            },
          ],
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const host = { client: { request }, connected: true, requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    typeGamePrompt(container, "Make a Codex-supervised OpenClaw robot quest.");
    clickButton(container, "Run Live Production Check");
    await waitForText(container, host, "Live production route verified");

    expect(request).toHaveBeenCalledTimes(28);
    const createCalls = request.mock.calls.filter(([method]) => method === "agents.create");
    expect(createCalls).toHaveLength(5);
    expect((createCalls[0]?.[1] as { name?: string })?.name).toBe("snes-game-director");
    const agentCalls = request.mock.calls.filter(([method]) => method === "agent");
    expect(agentCalls).toHaveLength(7);
    expect(request.mock.calls.filter(([method]) => method === "agent.wait")).toHaveLength(7);
    expect(request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(7);
    const messages = agentCalls.map(([, params]) => {
      const requestParams = params as { message?: string };
      return requestParams.message ?? "";
    });
    expect(messages[0]).toContain("Codex Architect stage.");
    expect(messages[1]).toContain("OpenClaw Game Director production stage.");
    expect(messages[2]).toContain("OpenClaw Level Designer production stage.");
    expect(messages[6]).toContain("Codex QA Gate stage.");
    expect(container.textContent).toContain("Dashboard Gateway ready");
    expect(container.textContent).toContain("Automated E2E");
    expect(container.textContent).toContain("OpenClaw Game Director");
    expect(container.textContent).toContain("Review Before Apply");
    expect(container.textContent).toContain("Live production stage patch");
  });

  it("automatically checks the Codex-supervised OpenClaw role team without model jobs", async () => {
    window.history.replaceState(null, "", window.location.pathname || "/");
    let createIndex = 0;
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === "agents.list") {
        return { agents: [{ id: "main" }] };
      }
      if (method === "agents.create") {
        const ids = [
          "snes-game-director",
          "snes-level-designer",
          "snes-gameplay-designer",
          "snes-art-audio",
          "snes-hardware-qa",
        ];
        return { ok: true, agentId: ids[createIndex++] };
      }
      if (method === "agents.runtime.status") {
        return { localModels: { available: true, installedAvailable: true } };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const host = { client: { request }, connected: true, requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    await waitForText(container, host, "Live proof pending");

    expect(request).toHaveBeenCalledTimes(7);
    const createCalls = request.mock.calls.filter(([method]) => method === "agents.create");
    expect(createCalls).toHaveLength(5);
    expect((createCalls[0]?.[1] as { name?: string })?.name).toBe("snes-game-director");
    expect(
      request.mock.calls.filter(([method]) => method === "agents.runtime.status"),
    ).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "agent")).toHaveLength(0);
    expect(container.textContent).toContain("Codex Architect");
    expect(container.textContent).toContain("OpenClaw Level Designer");
    expect(container.textContent).toContain("Codex QA Gate");
    expect(container.textContent).toContain("Proof pending");
    expect(container.textContent).toContain("Check Again");
  });

  it("blocks stuck live production proof instead of leaving the dashboard spinning", async () => {
    window.history.replaceState(null, "", window.location.pathname || "/");
    let runIndex = 0;
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === "agents.list") {
        return {
          agents: [
            { id: "main" },
            { id: "snes-game-director" },
            { id: "snes-level-designer" },
            { id: "snes-gameplay-designer" },
            { id: "snes-art-audio" },
            { id: "snes-hardware-qa" },
          ],
        };
      }
      if (method === "agents.runtime.status") {
        return { localModels: { available: true, installedAvailable: true } };
      }
      if (method === "agent") {
        runIndex += 1;
        return { runId: `snes-team-run-${runIndex}`, status: "accepted" };
      }
      if (method === "agent.wait") {
        return { status: "pending" };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const host = { client: { request }, connected: true, requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    clickButton(container, "Run Live Production Check");
    await waitForText(container, host, "Live OpenClaw unavailable");

    expect(request.mock.calls.filter(([method]) => method === "agent")).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === "agent.wait")).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(0);
    expect(container.textContent).toContain("Run Live Production Check");
    expect(container.textContent).toContain("timed out during live proof");
  });

  it("reports OpenClaw worker setup blockers without sending live role jobs", async () => {
    window.history.replaceState(null, "", window.location.pathname || "/");
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === "agents.list") {
        return { agents: [{ id: "main" }] };
      }
      if (method === "agents.create") {
        throw new Error("agent management disabled");
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const host = { client: { request }, connected: true, requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    await waitForText(container, host, "Live OpenClaw unavailable");

    expect(request.mock.calls.filter(([method]) => method === "agents.list")).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "agents.create")).toHaveLength(5);
    expect(request.mock.calls.filter(([method]) => method === "agent")).toHaveLength(0);
    expect(container.textContent).toContain("Needs setup");
    expect(container.textContent).toContain("SNES Studio can create this worker automatically");
  });

  it("clearly blocks live production when the Gateway route is unavailable", async () => {
    const host = {
      requestUpdate: vi.fn(),
      client: { request: vi.fn() },
      connected: false,
      lastError: "401 Unauthorized",
      lastErrorCode: "UNAUTHORIZED",
    };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    clickButton(container, "Run Live Production Check");
    await waitForText(container, host, "Needs Dashboard login");

    expect(container.textContent).toContain("Needs Dashboard login");
    expect(container.textContent).toContain("Dashboard Gateway WebSocket is not connected");
    expect(container.textContent).toContain("401 Unauthorized");
    expect(container.textContent).toContain("hardware equipment is not required");
    expect(container.textContent).toContain("OPENCLAW_SNES_STUDIO_LIVE_AGENT_E2E");
  });

  it("runs local OpenClaw/Codex proof when Gateway live agent setup is unavailable", async () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    typeGamePrompt(container, "Make a local proof robot quest.");
    createGame(container, host);
    const expert = container.querySelector<HTMLDetailsElement>(".snes-ai-expert-studio");
    expect(expert).not.toBeNull();
    expert!.open = true;
    expert!.dispatchEvent(new Event("toggle", { bubbles: true }));
    renderStudio(host, container);
    clickButton(container, "Export");
    renderStudio(host, container);

    clickButton(container, "Run Local Agent Proof");
    await waitForText(container, host, "Local agent proof passed");

    expect(container.textContent).toContain("Local agent proof passed");
    expect(container.textContent).toContain("Review Before Apply");
    expect(container.textContent).toContain("Local AI path verified");
    expect(container.textContent).toContain("Gateway live proof still needs a connected session");
    expect(buttonByText(container, "Apply Change")).not.toBeUndefined();
  });

  it("fills missing pieces after AI makes the first draft", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    typeGamePrompt(container, "Make a sky platformer with floating platforms and coins.");
    createGame(container, host);
    clickButton(container, "Fill Gaps");
    renderStudio(host, container);

    expect(container.textContent).toContain("Story game gaps filled");
    expect(container.textContent).toContain("3 chapters");
    expect(container.textContent).toContain("Full draft looks ready");
  });

  it("creates custom prompted things and makes them editable in playtest", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    createGame(container, host);
    clickButton(container, "Make Things");
    renderStudio(host, container);
    typeGuidedThingPrompt(
      container,
      "Create a slow turtle enemy called Shell Walker that patrols a short safe path.",
    );
    clickButton(container, "Create Thing");
    renderStudio(host, container);

    expect(container.textContent).toContain("Shell Walker created");
    expect(container.textContent).toContain("Shell Walker");
    expect(container.querySelector(".snes-playtest__marker--enemy")).not.toBeNull();
    expect(container.textContent).toContain("Things Shelf");
  });

  it("starts and pauses a continuous live playtest loop", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    createGame(container, host);
    clickButton(container, "Play & Change");
    renderStudio(host, container);
    clickButton(container, "Start Test");
    renderStudio(host, container);

    expect(container.textContent).toContain("Live play started");
    expect(container.textContent).toContain("60 Hz");
    expect(container.textContent).toContain("Live play running");
    expect(container.querySelector(".snes-playtest__stage--running")).not.toBeNull();

    clickButton(container, "Pause");
    renderStudio(host, container);
    expect(container.textContent).toContain("Playtest paused");
  });

  it("selects a visible hero and applies a scoped prompt only to that thing", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    createGame(container, host);
    clickButton(container, "Play & Change");
    renderStudio(host, container);
    container
      .querySelector<HTMLButtonElement>(".snes-playtest__marker--hero")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderStudio(host, container);
    typeSelectedThingPrompt(container, "Make the hero jump higher and move faster.");
    clickButton(container, "Change With OpenClaw");
    renderStudio(host, container);

    expect(container.textContent).toContain("Selected thing changed");
    expect(container.textContent).toContain("raised hero jump");
    expect(container.textContent).toContain("increased hero speed");
    expect(container.textContent).toContain("Run speed");
    expect(container.textContent).toContain("Jump height");
  });

  it("changes only the selected thing visual recipe with the classic style prompt", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    typeGamePrompt(container, "Make a side-scrolling platformer with Super Mario World graphics.");
    createGame(container, host);
    clickButton(container, "Play & Change");
    renderStudio(host, container);
    container
      .querySelector<HTMLButtonElement>(".snes-playtest__marker--enemy")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderStudio(host, container);

    expect(container.textContent).toContain("Look");
    expect(container.textContent).toContain("round colorful");
    typeSelectedThingPrompt(
      container,
      "Make this enemy rounder and colorful with a classic SNES platformer look.",
    );
    clickButton(container, "Change With OpenClaw");
    renderStudio(host, container);

    expect(container.textContent).toContain("Selected thing changed");
    expect(container.textContent).toContain("updated its classic visual recipe");
    expect(container.textContent).toContain("Classic Colorful SNES Platformer");

    clickButton(container, "Change Look With OpenClaw");
    renderStudio(host, container);
    expect(container.textContent).toContain("updated its classic visual recipe");
  });

  it("moves a game thing by direct pointer drag inside the playtest", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    createGame(container, host);
    clickButton(container, "Play & Change");
    renderStudio(host, container);

    const stage = container.querySelector<HTMLElement>(".snes-emulator-canvas");
    expect(stage).not.toBeNull();
    stage!.getBoundingClientRect = () =>
      ({
        bottom: 300,
        height: 300,
        left: 0,
        right: 400,
        top: 0,
        width: 400,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    const hero = container.querySelector<HTMLButtonElement>(".snes-playtest__marker--hero");
    expect(hero).not.toBeNull();
    hero!.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 48, clientY: 160 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 240, clientY: 180 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, clientX: 240, clientY: 180 }),
    );
    renderStudio(host, container);

    expect(container.textContent).toContain("Player Start moved");
    expect(container.textContent).toContain("direct drag move is now in the 60 Hz playtest");
    const selectedPanel = container.querySelector<HTMLElement>(".snes-ai-selected-panel");
    expect(selectedPanel?.textContent).toContain("Hero");
    const positionInputs = [
      ...selectedPanel!.querySelectorAll<HTMLInputElement>('input[type="number"]'),
    ];
    expect(Number(positionInputs[0]?.value)).toBeGreaterThan(120);
    expect(Number(positionInputs[1]?.value)).toBeGreaterThan(140);
  });

  it("selects a terrain chunk from a simple click in the playtest", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    createGame(container, host);
    clickButton(container, "Play & Change");
    renderStudio(host, container);

    const stage = container.querySelector<HTMLElement>(".snes-emulator-canvas");
    expect(stage).not.toBeNull();
    stage!.getBoundingClientRect = () =>
      ({
        bottom: 300,
        height: 300,
        left: 0,
        right: 400,
        top: 0,
        width: 400,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    stage!.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 220, clientY: 245 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, clientX: 220, clientY: 245 }),
    );
    renderStudio(host, container);

    expect(container.querySelector(".snes-emulator-selection")).not.toBeNull();
    expect(container.textContent).toContain("Ground selected");
    expect(container.textContent).toContain("Change ground");
    expect(container.textContent).toContain("Selected 16 by 3 level squares");

    const tileClass = (index: number) =>
      container.querySelectorAll<HTMLElement>(".snes-playtest__tile")[index]?.className ?? "";
    expect(tileClass(8 * 16)).not.toContain("snes-playtest__tile--ground");
    typeArcadeAreaPrompt(container, "Move this ground up.");
    clickButton(container, "Change Selected Area");
    renderStudio(host, container);

    expect(container.textContent).toContain("ground moved");
    expect(tileClass(8 * 16)).toContain("snes-playtest__tile--ground");
    expect(tileClass(11 * 16)).not.toContain("snes-playtest__tile--ground");

    const moveHandle = container.querySelector<HTMLElement>(".snes-emulator-selection span");
    expect(moveHandle).not.toBeNull();
    moveHandle!.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 220, clientY: 220 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 220, clientY: 245 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, clientX: 220, clientY: 245 }),
    );
    renderStudio(host, container);

    expect(container.textContent).toContain("ground moved");
    expect(tileClass(8 * 16)).not.toContain("snes-playtest__tile--ground");
    expect(tileClass(11 * 16)).toContain("snes-playtest__tile--ground");

    typeArcadeAreaPrompt(container, "Make this ground shorter.");
    clickButton(container, "Change Selected Area");
    renderStudio(host, container);

    expect(container.textContent).toContain("ground resized");
    expect(tileClass(9 * 16 + 13)).toContain("snes-playtest__tile--ground");
    expect(tileClass(9 * 16 + 15)).not.toContain("snes-playtest__tile--ground");

    const resizeTerrainHandle = container.querySelector<HTMLButtonElement>(
      ".snes-emulator-selection__resize",
    );
    expect(resizeTerrainHandle).not.toBeNull();
    resizeTerrainHandle!.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 350, clientY: 245 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 395, clientY: 245 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, clientX: 395, clientY: 245 }),
    );
    renderStudio(host, container);

    expect(container.textContent).toContain("ground resized");
    expect(tileClass(9 * 16 + 15)).toContain("snes-playtest__tile--ground");
  });

  it("lets the user select an emulator area and prompt a local change", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    createGame(container, host);
    clickButton(container, "Play & Change");
    renderStudio(host, container);

    const stage = container.querySelector<HTMLElement>(".snes-emulator-canvas");
    expect(stage).not.toBeNull();
    stage!.getBoundingClientRect = () =>
      ({
        bottom: 300,
        height: 300,
        left: 0,
        right: 400,
        top: 0,
        width: 400,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    stage!.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 80, clientY: 120 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 180, clientY: 180 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, clientX: 180, clientY: 180 }),
    );
    renderStudio(host, container);

    expect(container.querySelector(".snes-emulator-selection")).not.toBeNull();
    expect(container.textContent).toContain("Change Selected emulator area");
    expect(container.textContent).toContain("Selected 4 by 3 level squares");
    expect(container.textContent).toContain("Try asking");
    expect(container.textContent).toContain("Make this jump easier.");
    expect(container.textContent).toContain("Add a hidden key here.");
    expect(container.textContent).toContain("Fast changes");
    expect(container.textContent).toContain("Add Coins");
    expect(container.textContent).toContain("Add Key");
    expect(container.textContent).toContain("Make Easier");
    expect(container.textContent).toContain("Make Gap");
    expect(container.textContent).toContain("Remove Things");
    clickButton(container, "Add a hidden key here.");
    renderStudio(host, container);
    expect(
      container.querySelector<HTMLTextAreaElement>(".snes-arcade-ask-bar textarea")?.value,
    ).toBe("Add a hidden key here.");
    const selectedAreaMoveHandle = container.querySelector<HTMLElement>(
      ".snes-emulator-selection span",
    );
    expect(selectedAreaMoveHandle).not.toBeNull();
    selectedAreaMoveHandle!.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 100, clientY: 140 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 220, clientY: 160 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, clientX: 220, clientY: 160 }),
    );
    renderStudio(host, container);
    expect(container.textContent).toContain("Area moved");
    const resizeHandle = container.querySelector<HTMLButtonElement>(
      ".snes-emulator-selection__resize",
    );
    expect(resizeHandle).not.toBeNull();
    resizeHandle!.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 220, clientY: 160 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 300, clientY: 220 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, clientX: 300, clientY: 220 }),
    );
    renderStudio(host, container);
    expect(container.textContent).toContain("Area resized");
    typeArcadeAreaPrompt(container, "Add a coin trail here.");
    clickButton(container, "Change Selected Area");
    renderStudio(host, container);

    expect(container.textContent).toContain("Coin Trail");
    expect(container.textContent).toContain("Playtest this area now");
    const itemCountAfterAdd = container.querySelectorAll(".snes-playtest__marker--item").length;
    expect(itemCountAfterAdd).toBeGreaterThan(1);
    typeArcadeAreaPrompt(container, "Add a secret key here.");
    clickButton(container, "Preview Area Change");
    renderStudio(host, container);
    expect(container.textContent).toContain("Preview before apply");
    expect(container.textContent).toContain("Key preview");
    expect(container.querySelectorAll(".snes-playtest__marker--item").length).toBe(
      itemCountAfterAdd,
    );
    clickButton(container, "Cancel Preview");
    renderStudio(host, container);
    expect(container.textContent).not.toContain("Key preview");
    expect(container.querySelectorAll(".snes-playtest__marker--item").length).toBe(
      itemCountAfterAdd,
    );
    typeArcadeAreaPrompt(container, "Add a secret key here.");
    clickButton(container, "Preview Area Change");
    renderStudio(host, container);
    clickButton(container, "Apply Preview");
    renderStudio(host, container);
    expect(container.textContent).toContain("Key added");
    expect(container.querySelectorAll(".snes-playtest__marker--item").length).toBeGreaterThan(
      itemCountAfterAdd,
    );
    clickButton(container, "Remove Things");
    renderStudio(host, container);

    expect(container.textContent).toContain("Selected things removed");
    expect(container.querySelectorAll(".snes-playtest__marker--item").length).toBeLessThan(
      itemCountAfterAdd,
    );
  });

  it("uses natural selected-area prompts to remove only matching things and change terrain", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    createGame(container, host);
    clickButton(container, "Play & Change");
    renderStudio(host, container);

    const stage = container.querySelector<HTMLElement>(".snes-emulator-canvas");
    expect(stage).not.toBeNull();
    stage!.getBoundingClientRect = () =>
      ({
        bottom: 300,
        height: 300,
        left: 0,
        right: 400,
        top: 0,
        width: 400,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    stage!.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 0, clientY: 190 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 380, clientY: 285 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, clientX: 380, clientY: 285 }),
    );
    renderStudio(host, container);

    const enemyCountBefore = container.querySelectorAll(".snes-playtest__marker--enemy").length;
    const itemCountBefore = container.querySelectorAll(".snes-playtest__marker--item").length;
    typeArcadeAreaPrompt(container, "Remove enemies in this area.");
    clickButton(container, "Change Selected Area");
    renderStudio(host, container);

    expect(container.textContent).toContain("Selected things removed");
    expect(container.querySelectorAll(".snes-playtest__marker--enemy").length).toBeLessThan(
      enemyCountBefore,
    );
    expect(container.querySelectorAll(".snes-playtest__marker--item").length).toBe(itemCountBefore);

    stage!.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 220, clientY: 245 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, clientX: 220, clientY: 245 }),
    );
    renderStudio(host, container);

    const groundCountBefore = container.querySelectorAll(".snes-playtest__tile--ground").length;
    typeArcadeAreaPrompt(container, "Make this an empty gap.");
    clickButton(container, "Change Selected Area");
    renderStudio(host, container);

    expect(container.textContent).toContain("Gap made");
    expect(container.querySelectorAll(".snes-playtest__tile--ground").length).toBeLessThan(
      groundCountBefore,
    );
  });

  it("adds shelf pieces by click and reflects them in the playtest", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    createGame(container, host);
    clickButton(container, "Build Levels");
    renderStudio(host, container);
    const initialEnemies = container.querySelectorAll(".snes-playtest__marker--enemy").length;
    const enemyPiece = [
      ...container.querySelectorAll<HTMLButtonElement>(".snes-guided-shelf__thing"),
    ].find((button) => button.textContent?.includes("Enemy"));
    expect(enemyPiece).not.toBeUndefined();
    enemyPiece!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    clickButton(container, "Play & Change");
    renderStudio(host, container);

    expect(container.querySelectorAll(".snes-playtest__marker--enemy").length).toBeGreaterThan(
      initialEnemies,
    );
    expect(container.textContent).toContain("Things Shelf");
  });

  it("keeps expert SNES controls behind Advanced Studio disclosure", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    expect(container.querySelector(".snes-mode-rail")).toBeNull();
    const expert = container.querySelector<HTMLDetailsElement>(".snes-ai-expert-studio");
    expect(expert).not.toBeNull();
    expert!.open = true;
    expert!.dispatchEvent(new Event("toggle", { bubbles: true }));
    renderStudio(host, container);

    expect(container.querySelector(".snes-mode-rail")).not.toBeNull();
    expect(container.textContent).toContain("Expert Studio");
    expect(container.textContent).toContain("advanced SNES tools");
    expect(container.textContent).toContain("Project Safety");
    expect(container.textContent).toContain("Advanced AI stage");
  });

  it("shows an emulator run script plan when an emulator is selected", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    createGame(container, host);
    const expert = container.querySelector<HTMLDetailsElement>(".snes-ai-expert-studio");
    expect(expert).not.toBeNull();
    expert!.open = true;
    expert!.dispatchEvent(new Event("toggle", { bubbles: true }));
    renderStudio(host, container);
    clickButton(container, "Export");
    renderStudio(host, container);

    const emulatorInput = container.querySelector<HTMLInputElement>(
      ".snes-ship-proof input[placeholder='ares, bsnes, mesen, snes9x']",
    );
    expect(emulatorInput).not.toBeNull();
    emulatorInput!.value = "snes9x";
    emulatorInput!.dispatchEvent(new Event("input", { bubbles: true }));
    renderStudio(host, container);

    expect(container.textContent).toContain("Ready to run local emulator proof");
    expect(container.textContent).toContain("Download Emulator Run Script");
    expect(container.textContent).toContain("snes9x -snapshot");
  });

  it("keeps beginner export plain while preserving help for technical meaning", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    createGame(container, host);
    clickButton(container, "Create Game File");
    renderStudio(host, container);

    expect(container.textContent).toContain("Make SNES Game File");
    expect(container.querySelector(".snes-ai-export-card .snes-help-term")).not.toBeNull();
    expect(container.textContent).toContain("Ready to create a preview file");
  });
});
