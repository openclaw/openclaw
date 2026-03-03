import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
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

function createProps(overrides: Partial<ChatProps> = {}): ChatProps {
  return {
    sessionKey: "main",
    onSessionKeyChange: () => undefined,
    thinkingLevel: null,
    showThinking: false,
    showInlineToolFlow: false,
    loading: false,
    sending: false,
    canAbort: false,
    compactionStatus: null,
    fallbackStatus: null,
    messages: [],
    toolMessages: [],
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
    ...overrides,
  };
}

describe("chat view", () => {
  it("shows reasoning while hiding tool details in main thread when reasoning is enabled", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showThinking: true,
          sessions: {
            ...createSessions(),
            sessions: [
              {
                key: "main",
                kind: "direct",
                updatedAt: Date.now(),
                reasoningLevel: "medium",
              },
            ],
          },
          messages: [
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "step one then step two" },
                { type: "text", text: "Final answer text" },
              ],
              timestamp: Date.now(),
            },
            {
              role: "toolresult",
              toolName: "read",
              toolCallId: "history-tool-1",
              content: [{ type: "text", text: "HISTORY TOOL DETAILS" }],
              timestamp: Date.now(),
            },
          ],
          toolMessages: [
            {
              role: "toolresult",
              toolName: "read",
              toolCallId: "live-tool-1",
              content: [{ type: "text", text: "LIVE TOOL DETAILS" }],
              timestamp: Date.now(),
            },
          ],
        }),
      ),
      container,
    );

    const thread = container.querySelector(".chat-thread");
    const threadText = thread?.textContent ?? "";
    expect(threadText).toContain("Reasoning:");
    expect(threadText).toContain("step one then step two");
    expect(threadText).toContain("Final answer text");
    expect(threadText).not.toContain("HISTORY TOOL DETAILS");
    expect(threadText).not.toContain("LIVE TOOL DETAILS");
  });

  it("uses hidden tool-stream output to enrich assistant exec cards when inline tool flow is off", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showThinking: true,
          showInlineToolFlow: false,
          sessions: {
            ...createSessions(),
            sessions: [
              {
                key: "main",
                kind: "direct",
                updatedAt: Date.now(),
                reasoningLevel: "medium",
              },
            ],
          },
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "toolcall",
                  name: "exec",
                  arguments: {
                    command: "openclaw system --help",
                    cwd: "C:\\Users\\test\\.openclaw\\workspace",
                  },
                },
                {
                  type: "toolresult",
                  name: "exec",
                  text: "Command: openclaw system --help\nWorking Dir: C:\\Users\\test\\.openclaw\\workspace",
                },
              ],
              timestamp: Date.now(),
            },
          ],
          toolMessages: [
            {
              role: "toolresult",
              toolName: "exec",
              content: [{ type: "text", text: "Usage: openclaw system [options] [command]\nSystem tools..." }],
              timestamp: Date.now(),
            },
          ],
        }),
      ),
      container,
    );

    const threadText = container.querySelector(".chat-thread")?.textContent ?? "";
    expect(threadText).toContain("Usage: openclaw system [options] [command]");
    expect(threadText).not.toContain("Working Dir: C:\\Users\\test\\.openclaw\\workspace");
  });

  it("shows detailed tool flow inline when both thinking and inline flow are enabled", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showThinking: true,
          showInlineToolFlow: true,
          sessions: {
            ...createSessions(),
            sessions: [
              {
                key: "main",
                kind: "direct",
                updatedAt: Date.now(),
                reasoningLevel: "medium",
              },
            ],
          },
          messages: [
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "step one then step two" },
                { type: "text", text: "Final answer text" },
              ],
              timestamp: Date.now(),
            },
            {
              role: "toolresult",
              toolName: "read",
              toolCallId: "history-tool-1",
              content: [{ type: "text", text: "HISTORY TOOL DETAILS" }],
              timestamp: Date.now(),
            },
          ],
          toolMessages: [
            {
              role: "toolresult",
              toolName: "read",
              toolCallId: "live-tool-1",
              content: [{ type: "text", text: "LIVE TOOL DETAILS" }],
              timestamp: Date.now(),
            },
          ],
        }),
      ),
      container,
    );

    const thread = container.querySelector(".chat-thread");
    const threadText = thread?.textContent ?? "";
    expect(threadText).toContain("Reasoning:");
    expect(threadText).toContain("Final answer text");
    expect(threadText).toContain("HISTORY TOOL DETAILS");
    expect(threadText).toContain("LIVE TOOL DETAILS");
  });

  it("shows full inline flow when only inline flow is enabled", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showThinking: false,
          showInlineToolFlow: true,
          sessions: {
            ...createSessions(),
            sessions: [
              {
                key: "main",
                kind: "direct",
                updatedAt: Date.now(),
                reasoningLevel: "medium",
              },
            ],
          },
          messages: [
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "single-toggle reasoning" },
                { type: "text", text: "Single-toggle final answer" },
              ],
              timestamp: Date.now(),
            },
            {
              role: "toolresult",
              toolName: "read",
              toolCallId: "history-tool-inline-only",
              content: [{ type: "text", text: "INLINE ONLY HISTORY TOOL DETAILS" }],
              timestamp: Date.now(),
            },
          ],
          toolMessages: [
            {
              role: "toolresult",
              toolName: "read",
              toolCallId: "live-tool-inline-only",
              content: [{ type: "text", text: "INLINE ONLY LIVE TOOL DETAILS" }],
              timestamp: Date.now(),
            },
          ],
        }),
      ),
      container,
    );

    const thread = container.querySelector(".chat-thread");
    const threadText = thread?.textContent ?? "";
    expect(threadText).toContain("Reasoning:");
    expect(threadText).toContain("single-toggle reasoning");
    expect(threadText).toContain("Single-toggle final answer");
    expect(threadText).toContain("INLINE ONLY HISTORY TOOL DETAILS");
    expect(threadText).toContain("INLINE ONLY LIVE TOOL DETAILS");
  });

  it("deduplicates inline tool cards that already exist in history", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showInlineToolFlow: true,
          sessions: {
            ...createSessions(),
            sessions: [
              {
                key: "main",
                kind: "direct",
                updatedAt: Date.now(),
                reasoningLevel: "medium",
              },
            ],
          },
          messages: [
            {
              role: "assistant",
              toolCallId: "dup-web-fetch-1",
              content: [
                { type: "text", text: "Summary before tool card" },
                {
                  type: "toolcall",
                  name: "web_fetch",
                  arguments: { url: "https://api-docs.deepseek.com/quick_start/pricing" },
                },
              ],
              timestamp: Date.now(),
            },
          ],
          toolMessages: [
            {
              role: "toolresult",
              toolName: "web_fetch",
              toolCallId: "dup-web-fetch-1",
              content: [{ type: "text", text: "LIVE TOOL DETAILS THAT SHOULD NOT DUPLICATE CARD" }],
              timestamp: Date.now(),
            },
          ],
        }),
      ),
      container,
    );

    const cards = container.querySelectorAll(".chat-tool-card");
    expect(cards.length).toBe(1);
    const threadText = container.querySelector(".chat-thread")?.textContent ?? "";
    expect(threadText).toContain("Summary before tool card");
  });

  it("keeps live inline tool cards when toolCallId matches but runId differs", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showInlineToolFlow: true,
          messages: [
            {
              role: "toolresult",
              runId: "run-history",
              toolName: "web_fetch",
              toolCallId: "call_1",
              content: [{ type: "text", text: "history output" }],
              timestamp: Date.now() - 10_000,
            },
          ],
          toolMessages: [
            {
              role: "toolresult",
              runId: "run-live",
              toolName: "web_fetch",
              toolCallId: "call_1",
              content: [{ type: "text", text: "live output" }],
              timestamp: Date.now(),
            },
          ],
        }),
      ),
      container,
    );

    const cards = container.querySelectorAll(".chat-tool-card");
    expect(cards.length).toBe(2);
    const threadText = container.querySelector(".chat-thread")?.textContent ?? "";
    expect(threadText).toContain("history output");
    expect(threadText).toContain("live output");
  });

  it("hydrates command detail on live tool cards from history when output and args split across cards", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showInlineToolFlow: true,
          messages: [
            {
              role: "assistant",
              runId: "run-history",
              toolCallId: "split-read-1",
              content: [
                {
                  type: "toolcall",
                  name: "read",
                  arguments: { path: "workspace/memory/daily/2026-03-01.md" },
                },
              ],
              timestamp: Date.now() - 10_000,
            },
          ],
          toolMessages: [
            {
              role: "toolresult",
              runId: "run-live",
              toolName: "read",
              toolCallId: "split-read-1",
              content: [{ type: "text", text: "live file output" }],
              timestamp: Date.now(),
            },
          ],
        }),
      ),
      container,
    );

    const cards = container.querySelectorAll(".chat-tool-card");
    expect(cards.length).toBe(2);
    const details = Array.from(container.querySelectorAll(".chat-tool-card__detail")).map(
      (node) => node.textContent ?? "",
    );
    expect(details).toHaveLength(2);
    expect(details[0]).toContain("from workspace/memory/daily/2026-03-01.md");
    expect(details[1]).toContain("from workspace/memory/daily/2026-03-01.md");
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
          onAbort,
        }),
      ),
      container,
    );

    const stopButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Stop",
    );
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

    const newSessionButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "New session",
    );
    expect(newSessionButton).not.toBeUndefined();
    newSessionButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onNewSession).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("Stop");
  });
});
