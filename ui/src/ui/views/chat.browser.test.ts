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
});

describe("token usage indicator", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders token usage when session has totalTokens", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderChat(
        createProps({
          sessions: {
            ts: 0,
            path: "",
            count: 1,
            defaults: { model: "gpt-5", contextTokens: 128_000 },
            sessions: [
              {
                key: "main",
                kind: "direct",
                updatedAt: null,
                totalTokens: 21_000,
                contextTokens: 128_000,
              },
            ],
          },
        }),
      ),
      container,
    );
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const indicator = container.querySelector<HTMLElement>(".token-usage-indicator");
    expect(indicator).not.toBeNull();
    if (!indicator) {
      return;
    }
    const text = indicator.textContent ?? "";
    expect(text).toContain("21k");
    expect(text).toContain("128k");
    expect(text).toContain("16%");
  });

  it("hides indicator when totalTokens is zero", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderChat(
        createProps({
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
                totalTokens: 0,
              },
            ],
          },
        }),
      ),
      container,
    );
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const indicator = container.querySelector<HTMLElement>(".token-usage-indicator");
    expect(indicator).toBeNull();
  });
});
