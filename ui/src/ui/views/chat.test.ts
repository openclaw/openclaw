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
  it("renders/hides compaction and fallback indicators across recency states", () => {
    const cases = [
      {
        name: "active compaction",
        props: {
          compactionStatus: {
            active: true,
            startedAt: 1_000,
            completedAt: null,
          },
        },
        selector: ".compaction-indicator--active",
        expectedText: "Compacting context...",
      },
      {
        name: "recent compaction complete",
        nowMs: 1_000,
        props: {
          compactionStatus: {
            active: false,
            startedAt: 900,
            completedAt: 900,
          },
        },
        selector: ".compaction-indicator--complete",
        expectedText: "Context compacted",
      },
      {
        name: "stale compaction hidden",
        nowMs: 10_000,
        props: {
          compactionStatus: {
            active: false,
            startedAt: 0,
            completedAt: 0,
          },
        },
        selector: ".compaction-indicator",
        missing: true,
      },
      {
        name: "recent fallback active",
        nowMs: 1_000,
        props: {
          fallbackStatus: {
            selected: "fireworks/minimax-m2p5",
            active: "deepinfra/moonshotai/Kimi-K2.5",
            attempts: ["fireworks/minimax-m2p5: rate limit"],
            occurredAt: 900,
          },
        },
        selector: ".compaction-indicator--fallback",
        expectedText: "Fallback active: deepinfra/moonshotai/Kimi-K2.5",
      },
      {
        name: "stale fallback hidden",
        nowMs: 20_000,
        props: {
          fallbackStatus: {
            selected: "fireworks/minimax-m2p5",
            active: "deepinfra/moonshotai/Kimi-K2.5",
            attempts: [],
            occurredAt: 0,
          },
        },
        selector: ".compaction-indicator--fallback",
        missing: true,
      },
      {
        name: "recent fallback cleared",
        nowMs: 1_000,
        props: {
          fallbackStatus: {
            phase: "cleared",
            selected: "fireworks/minimax-m2p5",
            active: "fireworks/minimax-m2p5",
            previous: "deepinfra/moonshotai/Kimi-K2.5",
            attempts: [],
            occurredAt: 900,
          },
        },
        selector: ".compaction-indicator--fallback-cleared",
        expectedText: "Fallback cleared: fireworks/minimax-m2p5",
      },
    ] as const;

    for (const testCase of cases) {
      const nowSpy =
        testCase.nowMs === undefined ? null : vi.spyOn(Date, "now").mockReturnValue(testCase.nowMs);
      const container = document.createElement("div");
      render(renderChat(createProps(testCase.props)), container);
      const indicator = container.querySelector(testCase.selector);
      if (testCase.missing) {
        expect(indicator, testCase.name).toBeNull();
      } else {
        expect(indicator, testCase.name).not.toBeNull();
        expect(indicator?.textContent, testCase.name).toContain(testCase.expectedText);
      }
      nowSpy?.mockRestore();
    }
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
