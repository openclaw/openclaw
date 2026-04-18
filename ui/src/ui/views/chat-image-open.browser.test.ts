import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../test-helpers/load-styles.ts";
import { renderChat, type ChatProps } from "./chat.ts";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function createProps(overrides: Partial<ChatProps> = {}): ChatProps {
  return {
    sessionKey: "main",
    onSessionKeyChange: () => undefined,
    thinkingLevel: null,
    showThinking: false,
    showToolCalls: true,
    loading: false,
    sending: false,
    canAbort: false,
    compactionStatus: null,
    fallbackStatus: null,
    messages: [],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    assistantAvatarUrl: null,
    draft: "",
    queue: [],
    connected: true,
    canSend: true,
    disabledReason: null,
    error: null,
    sessions: {
      ts: 0,
      path: "",
      count: 1,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [
        {
          key: "main",
          kind: "direct",
          updatedAt: null,
          inputTokens: 3_800,
          contextTokens: 4_000,
        },
      ],
    },
    focusMode: false,
    assistantName: "OpenClaw",
    assistantAvatar: null,
    onRefresh: () => undefined,
    onToggleFocusMode: () => undefined,
    onDraftChange: () => undefined,
    onSend: () => undefined,
    onQueueRemove: () => undefined,
    onNewSession: () => undefined,
    agentsList: null,
    currentAgentId: "",
    onAgentChange: () => undefined,
    ...overrides,
  };
}

function renderAssistantImage(url: string) {
  return {
    role: "assistant",
    content: [{ type: "image_url", image_url: { url } }],
    timestamp: Date.now(),
  };
}

async function renderImageChat(url: string) {
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderChat(
      createProps({
        messages: [renderAssistantImage(url)],
      }),
    ),
    container,
  );
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  return container;
}

describe("chat image open safety", () => {
  it("opens safe image URLs in a hardened new tab", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const container = await renderImageChat("https://example.com/cat.png");

    const image = container.querySelector<HTMLImageElement>(".chat-message-image");
    expect(image).not.toBeNull();
    image?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(
      "https://example.com/cat.png",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("does not open unsafe image URLs", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const container = await renderImageChat("javascript:alert(1)");

    expect(container.querySelector(".chat-message-image")).toBeNull();
    expect(container.querySelector(".chat-message-image-unavailable")).not.toBeNull();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("does not open SVG data image URLs", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const container = await renderImageChat(
      "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' />",
    );

    expect(container.querySelector(".chat-message-image")).toBeNull();
    expect(container.querySelector(".chat-message-image-unavailable")).not.toBeNull();
    expect(openSpy).not.toHaveBeenCalled();
  });
});
