/* @vitest-environment jsdom */

import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import {
  createNewChatSession,
  renderChatModelSelect,
  renderChatSidebarSection,
} from "../app-render.helpers.ts";
import type { AppViewState } from "../app-view-state.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { ModelCatalogEntry } from "../types.ts";
import type { SessionsListResult } from "../types.ts";
import { renderChat, type ChatProps } from "./chat.ts";
import { renderOverview, type OverviewProps } from "./overview.ts";

function createSessions(): SessionsListResult {
  return {
    ts: 0,
    path: "",
    count: 0,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [],
  };
}

function createChatHeaderState(
  overrides: {
    model?: string | null;
    models?: ModelCatalogEntry[];
    omitSessionFromList?: boolean;
    sessionKey?: string;
    hello?: AppViewState["hello"];
    agentsList?: AppViewState["agentsList"];
    createResult?: { ok: boolean; key?: string };
  } = {},
): { state: AppViewState; request: ReturnType<typeof vi.fn> } {
  let currentModel = overrides.model ?? null;
  let currentModelProvider = currentModel ? "openai" : null;
  const omitSessionFromList = overrides.omitSessionFromList ?? false;
  const sessionKey = overrides.sessionKey ?? "main";
  const catalog = overrides.models ?? [
    { id: "gpt-5", name: "GPT-5", provider: "openai" },
    { id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai" },
  ];
  let createdSession: {
    key: string;
    kind: "direct";
    updatedAt: number;
    label?: string;
  } | null = null;
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "sessions.patch") {
      const nextModel = (params.model as string | null | undefined) ?? null;
      if (!nextModel) {
        currentModel = null;
        currentModelProvider = null;
      } else {
        const normalized = nextModel.trim();
        const slashIndex = normalized.indexOf("/");
        if (slashIndex > 0) {
          currentModelProvider = normalized.slice(0, slashIndex);
          currentModel = normalized.slice(slashIndex + 1);
        } else {
          currentModel = normalized;
          const matchingProviders = catalog
            .filter((entry) => entry.id === normalized)
            .map((entry) => entry.provider)
            .filter(Boolean);
          currentModelProvider =
            matchingProviders.length === 1 ? matchingProviders[0] : currentModelProvider;
        }
      }
      return { ok: true, key: "main" };
    }
    if (method === "sessions.create") {
      const agentId =
        typeof params.agentId === "string" && params.agentId.trim() ? params.agentId : "main";
      const result = overrides.createResult ?? {
        ok: true,
        key: `agent:${agentId}:dashboard:new-session`,
      };
      if (result.key) {
        createdSession = {
          key: result.key,
          kind: "direct",
          updatedAt: 1,
          label: typeof params.label === "string" ? params.label : undefined,
        };
      }
      return result;
    }
    if (method === "chat.history") {
      return { messages: [], thinkingLevel: null };
    }
    if (method === "sessions.list") {
      const baseSessions = omitSessionFromList
        ? []
        : [
            {
              key: sessionKey,
              kind: "direct",
              updatedAt: null,
              modelProvider: currentModelProvider,
              model: currentModel,
            },
          ];
      const sessions = createdSession ? [...baseSessions, createdSession] : baseSessions;
      return {
        ts: 0,
        path: "",
        count: sessions.length,
        defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
        sessions,
      };
    }
    if (method === "models.list") {
      return { models: catalog };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const state = {
    sessionKey,
    connected: true,
    sessionsHideCron: true,
    sessionsResult: {
      ts: 0,
      path: "",
      count: omitSessionFromList ? 0 : 1,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: omitSessionFromList
        ? []
        : [
            {
              key: sessionKey,
              kind: "direct",
              updatedAt: null,
              modelProvider: currentModelProvider,
              model: currentModel,
            },
          ],
    },
    chatModelOverrides: {},
    chatModelCatalog: catalog,
    chatModelsLoading: false,
    client: { request } as unknown as GatewayBrowserClient,
    settings: {
      gatewayUrl: "",
      token: "",
      locale: "en",
      sessionKey,
      lastActiveSessionKey: sessionKey,
      theme: "claw",
      themeMode: "dark",
      splitRatio: 0.6,
      navCollapsed: false,
      navGroupsCollapsed: {},
      borderRadius: 50,
      chatFocusMode: false,
      chatShowThinking: false,
    },
    chatMessage: "",
    chatAttachments: [],
    chatStream: null,
    chatStreamStartedAt: null,
    chatRunId: null,
    newChatSessionPending: false,
    chatQueue: [],
    chatMessages: [],
    chatLoading: false,
    chatThinkingLevel: null,
    lastError: null,
    tab: "chat",
    chatAvatarUrl: null,
    basePath: "",
    hello: overrides.hello ?? null,
    agentsList: overrides.agentsList ?? null,
    applySettings(next: AppViewState["settings"]) {
      state.settings = next;
    },
    setTab: vi.fn((next: AppViewState["tab"]) => {
      state.tab = next;
    }),
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

async function withPromptStub(run: () => Promise<void> | void, value = "Session label") {
  const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(value);
  try {
    await run();
  } finally {
    promptSpy.mockRestore();
  }
}

function setSidebarSessions(
  state: AppViewState,
  sessions: NonNullable<SessionsListResult["sessions"]>,
  count = sessions.length,
) {
  state.sessionsResult = {
    ts: 0,
    path: "",
    count,
    defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
    sessions,
  };
}

function renderSidebar(state: AppViewState) {
  const container = document.createElement("div");
  const rerender = () => render(renderChatSidebarSection(state), container);
  rerender();
  return {
    container,
    rerender,
    labels: () =>
      Array.from(
        container.querySelectorAll<HTMLButtonElement>("button[data-chat-session-key]"),
      ).map((entry) => entry.textContent?.trim() ?? ""),
    row: (sessionKey: string) =>
      container.querySelector<HTMLButtonElement>(`button[data-chat-session-key="${sessionKey}"]`),
    createButton: () =>
      container.querySelector<HTMLButtonElement>('button[title="New chat session"]'),
  };
}

function setSessionKey(state: AppViewState, sessionKey: string) {
  state.sessionKey = sessionKey;
  state.settings.sessionKey = sessionKey;
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
    agentsList: null,
    currentAgentId: "",
    onAgentChange: () => undefined,
    ...overrides,
  };
}

function createOverviewProps(overrides: Partial<OverviewProps> = {}): OverviewProps {
  return {
    connected: false,
    hello: null,
    settings: {
      gatewayUrl: "",
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
      borderRadius: 50,
      locale: "en",
    },
    password: "",
    lastError: null,
    lastErrorCode: null,
    presenceCount: 0,
    sessionsCount: null,
    cronEnabled: null,
    cronNext: null,
    lastChannelsRefresh: null,
    usageResult: null,
    sessionsResult: null,
    skillsReport: null,
    cronJobs: [],
    cronStatus: null,
    attentionItems: [],
    eventLog: [],
    overviewLogLines: [],
    showGatewayToken: false,
    showGatewayPassword: false,
    onSettingsChange: () => undefined,
    onPasswordChange: () => undefined,
    onSessionKeyChange: () => undefined,
    onToggleGatewayTokenVisibility: () => undefined,
    onToggleGatewayPasswordVisibility: () => undefined,
    onConnect: () => undefined,
    onRefresh: () => undefined,
    onNavigate: () => undefined,
    onRefreshLogs: () => undefined,
    ...overrides,
  };
}

describe("chat view", () => {
  it("hides the context notice when only cumulative inputTokens exceed the limit", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          sessions: {
            ts: 0,
            path: "",
            count: 1,
            defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: 200_000 },
            sessions: [
              {
                key: "main",
                kind: "direct",
                updatedAt: null,
                inputTokens: 757_300,
                totalTokens: 46_000,
                contextTokens: 200_000,
              },
            ],
          },
        }),
      ),
      container,
    );

    expect(container.textContent).not.toContain("context used");
    expect(container.textContent).not.toContain("757.3k / 200k");
  });

  it("uses totalTokens for the context notice detail when current usage is high", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          sessions: {
            ts: 0,
            path: "",
            count: 1,
            defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: 200_000 },
            sessions: [
              {
                key: "main",
                kind: "direct",
                updatedAt: null,
                inputTokens: 757_300,
                totalTokens: 190_000,
                contextTokens: 200_000,
              },
            ],
          },
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("95% context used");
    expect(container.textContent).toContain("190k / 200k");
    expect(container.textContent).not.toContain("757.3k / 200k");
  });

  it("hides the context notice when totalTokens is missing even if inputTokens is high", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          sessions: {
            ts: 0,
            path: "",
            count: 1,
            defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: 200_000 },
            sessions: [
              {
                key: "main",
                kind: "direct",
                updatedAt: null,
                inputTokens: 500_000,
                contextTokens: 200_000,
              },
            ],
          },
        }),
      ),
      container,
    );

    expect(container.textContent).not.toContain("context used");
  });

  it("hides the context notice when totalTokens is marked stale", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          sessions: {
            ts: 0,
            path: "",
            count: 1,
            defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: 200_000 },
            sessions: [
              {
                key: "main",
                kind: "direct",
                updatedAt: null,
                totalTokens: 190_000,
                totalTokensFresh: false,
                contextTokens: 200_000,
              },
            ],
          },
        }),
      ),
      container,
    );

    expect(container.textContent).not.toContain("context used");
    expect(container.textContent).not.toContain("190k / 200k");
  });

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

  it("keeps the persisted overview locale selected before i18n hydration finishes", async () => {
    const container = document.createElement("div");
    const props = createOverviewProps({
      settings: {
        ...createOverviewProps().settings,
        locale: "zh-CN",
      },
    });

    try {
      localStorage.clear();
    } catch {
      /* noop */
    }
    await i18n.setLocale("en");

    render(renderOverview(props), container);
    await Promise.resolve();

    let select = container.querySelector<HTMLSelectElement>("select");
    expect(i18n.getLocale()).toBe("en");
    expect(select?.value).toBe("zh-CN");
    expect(select?.selectedOptions[0]?.textContent?.trim()).toBe("简体中文 (Simplified Chinese)");

    await i18n.setLocale("zh-CN");
    render(renderOverview(props), container);
    await Promise.resolve();

    select = container.querySelector<HTMLSelectElement>("select");
    expect(select?.value).toBe("zh-CN");
    expect(select?.selectedOptions[0]?.textContent?.trim()).toBe("简体中文 (简体中文)");

    await i18n.setLocale("en");
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

  it("does not render horizontal session pills in the chat view", () => {
    const container = document.createElement("div");
    render(renderChat(createProps()), container);

    expect(container.querySelector(".chat-session-tabs")).toBeNull();
    expect(container.querySelector('button[title="New chat session"]')).toBeNull();
  });

  it("keeps focus mode free of horizontal session pills", () => {
    const container = document.createElement("div");
    render(renderChat(createProps({ focusMode: true })), container);

    expect(container.querySelector(".chat-focus-exit")).not.toBeNull();
    expect(container.querySelector(".chat-session-tabs")).toBeNull();
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
      getSafeLocalStorage()?.removeItem("openclaw:skipDeleteConfirm");
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
      getSafeLocalStorage()?.removeItem("openclaw:skipDeleteConfirm");
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

  it("patches the current session model from the chat header picker", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
      } satisfies Partial<Response>),
    );
    const { state, request } = createChatHeaderState();
    const container = document.createElement("div");
    render(renderChatModelSelect(state), container);

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(modelSelect).not.toBeNull();
    expect(modelSelect?.value).toBe("");

    modelSelect!.value = "openai/gpt-5-mini";
    modelSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await flushTasks();

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "main",
      model: "openai/gpt-5-mini",
    });
    expect(request).not.toHaveBeenCalledWith("chat.history", expect.anything());
    expect(state.sessionsResult?.sessions[0]?.model).toBe("gpt-5-mini");
    expect(state.sessionsResult?.sessions[0]?.modelProvider).toBe("openai");
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
    render(renderChatModelSelect(state), container);

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(modelSelect).not.toBeNull();
    expect(modelSelect?.value).toBe("openai/gpt-5-mini");

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
    render(renderChatModelSelect(state), container);

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
    render(renderChatModelSelect(state), container);

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(modelSelect).not.toBeNull();

    modelSelect!.value = "openai/gpt-5-mini";
    modelSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await flushTasks();
    render(renderChatModelSelect(state), container);

    const rerendered = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(rerendered?.value).toBe("openai/gpt-5-mini");
    vi.unstubAllGlobals();
  });

  it("normalizes cached bare /model overrides to the matching catalog option", () => {
    const { state } = createChatHeaderState();
    state.chatModelOverrides = { main: { kind: "raw", value: "gpt-5-mini" } };

    const container = document.createElement("div");
    render(renderChatModelSelect(state), container);

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(modelSelect).not.toBeNull();
    expect(modelSelect?.value).toBe("openai/gpt-5-mini");

    const optionValues = Array.from(modelSelect?.querySelectorAll("option") ?? []).map(
      (option) => option.value,
    );
    expect(optionValues).toContain("openai/gpt-5-mini");
    expect(optionValues).not.toContain("gpt-5-mini");
  });

  it("does not render a desktop chat header session dropdown", () => {
    const { state } = createChatHeaderState();
    const container = document.createElement("div");
    render(
      html`<div class="chat-controls__session-row">${renderChatModelSelect(state)}</div>`,
      container,
    );

    expect(container.querySelectorAll("select")).toHaveLength(1);
    expect(container.querySelector('select[data-chat-model-select="true"]')).not.toBeNull();
    expect(container.querySelector('select:not([data-chat-model-select="true"])')).toBeNull();
  });

  it.each([
    {
      name: "prefers the session label over displayName in the chat sidebar list",
      setup(state: AppViewState) {
        setSessionKey(state, "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b");
        setSidebarSessions(state, [
          {
            key: state.sessionKey,
            kind: "direct",
            updatedAt: null,
            label: "cron-config-check",
            displayName: "webchat:g-agent-main-subagent-4f2146de-887b-4176-9abe-91140082959b",
          },
        ]);
      },
      includes: ["Subagent: cron-config-check"],
      excludes: [
        "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b",
        "subagent:4f2146de-887b-4176-9abe-91140082959b · webchat:g-agent-main-subagent-4f2146de-887b-4176-9abe-91140082959b",
      ],
    },
    {
      name: "keeps a unique scoped fallback when the current sidebar session is missing from sessions.list",
      setup(state: AppViewState) {
        setSessionKey(state, "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b");
      },
      includes: ["subagent:4f2146de-887b-4176-9abe-91140082959b"],
      excludes: ["Subagent:"],
    },
    {
      name: "keeps a unique scoped fallback when a sidebar session row has no label or displayName",
      setup(state: AppViewState) {
        setSessionKey(state, "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b");
        setSidebarSessions(state, [{ key: state.sessionKey, kind: "direct", updatedAt: null }]);
      },
      includes: ["subagent:4f2146de-887b-4176-9abe-91140082959b"],
      excludes: ["Subagent:"],
    },
    {
      name: "disambiguates duplicate sidebar labels with the scoped key suffix",
      setup(state: AppViewState) {
        setSessionKey(state, "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b");
        setSidebarSessions(state, [
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
        ]);
      },
      includes: [
        "Subagent: cron-config-check · subagent:4f2146de-887b-4176-9abe-91140082959b",
        "Subagent: cron-config-check · subagent:6fb8b84b-c31f-410f-b7df-1553c82e43c9",
      ],
      excludes: ["Subagent: cron-config-check"],
    },
  ])("$name", (testCase) => {
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    testCase.setup(state);
    const labels = renderSidebar(state).labels();

    for (const label of testCase.includes) {
      expect(labels).toContain(label);
    }
    for (const label of testCase.excludes) {
      expect(labels).not.toContain(label);
    }
  });

  it("prefixes duplicate agent session labels in the sidebar list with the agent name", () => {
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    state.sessionKey = "agent:alpha:main";
    state.settings.sessionKey = state.sessionKey;
    state.agentsList = {
      defaultId: "alpha",
      mainKey: "agent:alpha:main",
      scope: "all",
      agents: [
        { id: "alpha", name: "Deep Chat" },
        { id: "beta", name: "Coding" },
      ],
    };
    state.sessionsResult = {
      ts: 0,
      path: "",
      count: 2,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [
        {
          key: "agent:alpha:main",
          kind: "direct",
          updatedAt: null,
        },
        {
          key: "agent:beta:main",
          kind: "direct",
          updatedAt: null,
        },
      ],
    };
    const labels = renderSidebar(state).labels();

    expect(labels).toContain("Deep Chat (alpha) / main");
    expect(labels).not.toContain("main");
  });

  it("keeps agent-prefixed sidebar labels unique when a custom label already matches the prefix", () => {
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    state.sessionKey = "agent:alpha:main";
    state.settings.sessionKey = state.sessionKey;
    state.agentsList = {
      defaultId: "alpha",
      mainKey: "agent:alpha:main",
      scope: "all",
      agents: [
        { id: "alpha", name: "Deep Chat" },
        { id: "beta", name: "Coding" },
      ],
    };
    state.sessionsResult = {
      ts: 0,
      path: "",
      count: 3,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [
        {
          key: "agent:alpha:main",
          kind: "direct",
          updatedAt: null,
        },
        {
          key: "agent:beta:main",
          kind: "direct",
          updatedAt: null,
        },
        {
          key: "agent:alpha:named-main",
          kind: "direct",
          updatedAt: null,
          label: "Deep Chat (alpha) / main",
        },
      ],
    };
    const labels = renderSidebar(state).labels();

    expect(labels.filter((label) => label === "Deep Chat (alpha) / main")).toHaveLength(1);
    expect(labels).toContain("Deep Chat (alpha) / main · named-main");
  });

  it("shows sidebar sessions across agents and keeps the current session when it is missing from sessions.list", () => {
    const { state } = createChatHeaderState({
      sessionKey: "agent:main:dashboard:missing-current",
      agentsList: {
        defaultId: "main",
        agents: [{ id: "main" }, { id: "research" }],
      } as AppViewState["agentsList"],
    });
    state.settings.sessionKey = state.sessionKey;
    state.sessionsResult = {
      ts: 0,
      path: "",
      count: 2,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [
        {
          key: "agent:main:dashboard:recent-main",
          kind: "direct",
          label: "Recent Main",
          updatedAt: 20,
        },
        {
          key: "agent:research:dashboard:notes",
          kind: "direct",
          label: "Research Notes",
          updatedAt: 10,
        },
      ],
    };

    const sidebar = renderSidebar(state);

    expect(sidebar.row("agent:main:dashboard:recent-main")).not.toBeNull();
    expect(sidebar.row("agent:main:dashboard:missing-current")).not.toBeNull();
    expect(sidebar.labels()).toContain("Recent Main");
    expect(sidebar.row("agent:research:dashboard:notes")).not.toBeNull();
  });

  it("renders sidebar sessions across agents and highlights the active session", () => {
    const { state } = createChatHeaderState({
      sessionKey: "agent:main:dashboard:test3",
    });
    state.sessionsResult = {
      ts: 0,
      path: "",
      count: 3,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [
        { key: "agent:main:dashboard:heartbeat", kind: "direct", label: "heartbeat", updatedAt: 3 },
        { key: "agent:main:dashboard:test3", kind: "direct", label: "test3", updatedAt: 2 },
        { key: "agent:research:dashboard:notes", kind: "direct", label: "notes", updatedAt: 1 },
      ],
    };
    const sidebar = renderSidebar(state);

    expect(sidebar.labels()).toEqual(["heartbeat", "test3", "notes"]);

    const active = sidebar.container.querySelector<HTMLButtonElement>(".nav-item--active");
    expect(active?.dataset.chatSessionKey).toBe("agent:main:dashboard:test3");
  });

  it("collapses and re-expands the chat sidebar section while on the chat page", async () => {
    const { state } = createChatHeaderState({
      sessionKey: "agent:main:dashboard:test1",
    });
    setSidebarSessions(state, [
      { key: "agent:main:dashboard:test1", kind: "direct", label: "test1", updatedAt: 2 },
      { key: "agent:main:dashboard:test2", kind: "direct", label: "test2", updatedAt: 1 },
    ]);
    const sidebar = renderSidebar(state);

    const toggle = sidebar.container.querySelector<HTMLButtonElement>(".nav-section__label");
    expect(sidebar.container.querySelector(".nav-section--collapsed")).toBeNull();

    toggle?.click();
    await flushTasks();
    sidebar.rerender();

    expect(state.settings.navGroupsCollapsed.chat).toBe(true);
    expect(sidebar.container.querySelector(".nav-section--collapsed")).not.toBeNull();

    sidebar.container.querySelector<HTMLButtonElement>(".nav-section__label")?.click();
    await flushTasks();
    sidebar.rerender();

    expect(state.settings.navGroupsCollapsed.chat).toBe(false);
    expect(sidebar.container.querySelector(".nav-section--collapsed")).toBeNull();
  });

  it("switches across agent sessions from the sidebar list", async () => {
    const { state, request } = createChatHeaderState({
      sessionKey: "agent:main:dashboard:test1",
    });
    setSidebarSessions(state, [
      { key: "agent:main:dashboard:test1", kind: "direct", label: "test1", updatedAt: 2 },
      { key: "agent:beta:dashboard:test2", kind: "direct", label: "test2", updatedAt: 1 },
    ]);
    renderSidebar(state).row("agent:beta:dashboard:test2")?.click();
    await flushTasks();

    expect(state.sessionKey).toBe("agent:beta:dashboard:test2");
    expect(state.settings.sessionKey).toBe("agent:beta:dashboard:test2");
    expect(request).toHaveBeenCalledWith("chat.history", {
      sessionKey: "agent:beta:dashboard:test2",
      limit: 200,
    });
  });

  it("creates a real session from the sidebar plus button", async () => {
    await withPromptStub(async () => {
      const { state, request } = createChatHeaderState();
      renderSidebar(state).createButton()?.click();
      await flushTasks();

      expect(request).toHaveBeenCalledWith("sessions.create", {
        agentId: "main",
        label: "Session label",
      });
      expect(state.sessionKey).toBe("agent:main:dashboard:new-session");
      expect(state.newChatSessionPending).toBe(false);
    });
  });

  it("disables the sidebar plus button while session creation is pending", () => {
    const { state } = createChatHeaderState();
    state.newChatSessionPending = true;
    expect(renderSidebar(state).createButton()?.disabled).toBe(true);
  });

  it("creates a real session and switches to it", async () => {
    await withPromptStub(async () => {
      const { state, request } = createChatHeaderState();

      await createNewChatSession(state);
      await flushTasks();

      expect(request).toHaveBeenCalledWith("sessions.create", {
        agentId: "main",
        label: "Session label",
      });
      expect(state.sessionKey).toBe("agent:main:dashboard:new-session");
      expect(state.settings.sessionKey).toBe("agent:main:dashboard:new-session");
      expect(state.settings.lastActiveSessionKey).toBe("agent:main:dashboard:new-session");
      expect(state.newChatSessionPending).toBe(false);
      expect(request).toHaveBeenCalledWith("chat.history", {
        sessionKey: "agent:main:dashboard:new-session",
        limit: 200,
      });
    });
  });

  it("preserves the current draft and attachments when creating a new session", async () => {
    await withPromptStub(async () => {
      const { state } = createChatHeaderState();
      state.chatMessage = "Carry this into the next session";
      state.chatAttachments = [
        {
          id: "attachment-1",
          dataUrl: "data:image/png;base64,abc",
          mimeType: "image/png",
        },
      ];

      await createNewChatSession(state);
      await flushTasks();

      expect(state.sessionKey).toBe("agent:main:dashboard:new-session");
      expect(state.chatMessage).toBe("Carry this into the next session");
      expect(state.chatAttachments).toEqual([
        {
          id: "attachment-1",
          dataUrl: "data:image/png;base64,abc",
          mimeType: "image/png",
        },
      ]);
    });
  });
});
