/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../ui-types.ts";
import { cleanupChatModuleState, renderChat, type ChatProps } from "./chat.ts";

function createProps(overrides: Partial<ChatProps> = {}): ChatProps {
  return {
    sessionKey: "agent:main:main",
    onSessionKeyChange: () => undefined,
    thinkingLevel: null,
    showThinking: true,
    showToolCalls: true,
    loading: false,
    sending: false,
    canAbort: true,
    messages: [],
    toolMessages: [],
    streamSegments: [],
    stream: "Working...",
    streamStartedAt: 1,
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
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [{ key: "agent:main:main", kind: "direct", status: "running", updatedAt: null }],
    },
    focusMode: false,
    assistantName: "Test Agent",
    assistantAvatar: null,
    onRefresh: () => undefined,
    onToggleFocusMode: () => undefined,
    onDraftChange: () => undefined,
    onSend: () => undefined,
    onAbort: () => undefined,
    onQueueRemove: () => undefined,
    onNewSession: () => undefined,
    agentsList: { agents: [{ id: "main", name: "Main" }], defaultId: "main" },
    currentAgentId: "main",
    onAgentChange: () => undefined,
    ...overrides,
  };
}

function renderQueue(queue: ChatQueueItem[], onQueueSteer = vi.fn()) {
  const container = document.createElement("div");
  render(
    renderChat(
      createProps({
        queue,
        onQueueSteer,
      }),
    ),
    container,
  );
  return { container, onQueueSteer };
}

describe("chat view queue steering", () => {
  afterEach(() => {
    cleanupChatModuleState();
  });

  it("renders Steer only for queued messages during an active run", () => {
    const { container, onQueueSteer } = renderQueue([
      { id: "queued-1", text: "tighten the plan", createdAt: 1 },
      { id: "steered-1", text: "already sent", createdAt: 2, kind: "steered" },
      { id: "local-1", text: "/status", createdAt: 3, localCommandName: "status" },
    ]);
    const onQueueSteer = vi.fn();
    const container = renderQueue({
      onQueueSteer,
      queue: [
        { id: "queued-1", text: "tighten the plan", createdAt: 1 },
        { id: "steered-1", text: "already sent", createdAt: 2, kind: "steered" },
        { id: "local-1", text: "/status", createdAt: 3, localCommandName: "status" },
function clearDeleteConfirmSkip() {
  try {
    getSafeLocalStorage()?.removeItem("openclaw:skipDeleteConfirm");
  } catch {
    /* noop */
  }
}

describe("chat view", () => {
  it("renders the inline approval card only for the active session", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          sessions: {
            ...createSessions(),
            sessions: [
              { key: "main", kind: "direct", sessionId: "s1", updatedAt: 0, systemSent: false },
            ],
          },
          planApprovalRequest: {
            approvalId: "approval-1",
            sessionKey: "other-session",
            title: "Plan title",
            plan: [{ step: "Check routes", status: "pending" }],
            receivedAt: 0,
          },
          onPlanApprovalDecision: () => undefined,
        }),
      ),
      container,
    );

    expect(container.querySelector(".plan-inline-card")).toBeNull();
    expect(container.querySelector(".agent-chat__input")).not.toBeNull();
  });

  it("uses the assistant avatar URL or bundled logo fallbacks", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          assistantName: "Assistant",
          assistantAvatar: "A",
          assistantAvatarUrl: "/avatar/main",
        }),
      ),
      container,
    );

    const welcomeImage = container.querySelector<HTMLImageElement>(".agent-chat__welcome > img");
    expect(welcomeImage).not.toBeNull();
    expect(welcomeImage?.getAttribute("src")).toBe("/avatar/main");

    render(
      renderChat(
        createProps({
          assistantName: "Assistant",
          assistantAvatar: "A",
          assistantAvatarUrl: null,
          basePath: "/openclaw/",
        }),
      ),
      container,
    );
    const logoImage = container.querySelector<HTMLImageElement>(
      ".agent-chat__welcome .agent-chat__avatar--logo img",
    );
    expect(container.querySelector<HTMLImageElement>(".agent-chat__welcome > img")).toBeNull();
    expect(logoImage).not.toBeNull();
    expect(
      container
        .querySelector<HTMLImageElement>(".agent-chat__welcome .agent-chat__avatar--logo img")
        ?.getAttribute("src"),
    ).toBe("/openclaw/favicon.svg");

    renderAssistantMessage(
      container,
      {
        role: "assistant",
        content: "hello",
        timestamp: 1000,
      },
      { basePath: "/openclaw/" },
    );
    const groupedLogo = container.querySelector<HTMLImageElement>(
      ".chat-group.assistant .chat-avatar--logo",
    );
    expect(groupedLogo).not.toBeNull();
    expect(groupedLogo?.getAttribute("src")).toBe("/openclaw/favicon.svg");
  });

  it("renders compaction and fallback indicators while they are fresh", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now");

    try {
      nowSpy.mockReturnValue(1_000);
      render(
        renderChat(
          createProps({
            compactionStatus: {
              phase: "active",
              runId: "run-1",
              startedAt: 1_000,
              completedAt: null,
            },
          }),
        ),
        container,
      );

      let indicator = container.querySelector(".compaction-indicator--active");
      expect(indicator).not.toBeNull();
      expect(indicator?.textContent).toContain("Compacting context...");

      render(
        renderChat(
          createProps({
            compactionStatus: {
              phase: "complete",
              runId: "run-1",
              startedAt: 900,
              completedAt: 900,
            },
          }),
        ),
        container,
      );
      indicator = container.querySelector(".compaction-indicator--complete");
      expect(indicator).not.toBeNull();
      expect(indicator?.textContent).toContain("Context compacted");

      nowSpy.mockReturnValue(10_000);
      render(
        renderChat(
          createProps({
            compactionStatus: {
              phase: "complete",
              runId: "run-1",
              startedAt: 0,
              completedAt: 0,
            },
          }),
        ),
        container,
      );
      expect(container.querySelector(".compaction-indicator")).toBeNull();

      nowSpy.mockReturnValue(1_000);
      render(
        renderChat(
          createProps({
            fallbackStatus: {
              selected: "fireworks/minimax-m2p5",
              active: "deepinfra/moonshotai/Kimi-K2.5",
              attempts: ["fireworks/minimax-m2p5: rate limit"],
              occurredAt: 900,
            },
          }),
        ),
        container,
      );
      indicator = container.querySelector(".compaction-indicator--fallback");
      expect(indicator).not.toBeNull();
      expect(indicator?.textContent).toContain("Fallback active: deepinfra/moonshotai/Kimi-K2.5");

      nowSpy.mockReturnValue(20_000);
      render(
        renderChat(
          createProps({
            fallbackStatus: {
              selected: "fireworks/minimax-m2p5",
              active: "deepinfra/moonshotai/Kimi-K2.5",
              attempts: [],
              occurredAt: 0,
            },
          }),
        ),
        container,
      );
      expect(container.querySelector(".compaction-indicator--fallback")).toBeNull();

      nowSpy.mockReturnValue(1_000);
      render(
        renderChat(
          createProps({
            fallbackStatus: {
              phase: "cleared",
              selected: "fireworks/minimax-m2p5",
              active: "fireworks/minimax-m2p5",
              previous: "deepinfra/moonshotai/Kimi-K2.5",
              attempts: [],
              occurredAt: 900,
            },
          }),
        ),
        container,
      );
      indicator = container.querySelector(".compaction-indicator--fallback-cleared");
      expect(indicator).not.toBeNull();
      expect(indicator?.textContent).toContain("Fallback cleared: fireworks/minimax-m2p5");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("renders the run action button for abortable and idle states", () => {
    const container = document.createElement("div");
    const onAbort = vi.fn();
    render(
      renderChat(
        createProps({
          canAbort: true,
          sending: true,
          onAbort,
        }),
      ),
      container,
    );

    let stopButton = container.querySelector<HTMLButtonElement>('button[title="Stop"]');
    expect(stopButton).not.toBeUndefined();
    stopButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("New session");

    render(
      renderChat(
        createProps({
          canAbort: true,
          sending: false,
          stream: null,
          onAbort: vi.fn(),
        }),
      ),
      container,
    );
    stopButton = container.querySelector<HTMLButtonElement>('button[title="Stop"]');
    expect(stopButton).not.toBeNull();
    expect(container.textContent).not.toContain("New session");

    const onNewSession = vi.fn();
    render(
      renderChat(
        createProps({
          canAbort: false,
          onNewSession,
        }),
      ),
      container,
    );

    const newSessionButton = container.querySelector<HTMLButtonElement>(
      'button[title="New session"]',
    );
    expect(newSessionButton).not.toBeUndefined();
    newSessionButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onNewSession).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("Stop");
  });

  it("keeps consecutive user messages from different senders in separate groups", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "user",
              content: "first",
              senderLabel: "Iris",
              timestamp: 1000,
            },
            {
              role: "user",
              content: "second",
              senderLabel: "Joaquin De Rojas",
              timestamp: 1001,
            },
          ],
        }),
      ),
      container,
    );

    const groups = container.querySelectorAll(".chat-group.user");
    expect(groups).toHaveLength(2);
    const senderLabels = Array.from(container.querySelectorAll(".chat-sender-name")).map((node) =>
      node.textContent?.trim(),
    );
    expect(senderLabels).toContain("Iris");
    expect(senderLabels).toContain("Joaquin De Rojas");
    expect(senderLabels).not.toContain("You");
  });

  it("positions delete confirm by message side", () => {
    clearDeleteConfirmSkip();
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "user",
              content: "hello from user",
              timestamp: 1000,
            },
          ],
        }),
      ),
      container,
    );

    const userDeleteButton = container.querySelector<HTMLButtonElement>(
      ".chat-group.user .chat-group-delete",
    );
    expect(userDeleteButton).not.toBeNull();
    userDeleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const userConfirm = container.querySelector<HTMLElement>(
      ".chat-group.user .chat-delete-confirm",
    );
    expect(userConfirm).not.toBeNull();
    expect(userConfirm?.classList.contains("chat-delete-confirm--left")).toBe(true);

    clearDeleteConfirmSkip();
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "assistant",
              content: "hello from assistant",
              timestamp: 1000,
            },
          ],
        }),
      ),
      container,
    );

    const assistantDeleteButton = container.querySelector<HTMLButtonElement>(
      ".chat-group.assistant .chat-group-delete",
    );
    expect(assistantDeleteButton).not.toBeNull();
    assistantDeleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const assistantConfirm = container.querySelector<HTMLElement>(
      ".chat-group.assistant .chat-delete-confirm",
    );
    expect(assistantConfirm).not.toBeNull();
    expect(assistantConfirm?.classList.contains("chat-delete-confirm--right")).toBe(true);
  });

  it("keeps tool cards collapsed by default and expands them inline on demand", async () => {
    const container = document.createElement("div");
    const props = createProps({
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          toolCallId: "call-1",
          content: [
            {
              type: "toolcall",
              id: "call-1",
              name: "browser.open",
              arguments: { url: "https://example.com" },
            },
            {
              type: "toolresult",
              id: "call-1",
              name: "browser.open",
              text: "Opened page",
            },
          ],
          timestamp: Date.now(),
        },
      ],
    });

    const steerButtons = container.querySelectorAll<HTMLButtonElement>(".chat-queue__steer");
    expect(steerButtons).toHaveLength(1);
    expect(steerButtons[0].textContent?.trim()).toBe("Steer");
    expect(container.querySelector(".chat-queue__badge")?.textContent?.trim()).toBe("Steered");

    steerButtons[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onQueueSteer).toHaveBeenCalledWith("queued-1");
  });

  it("hides queued-message Steer when no run is active", () => {
    const { container } = renderQueue(
      [{ id: "queued-1", text: "tighten the plan", createdAt: 1 }],
      vi.fn(),
    );
    render(
      renderChat(
        createProps({
          canAbort: false,
          stream: null,
          queue: [{ id: "queued-1", text: "tighten the plan", createdAt: 1 }],
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-queue__steer")).toBeNull();
  });
});

describe("renderChat", () => {
  afterEach(() => {
    cleanupChatModuleState();
  });

  it("renders configured assistant text avatars in transcript groups", () => {
    const container = document.createElement("div");

    render(
      renderChat(
        createProps({
          assistantName: "Val",
          assistantAvatar: "VC",
          assistantAvatarUrl: null,
          messages: [{ role: "assistant", content: "hello", timestamp: 1000 }],
          stream: null,
          streamStartedAt: null,
        }),
      ),
      container,
    );

    const avatar = container.querySelector<HTMLElement>(".chat-group.assistant .chat-avatar");
    expect(avatar).not.toBeNull();
    expect(avatar?.tagName).toBe("DIV");
    expect(avatar?.textContent).toContain("VC");
    expect(avatar?.getAttribute("aria-label")).toBe("Val");
  });
});
