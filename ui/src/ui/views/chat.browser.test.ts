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
          totalTokens: 3_800,
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

  it("uses totalTokens not inputTokens for context usage (#46632)", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    // inputTokens is cumulative (inflated), totalTokens reflects actual context
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
            inputTokens: 647_600, // cumulative across all API calls
            totalTokens: 173_000, // actual current context window
            contextTokens: 200_000,
          },
        ],
      },
    });
    render(renderChat(props), container);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const detail = container.querySelector(".context-notice__detail");
    expect(detail).not.toBeNull();
    // Should show 173k (totalTokens), not 647.6k (inputTokens)
    expect(detail!.textContent).toContain("173k");
    expect(detail!.textContent).not.toContain("647");
  });

  it("hides context notice when totalTokens is below 85% threshold", async () => {
    const container = document.createElement("div");
    document.body.append(container);
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
            inputTokens: 300_000, // cumulative is high
            totalTokens: 100_000, // actual context is only 50%
            contextTokens: 200_000,
          },
        ],
      },
    });
    render(renderChat(props), container);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const notice = container.querySelector(".context-notice");
    expect(notice).toBeNull();
  });
});
