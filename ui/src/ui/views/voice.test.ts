/* @vitest-environment jsdom */

import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderVoice, type VoiceViewProps } from "./voice.ts";

function baseProps(overrides: Partial<VoiceViewProps> = {}): VoiceViewProps {
  return {
    assistantName: "Red",
    userName: "Joey",
    sessionKey: "main",
    connected: true,
    realtimeTalkActive: false,
    realtimeTalkStatus: "idle",
    realtimeTalkDetail: null,
    realtimeTalkTranscript: null,
    realtimeTalkConversation: [],
    realtimeTalkOptionsOpen: false,
    realtimeTalkOptions: {
      provider: "",
      model: "",
      voice: "",
      transport: "",
      vadThreshold: "",
      silenceDurationMs: "",
      prefixPaddingMs: "",
      reasoningEffort: "",
    },
    onToggleRealtimeTalk: vi.fn(),
    onToggleRealtimeTalkOptions: vi.fn(),
    onRealtimeTalkOptionsChange: vi.fn(),
    onDismissRealtimeTalkError: vi.fn(),
    onOpenChat: vi.fn(),
    ...overrides,
  };
}

function renderVoiceView(props: VoiceViewProps = baseProps()) {
  const container = document.createElement("div");
  render(html`${renderVoice(props)}`, container);
  return container;
}

function requireButton(container: Element, label: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).toBeInstanceOf(HTMLButtonElement);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected button ${label}`);
  }
  return button;
}

describe("renderVoice", () => {
  it("renders the mobile voice start surface", () => {
    const container = renderVoiceView();

    expect(container.querySelector(".red-voice")?.textContent).toContain("Red");
    expect(container.querySelector(".red-voice__status-text")?.textContent).toBe("Ready");
    expect(container.querySelector(".red-voice__session")?.textContent).toBe("main");
    expect(requireButton(container, "Start Talk").textContent).toContain("Start Talk");
    expect(requireButton(container, "Voice settings").disabled).toBe(false);
  });

  it("renders the active end control and transcript turns", () => {
    const container = renderVoiceView(
      baseProps({
        realtimeTalkActive: true,
        realtimeTalkStatus: "listening",
        realtimeTalkConversation: [
          { id: "rt-1", role: "user", text: "What is next?", isStreaming: false },
          { id: "rt-2", role: "assistant", text: "Checking.", isStreaming: true },
        ],
      }),
    );

    expect(container.querySelector(".red-voice__status-text")?.textContent).toBe("Listening");
    expect(requireButton(container, "End Talk").textContent).toContain("End Talk");
    expect(requireButton(container, "Voice settings").disabled).toBe(true);
    expect(container.querySelector('[data-role="user"]')?.textContent).toContain("Joey");
    expect(container.querySelector('[data-role="assistant"]')?.textContent).toContain("Red");
  });

  it("updates voice options from the settings drawer", () => {
    const onChange = vi.fn();
    const container = renderVoiceView(
      baseProps({
        realtimeTalkOptionsOpen: true,
        onRealtimeTalkOptionsChange: onChange,
      }),
    );
    const voiceSelect = container.querySelector<HTMLSelectElement>(".red-voice__field select");
    expect(voiceSelect).toBeInstanceOf(HTMLSelectElement);
    if (!(voiceSelect instanceof HTMLSelectElement)) {
      throw new Error("Expected voice select");
    }

    voiceSelect.value = "cedar";
    voiceSelect.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onChange).toHaveBeenCalledWith({ voice: "cedar" });
  });
});
