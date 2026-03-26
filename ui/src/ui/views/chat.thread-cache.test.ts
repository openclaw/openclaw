/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionsListResult } from "../types.ts";

const { renderMessageGroupMock } = vi.hoisted(() => ({
  renderMessageGroupMock: vi.fn(() => html`<div class="mock-message-group"></div>`),
}));

vi.mock("../chat/grouped-render.ts", () => ({
  renderMessageGroup: renderMessageGroupMock,
  renderReadingIndicatorGroup: () => html`<div class="mock-reading-indicator"></div>`,
  renderStreamingGroup: () => html`<div class="mock-streaming-group"></div>`,
}));

import { cleanupChatModuleState, renderChat, type ChatProps } from "./chat.ts";

function createSessions(): SessionsListResult {
  return {
    ts: 0,
    path: "",
    count: 0,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [],
  };
}

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
    sessions: createSessions(),
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

describe("chat thread caching", () => {
  afterEach(() => {
    cleanupChatModuleState();
    renderMessageGroupMock.mockClear();
    document.body.innerHTML = "";
  });

  it("does not rebuild the message thread when only the draft changes", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const baseProps = createProps({
      messages: [{ id: "m1", role: "assistant", content: "Hello", timestamp: 1 }],
    });

    render(renderChat(baseProps), container);
    expect(renderMessageGroupMock).toHaveBeenCalledTimes(1);

    render(renderChat({ ...baseProps, draft: "H" }), container);
    expect(renderMessageGroupMock).toHaveBeenCalledTimes(1);
  });

  it("rebuilds the message thread when the message list changes", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const baseProps = createProps({
      messages: [{ id: "m1", role: "assistant", content: "Hello", timestamp: 1 }],
    });

    render(renderChat(baseProps), container);
    const initialCallCount = renderMessageGroupMock.mock.calls.length;

    render(
      renderChat({
        ...baseProps,
        messages: [
          ...baseProps.messages,
          { id: "m2", role: "user", content: "Hi", timestamp: 2 },
        ],
      }),
      container,
    );

    expect(renderMessageGroupMock.mock.calls.length).toBeGreaterThan(initialCallCount);
  });
});
