/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import { renderChatSessionSelect } from "../app-render.helpers.ts";
import type { AppViewState } from "../app-view-state.ts";
import {
  createModelCatalog,
  createSessionsListResult,
  DEEPSEEK_CHAT_MODEL,
  DEFAULT_CHAT_MODEL_CATALOG,
} from "../chat-model.test-helpers.ts";
import { SKIP_DELETE_CONFIRM_KEY } from "../chat/grouped-render.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { ModelCatalogEntry } from "../types.ts";
import type { SessionsListResult } from "../types.ts";
import { renderChat, type ChatProps } from "./chat.ts";
import { renderOverview, type OverviewProps } from "./overview.ts";

function readDeleteConfirmPreference(): string | null {
  try {
    return getSafeLocalStorage()?.getItem(SKIP_DELETE_CONFIRM_KEY) ?? null;
  } catch {
    return null;
  }
}

function clearDeleteConfirmPreference(): void {
  try {
    getSafeLocalStorage()?.removeItem(SKIP_DELETE_CONFIRM_KEY);
  } catch {
    /* noop */
  }
}

function restoreDeleteConfirmPreference(value: string | null): void {
  try {
    if (value === null) {
      getSafeLocalStorage()?.removeItem(SKIP_DELETE_CONFIRM_KEY);
      return;
    }
    getSafeLocalStorage()?.setItem(SKIP_DELETE_CONFIRM_KEY, value);
  } catch {
    /* noop */
  }
}

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
    modelProvider?: string | null;
    thinkingLevel?: string | null;
    models?: ModelCatalogEntry[];
    omitSessionFromList?: boolean;
  } = {},
): { state: AppViewState; request: ReturnType<typeof vi.fn> } {
  let currentModel = overrides.model ?? null;
  let currentModelProvider = overrides.modelProvider ?? (currentModel ? "openai" : null);
  let currentThinkingLevel = overrides.thinkingLevel ?? null;
  const omitSessionFromList = overrides.omitSessionFromList ?? false;
  const catalog = overrides.models ?? createModelCatalog(...DEFAULT_CHAT_MODEL_CATALOG);
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "sessions.patch") {
      const nextModel = (params.model as string | null | undefined) ?? null;
      const nextThinkingLevel = params.thinkingLevel as string | null | undefined;
      if ("thinkingLevel" in params) {
        currentThinkingLevel = nextThinkingLevel ?? null;
      }
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
    if (method === "chat.history") {
      return { messages: [], thinkingLevel: null };
    }
    if (method === "sessions.list") {
      const result = createSessionsListResult({
        model: currentModel,
        modelProvider: currentModelProvider,
        omitSessionFromList,
      });
      if (result.sessions[0]) {
        result.sessions[0].thinkingLevel = currentThinkingLevel ?? undefined;
      }
      return result;
    }
    if (method === "models.list") {
      return { models: catalog };
    }
    if (method === "tools.effective") {
      return {
        agentId: "main",
        profile: "coding",
        groups: [],
      };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const state = {
    sessionKey: "main",
    connected: true,
    sessionsHideCron: true,
    sessionsResult: (() => {
      const result = createSessionsListResult({
        model: currentModel,
        modelProvider: currentModelProvider,
        omitSessionFromList,
      });
      if (result.sessions[0]) {
        result.sessions[0].thinkingLevel = currentThinkingLevel ?? undefined;
      }
      return result;
    })(),
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
      borderRadius: 50,
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
    agentsPanel: "overview",
    agentsSelectedId: null,
    toolsEffectiveLoading: false,
    toolsEffectiveLoadingKey: null,
    toolsEffectiveResultKey: null,
    toolsEffectiveError: null,
    toolsEffectiveResult: null,
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
    sideResult: null,
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
    onDismissSideResult: () => undefined,
    onNewSession: () => undefined,
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
    warnQueryToken: false,
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
  it("renders BTW side results outside transcript history", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Saved transcript message" }],
              timestamp: 1,
            },
          ],
          sideResult: {
            kind: "btw",
            runId: "btw-run-1",
            sessionKey: "main",
            question: "what changed?",
            text: "The web UI now renders **BTW** separately.",
            isError: false,
            ts: 2,
          },
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-side-result")).not.toBeNull();
    expect(container.textContent).toContain("BTW");
    expect(container.textContent).toContain("what changed?");
    expect(container.textContent).toContain("Not saved to chat history");
    expect(container.textContent).toContain("Saved transcript message");
    expect(container.querySelectorAll(".chat-side-result")).toHaveLength(1);
  });

  it("dismisses BTW side results from the dismiss button", () => {
    const container = document.createElement("div");
    const onDismissSideResult = vi.fn();
    render(
      renderChat(
        createProps({
          sideResult: {
            kind: "btw",
            runId: "btw-run-2",
            sessionKey: "main",
            question: "what changed?",
            text: "Dismiss me",
            isError: false,
            ts: 3,
          },
          onDismissSideResult,
        }),
      ),
      container,
    );

    const button = container.querySelector<HTMLButtonElement>(".chat-side-result__dismiss");
    expect(button).not.toBeNull();
    button?.click();
    expect(onDismissSideResult).toHaveBeenCalledTimes(1);
  });

  it("renders BTW errors with the error variant", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          sideResult: {
            kind: "btw",
            runId: "btw-run-3",
            sessionKey: "main",
            question: "what failed?",
            text: "The side question could not be answered.",
            isError: true,
            ts: 4,
          },
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-side-result--error")).not.toBeNull();
  });

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

    getSafeLocalStorage()?.clear();
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
            phase: "active",
            runId: "run-1",
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

  it("renders retry-pending compaction indicator as a badge", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          compactionStatus: {
            phase: "retrying",
            runId: "run-1",
            startedAt: Date.now(),
            completedAt: null,
          },
        }),
      ),
      container,
    );

    const indicator = container.querySelector(".compaction-indicator--active");
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toContain("Retrying after compaction...");
  });

  it("renders completion indicator shortly after compaction", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
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
    nowSpy.mockRestore();
  });

  it("renders fallback indicator shortly after fallback event", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    render(
      renderChat(
        createProps({
          fallbackStatus: {
            selected: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
            active: "deepinfra/moonshotai/Kimi-K2.5",
            attempts: ["fireworks/accounts/fireworks/routers/kimi-k2p5-turbo: rate limit"],
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
            selected: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
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
            selected: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
            active: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
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
    expect(indicator?.textContent).toContain(
      "Fallback cleared: fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
    );
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

  it("shows a stop button when aborting is available without an active stream", () => {
    const container = document.createElement("div");
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

    const stopButton = container.querySelector<HTMLButtonElement>('button[title="Stop"]');
    const sendButton = container.querySelector<HTMLButtonElement>('button[title="Send"]');
    expect(stopButton).not.toBeNull();
    expect(sendButton).toBeNull();
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
    const originalPreference = readDeleteConfirmPreference();
    clearDeleteConfirmPreference();
    const container = document.createElement("div");
    try {
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
    } finally {
      restoreDeleteConfirmPreference(originalPreference);
    }
  });

  it("opens delete confirm on the right for assistant messages", () => {
    const originalPreference = readDeleteConfirmPreference();
    clearDeleteConfirmPreference();
    const container = document.createElement("div");
    try {
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
    } finally {
      restoreDeleteConfirmPreference(originalPreference);
    }
  });

  it("renders delete confirm with the expected safe structure", () => {
    const originalPreference = readDeleteConfirmPreference();
    clearDeleteConfirmPreference();
    const container = document.createElement("div");
    try {
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
      expect(confirm?.querySelector(".chat-delete-confirm__text")?.textContent).toBe(
        "Delete this message?",
      );
      expect(confirm?.querySelector(".chat-delete-confirm__remember span")?.textContent).toBe(
        "Don't ask again",
      );
      expect(confirm?.querySelector<HTMLButtonElement>(".chat-delete-confirm__cancel")?.type).toBe(
        "button",
      );
      expect(confirm?.querySelector<HTMLButtonElement>(".chat-delete-confirm__yes")?.type).toBe(
        "button",
      );
      expect(confirm?.querySelector<HTMLInputElement>(".chat-delete-confirm__check")?.type).toBe(
        "checkbox",
      );
    } finally {
      restoreDeleteConfirmPreference(originalPreference);
    }
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

  it("shows the default thinking level in the chat header picker", async () => {
    const { state } = createChatHeaderState({
      model: "gpt-5",
      modelProvider: "openai",
    });
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const thinkingSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-thinking-select="true"]',
    );
    expect(thinkingSelect).not.toBeNull();
    expect(thinkingSelect?.value).toBe("");
    expect(thinkingSelect?.options[0]?.textContent?.trim()).toBe("Default (off)");
  });

  it("patches the current session thinking level from the chat header picker", async () => {
    const { state, request } = createChatHeaderState({
      model: "gpt-5",
      modelProvider: "openai",
    });
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const thinkingSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-thinking-select="true"]',
    );
    expect(thinkingSelect).not.toBeNull();

    thinkingSelect!.value = "off";
    thinkingSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await flushTasks();

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "main",
      thinkingLevel: "off",
    });
    expect(state.sessionsResult?.sessions[0]?.thinkingLevel).toBe("off");
  });

  it("clears the session thinking override back to the default thinking level", async () => {
    const { state, request } = createChatHeaderState({
      model: "gpt-5",
      modelProvider: "openai",
      thinkingLevel: "high",
    });
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const thinkingSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-thinking-select="true"]',
    );
    expect(thinkingSelect).not.toBeNull();
    expect(thinkingSelect?.value).toBe("high");

    thinkingSelect!.value = "";
    thinkingSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await flushTasks();

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "main",
      thinkingLevel: null,
    });
    expect(state.sessionsResult?.sessions[0]?.thinkingLevel).toBeUndefined();
  });

  it("reloads effective tools after a chat-header model switch for the active tools panel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
      } satisfies Partial<Response>),
    );
    const { state, request } = createChatHeaderState();
    state.agentsPanel = "tools";
    state.agentsSelectedId = "main";
    state.toolsEffectiveResultKey = "main:main";
    state.toolsEffectiveResult = {
      agentId: "main",
      profile: "coding",
      groups: [],
    };
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(modelSelect).not.toBeNull();

    modelSelect!.value = "openai/gpt-5-mini";
    modelSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await flushTasks();

    expect(request).toHaveBeenCalledWith("tools.effective", {
      agentId: "main",
      sessionKey: "main",
    });
    expect(state.toolsEffectiveResultKey).toBe("main:main:model=openai/gpt-5-mini");
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
    expect(modelSelect?.value).toBe("openai/gpt-5-mini");

    modelSelect!.value = "";
    modelSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await flushTasks();

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "main",
      model: null,
    });
    expect(state.sessionsResult?.sessions[0]?.model).toBeUndefined();
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

    modelSelect!.value = "openai/gpt-5-mini";
    modelSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await flushTasks();
    render(renderChatSessionSelect(state), container);

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
    render(renderChatSessionSelect(state), container);

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

  it("prefers the catalog provider when the active session reports a stale provider", () => {
    const { state } = createChatHeaderState({
      model: "deepseek-chat",
      modelProvider: "zai",
      models: createModelCatalog(DEEPSEEK_CHAT_MODEL),
    });

    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(modelSelect?.value).toBe("deepseek/deepseek-chat");
  });

  it("falls back to the server-qualified session model when catalog lookup fails", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5-mini",
      models: [],
    });

    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(modelSelect?.value).toBe("openai/gpt-5-mini");

    const optionValues = Array.from(modelSelect?.querySelectorAll("option") ?? []).map(
      (option) => option.value,
    );
    expect(optionValues).toContain("openai/gpt-5-mini");
    expect(optionValues).not.toContain("gpt-5-mini");
  });

  it("prefers the session label over displayName in the grouped chat session selector", () => {
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    state.sessionKey = "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b";
    state.settings.sessionKey = state.sessionKey;
    state.sessionsResult = {
      ts: 0,
      path: "",
      count: 1,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
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
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
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
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
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

  it("prefixes duplicate agent session labels with the agent name", () => {
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
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const [sessionSelect] = Array.from(container.querySelectorAll<HTMLSelectElement>("select"));
    const labels = Array.from(sessionSelect?.querySelectorAll("option") ?? []).map((option) =>
      option.textContent?.trim(),
    );

    expect(labels).toContain("Deep Chat (alpha) / main");
    expect(labels).toContain("Coding (beta) / main");
    expect(labels).not.toContain("main");
  });

  it("keeps agent-prefixed labels unique when a custom label already matches the prefix", () => {
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
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const [sessionSelect] = Array.from(container.querySelectorAll<HTMLSelectElement>("select"));
    const labels = Array.from(sessionSelect?.querySelectorAll("option") ?? []).map((option) =>
      option.textContent?.trim(),
    );

    expect(labels.filter((label) => label === "Deep Chat (alpha) / main")).toHaveLength(1);
    expect(labels).toContain("Deep Chat (alpha) / main · named-main");
    expect(labels).toContain("Coding (beta) / main");
  });
});
