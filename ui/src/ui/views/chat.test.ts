/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderChatSessionSelect } from "../app-render.helpers.ts";
import type { AppViewState } from "../app-view-state.ts";
import type { ChatInputHistoryKeyResult } from "../chat/input-history.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { ModelCatalogEntry } from "../types.ts";
import type { SessionsListResult } from "../types.ts";
import { renderChat, type ChatProps } from "./chat.ts";

function createSessions(): SessionsListResult {
  return {
    ts: 0,
    path: "",
    count: 0,
    defaults: { model: null, contextTokens: null },
    sessions: [],
  };
}

function createChatHeaderState(
  overrides: {
    model?: string | null;
    models?: ModelCatalogEntry[];
    omitSessionFromList?: boolean;
  } = {},
): { state: AppViewState; request: ReturnType<typeof vi.fn> } {
  let currentModel = overrides.model ?? null;
  const omitSessionFromList = overrides.omitSessionFromList ?? false;
  const catalog = overrides.models ?? [
    { id: "gpt-5", name: "GPT-5", provider: "openai" },
    { id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai" },
  ];
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "sessions.patch") {
      currentModel = (params.model as string | null | undefined) ?? null;
      return { ok: true, key: "main" };
    }
    if (method === "chat.history") {
      return { messages: [], thinkingLevel: null };
    }
    if (method === "sessions.list") {
      return {
        ts: 0,
        path: "",
        count: omitSessionFromList ? 0 : 1,
        defaults: { model: "gpt-5", contextTokens: null },
        sessions: omitSessionFromList
          ? []
          : [{ key: "main", kind: "direct", updatedAt: null, model: currentModel }],
      };
    }
    if (method === "models.list") {
      return { models: catalog };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const state = {
    sessionKey: "main",
    connected: true,
    sessionsHideCron: true,
    sessionsResult: {
      ts: 0,
      path: "",
      count: omitSessionFromList ? 0 : 1,
      defaults: { model: "gpt-5", contextTokens: null },
      sessions: omitSessionFromList
        ? []
        : [{ key: "main", kind: "direct", updatedAt: null, model: currentModel }],
    },
    chatModelOverrides: {},
    chatModelCatalog: catalog,
    chatModelsLoading: false,
    client: { request } as unknown as GatewayBrowserClient,
    settings: {
      gatewayUrl: "",
      token: "",
      locale: "en",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "dark",
      splitRatio: 0.6,
      navCollapsed: false,
      navGroupsCollapsed: {},
      chatFocusMode: false,
      chatShowThinking: false,
    },
    chatMessage: "",
    chatStream: null,
    chatStreamStartedAt: null,
    chatRunId: null,
    chatQueue: [],
    chatMessages: [],
    chatLoading: false,
    chatThinkingLevel: null,
    lastError: null,
    chatAvatarUrl: null,
    basePath: "",
    hello: null,
    agentsList: null,
    applySettings(next: AppViewState["settings"]) {
      state.settings = next;
    },
    loadAssistantIdentity: vi.fn(),
    resetToolStream: vi.fn(),
    resetChatScroll: vi.fn(),
  } as unknown as AppViewState & {
    client: GatewayBrowserClient;
    settings: AppViewState["settings"];
  };
  return { state, request };
}

function flushTasks() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
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

function createKeyResult(
  overrides: Partial<ChatInputHistoryKeyResult> = {},
): ChatInputHistoryKeyResult {
  return {
    handled: false,
    preventDefault: false,
    restoreCaret: null,
    decision: "blocked:arrowup-not-at-start",
    historyNavigationActiveBefore: false,
    historyNavigationActiveAfter: false,
    selectionStart: 0,
    selectionEnd: 0,
    valueLength: 0,
    ...overrides,
  };
}

describe("chat view", () => {
  it("uses the assistant avatar URL for the welcome state when the identity avatar is only initials", () => {
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
  });

  it("falls back to the bundled logo in the welcome state when the assistant avatar is not a URL", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          assistantName: "Assistant",
          assistantAvatar: "A",
          assistantAvatarUrl: null,
        }),
      ),
      container,
    );

    const welcomeImage = container.querySelector<HTMLImageElement>(".agent-chat__welcome > img");
    const logoImage = container.querySelector<HTMLImageElement>(
      ".agent-chat__welcome .agent-chat__avatar--logo img",
    );
    expect(welcomeImage).toBeNull();
    expect(logoImage).not.toBeNull();
    expect(logoImage?.getAttribute("src")).toBe("favicon.svg");
  });

  it("keeps the welcome logo fallback under the mounted base path", () => {
    const container = document.createElement("div");
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
    expect(logoImage).not.toBeNull();
    expect(logoImage?.getAttribute("src")).toBe("/openclaw/favicon.svg");
  });

  it("keeps grouped assistant avatar fallbacks under the mounted base path", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          assistantName: "Assistant",
          assistantAvatar: "A",
          assistantAvatarUrl: null,
          basePath: "/openclaw/",
          messages: [
            {
              role: "assistant",
              content: "hello",
              timestamp: 1000,
            },
          ],
        }),
      ),
      container,
    );

    const groupedLogo = container.querySelector<HTMLImageElement>(
      ".chat-group.assistant .chat-avatar--logo",
    );
    expect(groupedLogo).not.toBeNull();
    expect(groupedLogo?.getAttribute("src")).toBe("/openclaw/favicon.svg");
  });

  it("renders compacting indicator as a badge", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          compactionStatus: {
            active: true,
            startedAt: Date.now(),
            completedAt: null,
          },
        }),
      ),
      container,
    );

    const indicator = container.querySelector(".compaction-indicator--active");
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toContain("Compacting context...");
  });

  it("renders completion indicator shortly after compaction", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    render(
      renderChat(
        createProps({
          compactionStatus: {
            active: false,
            startedAt: 900,
            completedAt: 900,
          },
        }),
      ),
      container,
    );

    const indicator = container.querySelector(".compaction-indicator--complete");
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toContain("Context compacted");
    nowSpy.mockRestore();
  });

  it("hides stale compaction completion indicator", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(10_000);
    render(
      renderChat(
        createProps({
          compactionStatus: {
            active: false,
            startedAt: 0,
            completedAt: 0,
          },
        }),
      ),
      container,
    );

    expect(container.querySelector(".compaction-indicator")).toBeNull();
    nowSpy.mockRestore();
  });

  it("renders fallback indicator shortly after fallback event", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
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

    const indicator = container.querySelector(".compaction-indicator--fallback");
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toContain("Fallback active: deepinfra/moonshotai/Kimi-K2.5");
    nowSpy.mockRestore();
  });

  it("hides stale fallback indicator", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(20_000);
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
    nowSpy.mockRestore();
  });

  it("renders fallback-cleared indicator shortly after transition", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
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

    const indicator = container.querySelector(".compaction-indicator--fallback-cleared");
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toContain("Fallback cleared: fireworks/minimax-m2p5");
    nowSpy.mockRestore();
  });

  it("shows a stop button when aborting is available", () => {
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

    const stopButton = container.querySelector<HTMLButtonElement>('button[title="Stop"]');
    expect(stopButton).not.toBeUndefined();
    stopButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("New session");
  });

  it("shows a new session button when aborting is unavailable", () => {
    const container = document.createElement("div");
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

  it("shows sender labels from sanitized gateway messages instead of generic You", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "user",
              content: "hello from topic",
              senderLabel: "Iris",
              timestamp: 1000,
            },
          ],
        }),
      ),
      container,
    );

    const senderLabels = Array.from(container.querySelectorAll(".chat-sender-name")).map((node) =>
      node.textContent?.trim(),
    );
    expect(senderLabels).toContain("Iris");
    expect(senderLabels).not.toContain("You");
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
  });

  it("opens delete confirm on the left for user messages", () => {
    try {
      localStorage.removeItem("openclaw:skipDeleteConfirm");
    } catch {
      /* noop */
    }
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

    const deleteButton = container.querySelector<HTMLButtonElement>(
      ".chat-group.user .chat-group-delete",
    );
    expect(deleteButton).not.toBeNull();
    deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const confirm = container.querySelector<HTMLElement>(".chat-group.user .chat-delete-confirm");
    expect(confirm).not.toBeNull();
    expect(confirm?.classList.contains("chat-delete-confirm--left")).toBe(true);
  });

  it("opens delete confirm on the right for assistant messages", () => {
    try {
      localStorage.removeItem("openclaw:skipDeleteConfirm");
    } catch {
      /* noop */
    }
    const container = document.createElement("div");
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

    const deleteButton = container.querySelector<HTMLButtonElement>(
      ".chat-group.assistant .chat-group-delete",
    );
    expect(deleteButton).not.toBeNull();
    deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const confirm = container.querySelector<HTMLElement>(
      ".chat-group.assistant .chat-delete-confirm",
    );
    expect(confirm).not.toBeNull();
    expect(confirm?.classList.contains("chat-delete-confirm--right")).toBe(true);
  });

  it("navigates history up when cursor is at start of draft", () => {
    const container = document.createElement("div");
    const onHistoryKeydown = vi.fn(() =>
      createKeyResult({
        handled: true,
        preventDefault: true,
        restoreCaret: "up",
        decision: "handled:enter-history-up",
        historyNavigationActiveAfter: true,
      }),
    );
    render(
      renderChat(
        createProps({
          draft: "hello",
          onHistoryKeydown,
        }),
      ),
      container,
    );

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    textarea.selectionStart = 0;
    textarea.selectionEnd = 0;
    const event = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
    textarea.dispatchEvent(event);

    expect(onHistoryKeydown).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not navigate history up when cursor is not at start", () => {
    const container = document.createElement("div");
    const onHistoryKeydown = vi.fn(() => createKeyResult());
    render(
      renderChat(
        createProps({
          draft: "hello",
          onHistoryKeydown,
        }),
      ),
      container,
    );

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    textarea.selectionStart = 2;
    textarea.selectionEnd = 2;
    const event = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
    textarea.dispatchEvent(event);

    expect(onHistoryKeydown).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
  });

  it("patches the current session model from the chat header picker", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
      } satisfies Partial<Response>),
    );
    const { state, request } = createChatHeaderState();
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(modelSelect).not.toBeNull();
    expect(modelSelect?.value).toBe("");

    modelSelect!.value = "gpt-5-mini";
    modelSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await flushTasks();

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "main",
      model: "gpt-5-mini",
    });
    expect(request).not.toHaveBeenCalledWith("chat.history", expect.anything());
    expect(state.sessionsResult?.sessions[0]?.model).toBe("gpt-5-mini");
    vi.unstubAllGlobals();
  });

  it("clears the session model override back to the default model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
      } satisfies Partial<Response>),
    );
    const { state, request } = createChatHeaderState({ model: "gpt-5-mini" });
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(modelSelect).not.toBeNull();
    expect(modelSelect?.value).toBe("gpt-5-mini");

    modelSelect!.value = "";
    modelSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await flushTasks();

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "main",
      model: null,
    });
    expect(state.sessionsResult?.sessions[0]?.model).toBeNull();
    vi.unstubAllGlobals();
  });

  it("disables the chat header model picker while a run is active", () => {
    const { state } = createChatHeaderState();
    state.chatRunId = "run-123";
    state.chatStream = "Working";
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(modelSelect).not.toBeNull();
    expect(modelSelect?.disabled).toBe(true);
  });

  it("keeps the selected model visible when the active session is absent from sessions.list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
      } satisfies Partial<Response>),
    );
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(modelSelect).not.toBeNull();

    modelSelect!.value = "gpt-5-mini";
    modelSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await flushTasks();
    render(renderChatSessionSelect(state), container);

    const rerendered = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(rerendered?.value).toBe("gpt-5-mini");
    vi.unstubAllGlobals();
  });

  it("prefers the session label over displayName in the grouped chat session selector", () => {
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    state.sessionKey = "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b";
    state.settings.sessionKey = state.sessionKey;
    state.sessionsResult = {
      ts: 0,
      path: "",
      count: 1,
      defaults: { model: "gpt-5", contextTokens: null },
      sessions: [
        {
          key: state.sessionKey,
          kind: "direct",
          updatedAt: null,
          label: "cron-config-check",
          displayName: "webchat:g-agent-main-subagent-4f2146de-887b-4176-9abe-91140082959b",
        },
      ],
    };
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const [sessionSelect] = Array.from(container.querySelectorAll<HTMLSelectElement>("select"));
    const labels = Array.from(sessionSelect?.querySelectorAll("option") ?? []).map((option) =>
      option.textContent?.trim(),
    );

    expect(labels).toContain("Subagent: cron-config-check");
    expect(labels).not.toContain(state.sessionKey);
    expect(labels).not.toContain(
      "subagent:4f2146de-887b-4176-9abe-91140082959b · webchat:g-agent-main-subagent-4f2146de-887b-4176-9abe-91140082959b",
    );
  });

  it("keeps a unique scoped fallback when the current grouped session is missing from sessions.list", () => {
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    state.sessionKey = "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b";
    state.settings.sessionKey = state.sessionKey;
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const [sessionSelect] = Array.from(container.querySelectorAll<HTMLSelectElement>("select"));
    const labels = Array.from(sessionSelect?.querySelectorAll("option") ?? []).map((option) =>
      option.textContent?.trim(),
    );

    expect(labels).toContain("subagent:4f2146de-887b-4176-9abe-91140082959b");
    expect(labels).not.toContain("Subagent:");
  });

  it("keeps a unique scoped fallback when a grouped session row has no label or displayName", () => {
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    state.sessionKey = "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b";
    state.settings.sessionKey = state.sessionKey;
    state.sessionsResult = {
      ts: 0,
      path: "",
      count: 1,
      defaults: { model: "gpt-5", contextTokens: null },
      sessions: [
        {
          key: state.sessionKey,
          kind: "direct",
          updatedAt: null,
        },
      ],
    };
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const [sessionSelect] = Array.from(container.querySelectorAll<HTMLSelectElement>("select"));
    const labels = Array.from(sessionSelect?.querySelectorAll("option") ?? []).map((option) =>
      option.textContent?.trim(),
    );

    expect(labels).toContain("subagent:4f2146de-887b-4176-9abe-91140082959b");
    expect(labels).not.toContain("Subagent:");
  });

  it("disambiguates duplicate grouped labels with the scoped key suffix", () => {
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    state.sessionKey = "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b";
    state.settings.sessionKey = state.sessionKey;
    state.sessionsResult = {
      ts: 0,
      path: "",
      count: 2,
      defaults: { model: "gpt-5", contextTokens: null },
      sessions: [
        {
          key: "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b",
          kind: "direct",
          updatedAt: null,
          label: "cron-config-check",
        },
        {
          key: "agent:main:subagent:6fb8b84b-c31f-410f-b7df-1553c82e43c9",
          kind: "direct",
          updatedAt: null,
          label: "cron-config-check",
        },
      ],
    };
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const [sessionSelect] = Array.from(container.querySelectorAll<HTMLSelectElement>("select"));
    const labels = Array.from(sessionSelect?.querySelectorAll("option") ?? []).map((option) =>
      option.textContent?.trim(),
    );

    expect(labels).toContain(
      "Subagent: cron-config-check · subagent:4f2146de-887b-4176-9abe-91140082959b",
    );
    expect(labels).toContain(
      "Subagent: cron-config-check · subagent:6fb8b84b-c31f-410f-b7df-1553c82e43c9",
    );
    expect(labels).not.toContain("Subagent: cron-config-check");
  });

  it("passes handled ArrowDown results through", () => {
    const container = document.createElement("div");
    const onHistoryKeydown = vi.fn(() =>
      createKeyResult({
        handled: true,
        preventDefault: true,
        restoreCaret: "down",
        decision: "handled:history-down",
        historyNavigationActiveBefore: true,
        historyNavigationActiveAfter: true,
      }),
    );
    render(
      renderChat(
        createProps({
          draft: "hello",
          onHistoryKeydown,
        }),
      ),
      container,
    );

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    textarea.selectionStart = textarea.value.length;
    textarea.selectionEnd = textarea.value.length;
    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(event);

    expect(onHistoryKeydown).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("passes blocked ArrowDown results through without preventing default", () => {
    const container = document.createElement("div");
    const onHistoryKeydown = vi.fn(() =>
      createKeyResult({
        decision: "blocked:arrowdown-editing-mode",
      }),
    );
    render(
      renderChat(
        createProps({
          draft: "hello",
          onHistoryKeydown,
        }),
      ),
      container,
    );

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    textarea.selectionStart = 2;
    textarea.selectionEnd = 2;
    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(event);

    expect(onHistoryKeydown).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
  });

  it("passes handled ArrowDown results through even if caret is at start", () => {
    const container = document.createElement("div");
    const onHistoryKeydown = vi.fn(() =>
      createKeyResult({
        handled: true,
        preventDefault: true,
        restoreCaret: "down",
        decision: "handled:history-down",
        historyNavigationActiveBefore: true,
        historyNavigationActiveAfter: true,
      }),
    );
    render(
      renderChat(
        createProps({
          draft: "hello",
          onHistoryKeydown,
        }),
      ),
      container,
    );

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    textarea.selectionStart = 0;
    textarea.selectionEnd = 0;
    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(event);

    expect(onHistoryKeydown).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("passes handled ArrowUp results through even if caret is at end", () => {
    const container = document.createElement("div");
    const onHistoryKeydown = vi.fn(() =>
      createKeyResult({
        handled: true,
        preventDefault: true,
        restoreCaret: "up",
        decision: "handled:history-up",
        historyNavigationActiveBefore: true,
        historyNavigationActiveAfter: true,
      }),
    );
    render(
      renderChat(
        createProps({
          draft: "hello",
          onHistoryKeydown,
        }),
      ),
      container,
    );

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    textarea.selectionStart = textarea.value.length;
    textarea.selectionEnd = textarea.value.length;
    const event = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(event);

    expect(onHistoryKeydown).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("forwards raw key context to history handler", () => {
    const container = document.createElement("div");
    const onHistoryKeydown = vi.fn(() =>
      createKeyResult({
        handled: true,
        preventDefault: true,
        restoreCaret: "up",
        decision: "handled:history-up",
        historyNavigationActiveBefore: true,
        historyNavigationActiveAfter: true,
      }),
    );
    render(
      renderChat(
        createProps({
          draft: "hello",
          onHistoryKeydown,
        }),
      ),
      container,
    );

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    textarea.selectionStart = textarea.value.length;
    textarea.selectionEnd = textarea.value.length;
    const event = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(event);

    expect(onHistoryKeydown).toHaveBeenCalledTimes(1);
    expect(onHistoryKeydown).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "ArrowUp",
        selectionStart: textarea.value.length,
        selectionEnd: textarea.value.length,
        valueLength: textarea.value.length,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        isComposing: false,
      }),
    );
    expect(event.defaultPrevented).toBe(true);
  });

  it("keeps caret at start after ArrowUp history navigation updates draft", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    let draft = "newest";
    const renderCurrent = () => {
      render(
        renderChat(
          createProps({
            draft,
            onHistoryKeydown,
          }),
        ),
        container,
      );
    };
    const onHistoryKeydown = vi.fn(() => {
      draft = "older-entry";
      renderCurrent();
      return createKeyResult({
        handled: true,
        preventDefault: true,
        restoreCaret: "up",
        decision: "handled:enter-history-up",
        historyNavigationActiveAfter: true,
      });
    });

    renderCurrent();
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    textarea.focus();
    textarea.selectionStart = 0;
    textarea.selectionEnd = 0;
    const event = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
    textarea.dispatchEvent(event);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(onHistoryKeydown).toHaveBeenCalledTimes(1);
    expect(textarea.selectionStart).toBe(0);
    expect(textarea.selectionEnd).toBe(0);
    container.remove();
  });

  it("shrinks textarea height after history navigation restores a shorter draft", async () => {
    const container = document.createElement("div");
    let draft = "very long history entry";
    const renderCurrent = () => {
      render(
        renderChat(
          createProps({
            draft,
            onHistoryKeydown,
          }),
        ),
        container,
      );
    };
    const onHistoryKeydown = vi.fn(() => {
      draft = "short";
      renderCurrent();
      return createKeyResult({
        handled: true,
        preventDefault: true,
        restoreCaret: "down",
        decision: "handled:history-down",
        historyNavigationActiveBefore: true,
      });
    });

    renderCurrent();
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: () => 40,
    });
    textarea.style.height = "140px";
    textarea.selectionStart = 0;
    textarea.selectionEnd = 0;
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(onHistoryKeydown).toHaveBeenCalledTimes(1);
    expect(textarea.style.height).toBe("40px");
    expect(textarea.selectionStart).toBe(textarea.value.length);
    expect(textarea.selectionEnd).toBe(textarea.value.length);
  });
});
