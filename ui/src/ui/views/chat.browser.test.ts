import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import "../../styles.css";
import { renderChat, type ChatProps } from "./chat.ts";

function createProps(overrides: Partial<ChatProps> = {}): ChatProps {
  return {
    sessionKey: "main",
    onSessionKeyChange: () => undefined,
    thinkingLevel: null,
    showThinking: false,
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
      defaults: { model: "gpt-5", contextTokens: null },
      sessions: [
        {
          key: "main",
          kind: "direct",
          updatedAt: null,
          inputTokens: 3_800,
          totalTokens: 3_800, // Now using totalTokens for banner calculation
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

describe("chat context notice", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps the warning icon badge-sized", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(renderChat(createProps()), container);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const icon = container.querySelector<SVGElement>(".context-notice__icon");
    expect(icon).not.toBeNull();
    if (!icon) {
      return;
    }

    const iconStyle = getComputedStyle(icon);
    expect(iconStyle.width).toBe("16px");
    expect(iconStyle.height).toBe("16px");
    expect(icon.getBoundingClientRect().width).toBeLessThan(24);
  });

  it("does not show banner when inputTokens is high but totalTokens is low", async () => {
    const container = document.createElement("div");
    document.body.append(container);

    // Create a session with high inputTokens but low totalTokens
    // The banner should not display because it now uses totalTokens instead
    const props = createProps({
      sessions: {
        ts: 0,
        path: "",
        count: 1,
        defaults: { model: "gpt-5", contextTokens: null },
        sessions: [
          {
            key: "main",
            kind: "direct",
            updatedAt: null,
            inputTokens: 3_800, // High inputTokens
            totalTokens: 100, // Low totalTokens (< 85% of contextTokens)
            contextTokens: 4_000,
          },
        ],
      },
    });

    render(renderChat(props), container);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const contextNotice = container.querySelector(".context-notice");
    expect(contextNotice).toBeNull(); // Banner should NOT be shown
  });
});
