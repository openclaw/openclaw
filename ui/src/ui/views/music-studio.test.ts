import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderMusicStudio, resetMusicStudioStateForTests } from "./music-studio.ts";

type TestHost = NonNullable<Parameters<typeof renderMusicStudio>[0]>;
type TestClientRequest = NonNullable<NonNullable<TestHost["client"]>["request"]>;

function renderStudio(host: TestHost, container: HTMLElement) {
  render(renderMusicStudio(host), container);
}

function clickButton(container: HTMLElement, text: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  expect(button, `button containing ${text}`).not.toBeUndefined();
  button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function openMode(
  host: TestHost,
  container: HTMLElement,
  label: "Create" | "Arrange" | "Play" | "Finish",
) {
  renderStudio(host, container);
  const button = [...container.querySelectorAll<HTMLButtonElement>(".music-mode-rail button")].find(
    (candidate) => candidate.textContent?.includes(label),
  );
  expect(button, `${label} mode button`).not.toBeUndefined();
  button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  renderStudio(host, container);
}

function chooseTarget(container: HTMLElement, value: string) {
  const select = container.querySelector<HTMLSelectElement>(".music-prompt-bar select");
  expect(select).not.toBeNull();
  select!.value = value;
  select!.dispatchEvent(new Event("change", { bubbles: true }));
}

function typePrompt(container: HTMLElement, value: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>(".music-prompt-bar textarea");
  expect(textarea).not.toBeNull();
  textarea!.value = value;
  textarea!.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flushAsyncClicks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("renderMusicStudio", () => {
  beforeEach(() => {
    resetMusicStudioStateForTests();
    document.body.replaceChildren();
  });

  it("renders a prompt-first Music Studio in the dashboard", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);

    expect(container.textContent).toContain("Music Studio");
    expect(container.textContent).toContain("Create");
    expect(container.textContent).toContain("Arrange");
    expect(container.textContent).toContain("Play");
    expect(container.textContent).toContain("Finish");
    expect(container.textContent).toContain("What music do you want to create or change?");
    expect(container.textContent).toContain("Beat / Drums");
    expect(container.textContent).toContain("Vocals");
    expect(container.textContent).toContain("Sound FX");
    expect(container.textContent).toContain("Generate real audio from this dashboard");
    expect(container.textContent).toContain("Generate Audio");
  });

  it("creates a playable song from one prompt", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    typePrompt(
      container,
      'Create "Birthday Laser Pop" at 138 BPM with drums, bass, vocal hook, and a huge chorus.',
    );
    clickButton(container, "Create Song");
    renderStudio(host, container);

    expect(container.textContent).toContain("Birthday Laser Pop");
    expect(container.textContent).toContain("138 BPM");
    expect(container.textContent).toContain("Playable");
    expect(container.textContent).toContain("Vocal Hook");
  });

  it("previews before applying generated music changes", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    typePrompt(container, "Make the chorus brighter with bigger drums.");
    clickButton(container, "Preview");
    renderStudio(host, container);

    expect(container.textContent).toContain("Review Before Apply");
    expect(container.textContent).toContain("Apply Change");
    expect(container.textContent).toContain("Discard");
  });

  it("selects a part and routes edits through the selected-part sheet", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    openMode(host, container, "Arrange");
    clickButton(container, "Pulse Drums");
    renderStudio(host, container);

    expect(container.textContent).toContain("Selected Part");
    expect(container.textContent).toContain("Prompt this part");
    expect(container.querySelector<HTMLSelectElement>(".music-prompt-bar select")?.value).toBe(
      "selected-part",
    );
  });

  it("supports drag/drop arrangement binding", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    openMode(host, container, "Arrange");
    const track = [...container.querySelectorAll<HTMLButtonElement>(".music-track-card")].find(
      (button) => button.textContent?.includes("Pulse Drums"),
    );
    const outro = [...container.querySelectorAll<HTMLElement>(".music-section-drop")].find(
      (section) => section.textContent?.includes("Outro"),
    );
    expect(track).not.toBeUndefined();
    expect(outro).not.toBeUndefined();
    track!.dispatchEvent(new Event("dragstart", { bubbles: true }));
    outro!.dispatchEvent(new Event("drop", { bubbles: true }));
    renderStudio(host, container);

    expect(container.textContent).toContain("Dropped Pulse Drums into Outro");
  });

  it("creates dedicated vocal and beat changes from the same prompt bar", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    chooseTarget(container, "vocals");
    renderStudio(host, container);
    typePrompt(container, "Add a call-and-response birthday vocal hook.");
    clickButton(container, "Apply Vocals");
    renderStudio(host, container);

    expect(container.textContent).toContain("Prompt Vocal");
    openMode(host, container, "Play");
    expect(container.textContent).toContain("say it like thunder");

    openMode(host, container, "Arrange");
    chooseTarget(container, "beat-drums");
    renderStudio(host, container);
    typePrompt(container, "Make the beat bounce with syncopated claps.");
    clickButton(container, "Apply Beat / Drums");
    renderStudio(host, container);

    expect(container.textContent).toContain("Prompt Beat");
  });

  it("keeps Play Now available from every major mode", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    for (const mode of ["Create", "Arrange", "Finish"] as const) {
      openMode(host, container, mode);
      clickButton(container, "Play Now");
      renderStudio(host, container);
      expect(container.textContent).toContain("Playing");
    }
  });

  it("finishes with export and provider handoff controls", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    openMode(host, container, "Finish");

    expect(container.textContent).toContain("Ready to export a music brief");
    expect(container.textContent).toContain("Export Project JSON");
    expect(container.textContent).toContain("Create Provider Packet");
    expect(container.textContent).toContain("music_generate");
    expect(container.textContent).toContain("Professional Details");

    clickButton(container, "Export Project JSON");
    renderStudio(host, container);
    expect(container.textContent).toContain("Project JSON");
    expect(container.textContent).toContain('"title"');

    clickButton(container, "GarageBand Bridge Plan");
    renderStudio(host, container);
    expect(container.textContent).toContain("GarageBand Bridge Plan");
    expect(container.textContent).toContain("Set tempo");
  });

  it("starts provider-backed audio generation from the dashboard", async () => {
    const requestSpy = vi.fn();
    const request: TestClientRequest = async <T>(method: string, params?: unknown): Promise<T> => {
      requestSpy(method, params);
      expect(method).toBe("tools.effective");
      return {
        groups: [
          {
            tools: [{ id: "music_generate" }],
          },
        ],
      } as T;
    };
    const handleSendChat = vi.fn(
      async (
        _messageOverride?: string,
        _opts?: { confirmReset?: boolean; restoreDraft?: boolean },
      ) => {},
    );
    const host = {
      requestUpdate: vi.fn(),
      connected: true,
      client: { request },
      sessionKey: "agent:main:dashboard:music-studio",
      handleSendChat,
    };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    typePrompt(container, 'Create "Dashboard Audio" with bright synths and a vocal hook.');
    clickButton(container, "Apply: Create Song");
    renderStudio(host, container);
    clickButton(container, "Generate Audio");
    await flushAsyncClicks();
    renderStudio(host, container);

    expect(requestSpy).toHaveBeenCalledWith("tools.effective", {
      agentId: "main",
      sessionKey: "agent:main:dashboard:music-studio",
    });
    expect(handleSendChat).toHaveBeenCalledTimes(1);
    const message = handleSendChat.mock.calls[0]?.[0] ?? "";
    expect(message).toContain("Use the `music_generate` tool exactly once");
    expect(message).toContain('"tool": "music_generate"');
    expect(message).toContain("Dashboard Audio");
    expect(container.textContent).toContain("Music generation was sent to the active chat.");
  });

  it("shows a clear setup blocker instead of silently doing nothing", async () => {
    const request: TestClientRequest = async <T>(): Promise<T> =>
      ({ groups: [{ tools: [] }] }) as T;
    const handleSendChat = vi.fn(
      async (
        _messageOverride?: string,
        _opts?: { confirmReset?: boolean; restoreDraft?: boolean },
      ) => {},
    );
    const host = {
      requestUpdate: vi.fn(),
      connected: true,
      client: { request },
      sessionKey: "agent:main:dashboard:music-studio",
      handleSendChat,
    };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    clickButton(container, "Generate Audio");
    await flushAsyncClicks();
    renderStudio(host, container);

    expect(handleSendChat).not.toHaveBeenCalled();
    expect(container.textContent).toContain("`music_generate` is not available");
    expect(container.textContent).toContain("Configure a music provider");
    expect(container.textContent).toContain("Music Generation Blocked");
  });

  it("offers recovery with snapshots and undo", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    clickButton(container, "Snapshot");
    renderStudio(host, container);

    expect(container.textContent).toContain("Snapshot saved locally");
    expect(container.textContent).toContain("Last snapshot");
    expect(container.textContent).toContain("Undo");
  });
});
