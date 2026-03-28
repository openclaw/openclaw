import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../styles.css";
import { renderChat, type ChatProps } from "./chat.ts";

const contextNoticeSessions: ChatProps["sessions"] = {
  ts: 0,
  path: "",
  count: 1,
  defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
  sessions: [
    {
      key: "main",
      kind: "direct",
      updatedAt: null,
      totalTokens: 3_800,
      inputTokens: 3_800,
      contextTokens: 4_000,
    },
  ],
};

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
    onRenameSession: () => undefined,
    agentsList: null,
    currentAgentId: "",
    onAgentChange: () => undefined,
    ...overrides,
  };
}

async function renderContextNoticeChat() {
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderChat(
      createProps({
        sessions: contextNoticeSessions,
      }),
    ),
    container,
  );
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  return container;
}

describe("chat context notice", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("falls back to default notice colors when theme vars are not hex", async () => {
    document.documentElement.style.setProperty("--warn", "rgb(1, 2, 3)");
    document.documentElement.style.setProperty("--danger", "tomato");
    const container = await renderContextNoticeChat();

    const notice = container.querySelector<HTMLElement>(".context-notice");
    expect(notice).not.toBeNull();
    expect(notice?.style.getPropertyValue("--ctx-color")).toContain("rgb(");
    expect(notice?.style.getPropertyValue("--ctx-color")).not.toContain("NaN");
    expect(notice?.style.getPropertyValue("--ctx-bg")).not.toContain("NaN");

    document.documentElement.style.removeProperty("--warn");
    document.documentElement.style.removeProperty("--danger");
  });

  it("keeps the warning icon badge-sized", async () => {
    const container = await renderContextNoticeChat();

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

  it("fires the new chat and rename chat toolbar actions", async () => {
    const onNewSession = vi.fn();
    const onRenameSession = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderChat(
        createProps({
          onNewSession,
          onRenameSession,
        }),
      ),
      container,
    );
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    container.querySelector<HTMLButtonElement>('button[title="New chat"]')?.click();
    container.querySelector<HTMLButtonElement>('button[title="Rename chat"]')?.click();

    expect(onNewSession).toHaveBeenCalledTimes(1);
    expect(onRenameSession).toHaveBeenCalledTimes(1);
  });
});
