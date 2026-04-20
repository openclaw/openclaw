/* @vitest-environment jsdom */

import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { getSafeLocalStorage } from "../../local-storage.ts";
import type { SessionsListResult } from "../types.ts";
import { __testing as chatTesting, renderChat, type ChatProps } from "./chat.ts";

vi.mock("../markdown.ts", () => ({
  toSanitizedMarkdownHtml: (value: string) => value,
}));

vi.mock("../chat/export.ts", () => ({
  exportChatMarkdown: vi.fn(),
}));

vi.mock("../chat/speech.ts", () => ({
  isSttActive: () => false,
  isSttSupported: () => false,
  isTtsSpeaking: () => false,
  isTtsSupported: () => false,
  speakText: () => false,
  startStt: () => false,
  stopStt: () => undefined,
  stopTts: () => undefined,
}));

vi.mock("../components/resizable-divider.ts", () => ({}));

vi.mock("./markdown-sidebar.ts", async () => {
  const { html } = await import("lit");
  return {
    renderMarkdownSidebar: (props: { content?: { content?: string; title?: string } | null }) =>
      html`<div class="sidebar-panel" data-mocked-sidebar>
        ${props.content?.title ?? props.content?.content ?? ""}
      </div>`,
  };
});

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
    localMediaPreviewRoots: [],
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

function clearDeleteConfirmSkip() {
  try {
    getSafeLocalStorage()?.removeItem("openclaw:skipDeleteConfirm");
  } catch {
    /* noop */
  }
}

describe("chat view", () => {
  it("renders compaction and fallback indicators while they are fresh", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now");
    const renderIndicators = (
      compactionStatus: ChatProps["compactionStatus"],
      fallbackStatus: ChatProps["fallbackStatus"],
    ) => {
      render(
        html`${chatTesting.renderFallbackIndicator(fallbackStatus)}
        ${chatTesting.renderCompactionIndicator(compactionStatus)}`,
        container,
      );
    };

    try {
      nowSpy.mockReturnValue(1_000);
      renderIndicators(
        {
          phase: "active",
          runId: "run-1",
          startedAt: 1_000,
          completedAt: null,
        },
        {
          selected: "fireworks/minimax-m2p5",
          active: "deepinfra/moonshotai/Kimi-K2.5",
          attempts: ["fireworks/minimax-m2p5: rate limit"],
          occurredAt: 900,
        },
      );

      let indicator = container.querySelector(".compaction-indicator--active");
      expect(indicator).not.toBeNull();
      expect(indicator?.textContent).toContain("Compacting context...");
      indicator = container.querySelector(".compaction-indicator--fallback");
      expect(indicator).not.toBeNull();
      expect(indicator?.textContent).toContain("Fallback active: deepinfra/moonshotai/Kimi-K2.5");

      renderIndicators(
        {
          phase: "complete",
          runId: "run-1",
          startedAt: 900,
          completedAt: 900,
        },
        {
          phase: "cleared",
          selected: "fireworks/minimax-m2p5",
          active: "fireworks/minimax-m2p5",
          previous: "deepinfra/moonshotai/Kimi-K2.5",
          attempts: [],
          occurredAt: 900,
        },
      );
      indicator = container.querySelector(".compaction-indicator--complete");
      expect(indicator).not.toBeNull();
      expect(indicator?.textContent).toContain("Context compacted");
      indicator = container.querySelector(".compaction-indicator--fallback-cleared");
      expect(indicator).not.toBeNull();
      expect(indicator?.textContent).toContain("Fallback cleared: fireworks/minimax-m2p5");

      nowSpy.mockReturnValue(20_000);
      renderIndicators(
        {
          phase: "complete",
          runId: "run-1",
          startedAt: 0,
          completedAt: 0,
        },
        {
          selected: "fireworks/minimax-m2p5",
          active: "deepinfra/moonshotai/Kimi-K2.5",
          attempts: [],
          occurredAt: 0,
        },
      );
      expect(container.querySelector(".compaction-indicator--fallback")).toBeNull();
      expect(container.querySelector(".compaction-indicator--complete")).toBeNull();
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

  it("expands already-visible tool cards when auto-expand is turned on", () => {
    const container = document.createElement("div");
    const baseProps = createProps({
      messages: [
        {
          id: "assistant-3",
          role: "assistant",
          toolCallId: "call-3",
          content: [
            {
              type: "toolcall",
              id: "call-3",
              name: "browser.open",
              arguments: { url: "https://example.com" },
            },
            {
              type: "toolresult",
              id: "call-3",
              name: "browser.open",
              text: "Opened page",
            },
          ],
          timestamp: Date.now(),
        },
      ],
    });

    render(renderChat(baseProps), container);
    expect(container.textContent).not.toContain("Input");

    render(renderChat({ ...baseProps, autoExpandToolCalls: true }), container);
    expect(container.textContent).toContain("Tool input");
    expect(container.textContent).toContain("Tool output");
  });

  it("renders hidden assistant_message canvas results with the configured sandbox", () => {
    const container = document.createElement("div");
    const renderCanvas = (params: { embedSandboxMode?: "trusted"; suffix: string }) =>
      render(
        renderChat(
          createProps({
            ...(params.embedSandboxMode ? { embedSandboxMode: params.embedSandboxMode } : {}),
            showToolCalls: false,
            messages: [
              {
                id: `assistant-canvas-inline-${params.suffix}`,
                role: "assistant",
                content: [{ type: "text", text: "Inline canvas result." }],
                timestamp: Date.now(),
              },
            ],
            toolMessages: [
              {
                id: `tool-artifact-inline-${params.suffix}`,
                role: "tool",
                toolCallId: `call-artifact-inline-${params.suffix}`,
                toolName: "canvas_render",
                content: JSON.stringify({
                  kind: "canvas",
                  view: {
                    backend: "canvas",
                    id: `cv_inline_${params.suffix}`,
                    url: `/__openclaw__/canvas/documents/cv_inline_${params.suffix}/index.html`,
                    title: "Inline demo",
                    preferred_height: 360,
                  },
                  presentation: {
                    target: "assistant_message",
                  },
                }),
                timestamp: Date.now() + 1,
              },
            ],
          }),
        ),
        container,
      );

    renderCanvas({ suffix: "default" });

    let iframe = container.querySelector<HTMLIFrameElement>(".chat-tool-card__preview-frame");
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe?.getAttribute("src")).toBe(
      "/__openclaw__/canvas/documents/cv_inline_default/index.html",
    );
    expect(container.textContent).toContain("Inline canvas result.");
    expect(container.textContent).toContain("Inline demo");
    expect(container.textContent).toContain("Raw details");

    renderCanvas({ embedSandboxMode: "trusted", suffix: "trusted" });
    iframe = container.querySelector<HTMLIFrameElement>(".chat-tool-card__preview-frame");
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
  });

  it("renders assistant_message canvas results in the assistant bubble even when tool rows are visible", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showToolCalls: true,
          autoExpandToolCalls: true,
          messages: [
            {
              id: "assistant-canvas-inline-visible",
              role: "assistant",
              content: [{ type: "text", text: "Inline canvas result." }],
              timestamp: Date.now(),
            },
          ],
          toolMessages: [
            {
              id: "tool-artifact-inline-visible",
              role: "tool",
              toolCallId: "call-artifact-inline-visible",
              toolName: "canvas_render",
              content: JSON.stringify({
                kind: "canvas",
                view: {
                  backend: "canvas",
                  id: "cv_inline_visible",
                  url: "/__openclaw__/canvas/documents/cv_inline_visible/index.html",
                  title: "Inline demo",
                  preferred_height: 360,
                },
                presentation: {
                  target: "assistant_message",
                },
              }),
              timestamp: Date.now() + 1,
            },
          ],
        }),
      ),
      container,
    );

    const assistantBubble = container.querySelector(".chat-group.assistant .chat-bubble");
    const allPreviews = container.querySelectorAll(".chat-tool-card__preview-frame");
    expect(allPreviews).toHaveLength(1);
    expect(assistantBubble?.querySelector(".chat-tool-card__preview-frame")).not.toBeNull();
    expect(container.textContent).toContain("Tool output");
    expect(container.textContent).toContain("canvas_render");
    expect(container.textContent).toContain("Inline canvas result.");
    expect(container.textContent).toContain("Inline demo");
  });

  it("keeps lifted canvas previews attached to the nearest assistant turn", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showToolCalls: true,
          messages: [
            {
              id: "assistant-with-canvas",
              role: "assistant",
              content: [{ type: "text", text: "First reply." }],
              timestamp: 1_000,
            },
            {
              id: "assistant-without-canvas",
              role: "assistant",
              content: [{ type: "text", text: "Later unrelated reply." }],
              timestamp: 2_000,
            },
          ],
          toolMessages: [
            {
              id: "tool-canvas-for-first-reply",
              role: "tool",
              toolCallId: "call-canvas-old",
              toolName: "canvas_render",
              content: JSON.stringify({
                kind: "canvas",
                view: {
                  backend: "canvas",
                  id: "cv_nearest_turn",
                  url: "/__openclaw__/canvas/documents/cv_nearest_turn/index.html",
                  title: "Nearest turn demo",
                  preferred_height: 320,
                },
                presentation: {
                  target: "assistant_message",
                },
              }),
              timestamp: 1_001,
            },
          ],
        }),
      ),
      container,
    );

    const assistantBubbles = Array.from(
      container.querySelectorAll<HTMLElement>(".chat-group.assistant .chat-bubble"),
    );
    expect(assistantBubbles).toHaveLength(2);
    expect(assistantBubbles[0]?.querySelector(".chat-tool-card__preview-frame")).not.toBeNull();
    expect(assistantBubbles[1]?.querySelector(".chat-tool-card__preview-frame")).toBeNull();
    expect(assistantBubbles[1]?.textContent).toContain("Later unrelated reply.");
  });

  it("does not auto-render generic view handles from non-canvas payloads", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showToolCalls: true,
          messages: [
            {
              id: "assistant-generic-inline",
              role: "assistant",
              content: [{ type: "text", text: "Rendered the item inline." }],
              timestamp: Date.now(),
            },
          ],
          toolMessages: [
            {
              id: "tool-generic-inline",
              role: "tool",
              toolCallId: "call-generic-inline",
              toolName: "plugin_card_details",
              content: JSON.stringify({
                selected_item: {
                  summary: {
                    label: "Alpha",
                    meaning: "Generic example",
                  },
                  view: {
                    backend: "canvas",
                    id: "cv_generic_inline",
                    url: "/__openclaw__/canvas/documents/cv_generic_inline/index.html",
                    title: "Inline generic preview",
                    preferred_height: 420,
                  },
                },
              }),
              timestamp: Date.now() + 1,
            },
          ],
        }),
      ),
      container,
    );

    const assistantBubble = container.querySelector(".chat-group.assistant .chat-bubble");
    const allPreviews = container.querySelectorAll(".chat-tool-card__preview-frame");
    expect(allPreviews).toHaveLength(0);
    expect(assistantBubble?.querySelector(".chat-tool-card__preview-frame")).toBeNull();
    expect(container.textContent).toContain("Tool output");
    expect(container.textContent).toContain("plugin_card_details");
    expect(container.textContent).toContain("Rendered the item inline.");
    expect(container.textContent).not.toContain("Inline generic preview");
  });

  it("lifts streamed canvas tool messages with toolresult blocks into the assistant bubble", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showToolCalls: true,
          messages: [
            {
              id: "assistant-streamed-artifact",
              role: "assistant",
              content: [{ type: "text", text: "Done." }],
              timestamp: Date.now(),
            },
          ],
          toolMessages: [
            {
              id: "tool-streamed-artifact",
              role: "assistant",
              toolCallId: "call_streamed_artifact",
              timestamp: Date.now() - 1,
              content: [
                {
                  type: "toolcall",
                  name: "canvas_render",
                  arguments: { source: { type: "handle", id: "cv_streamed_artifact" } },
                },
                {
                  type: "toolresult",
                  name: "canvas_render",
                  text: JSON.stringify({
                    kind: "canvas",
                    view: {
                      backend: "canvas",
                      id: "cv_streamed_artifact",
                      url: "/__openclaw__/canvas/documents/cv_streamed_artifact/index.html",
                      title: "Streamed demo",
                      preferred_height: 320,
                    },
                    presentation: {
                      target: "assistant_message",
                    },
                  }),
                },
              ],
            },
          ],
        }),
      ),
      container,
    );

    const assistantBubble = container.querySelector(".chat-group.assistant .chat-bubble");
    expect(assistantBubble?.querySelector(".chat-tool-card__preview-frame")).not.toBeNull();
    expect(container.textContent).toContain("Streamed demo");
    expect(container.textContent).toContain("Done.");
    expect(
      Array.from(container.querySelectorAll(".chat-tool-msg-summary__label")).map((node) =>
        node.textContent?.trim(),
      ),
    ).toContain("Tool output");
  });

  it("opens generic tool details instead of a canvas preview from tool rows", async () => {
    const container = document.createElement("div");
    const onOpenSidebar = vi.fn();
    render(
      renderChat(
        createProps({
          showToolCalls: true,
          autoExpandToolCalls: true,
          onOpenSidebar,
          messages: [
            {
              id: "assistant-canvas-sidebar",
              role: "assistant",
              content: [{ type: "text", text: "Sidebar canvas result." }],
              timestamp: Date.now(),
            },
          ],
          toolMessages: [
            {
              id: "tool-artifact-sidebar",
              role: "tool",
              toolCallId: "call-artifact-sidebar",
              toolName: "canvas_render",
              content: JSON.stringify({
                kind: "canvas",
                view: {
                  backend: "canvas",
                  id: "cv_sidebar",
                  url: "https://example.com/canvas",
                  title: "Sidebar demo",
                  preferred_height: 420,
                },
                presentation: {
                  target: "tool_card",
                },
              }),
              timestamp: Date.now() + 1,
            },
          ],
        }),
      ),
      container,
    );

    await Promise.resolve();

    const sidebarButton = container.querySelector<HTMLButtonElement>(".chat-tool-card__action-btn");

    sidebarButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(container.querySelector(".chat-tool-card__preview-frame")).toBeNull();
    expect(sidebarButton).not.toBeNull();
    expect(onOpenSidebar).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "markdown",
      }),
    );
  });
});
