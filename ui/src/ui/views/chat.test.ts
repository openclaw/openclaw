import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { ChatInputHistoryKeyResult } from "../chat/input-history.ts";
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

  it("does not enter history down from normal editing mode", () => {
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
    textarea.selectionStart = textarea.value.length;
    textarea.selectionEnd = textarea.value.length;
    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(event);

    expect(onHistoryKeydown).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
  });

  it("does not navigate history down when cursor is not at end", () => {
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

  it("allows ArrowDown while history mode is active even if caret is at start", () => {
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

  it("allows ArrowUp while history mode is active even if caret is at end", () => {
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
    textarea.selectionStart = 0;
    textarea.selectionEnd = 0;
    const event = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
    textarea.dispatchEvent(event);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(onHistoryKeydown).toHaveBeenCalledTimes(1);
    expect(textarea.selectionStart).toBe(0);
    expect(textarea.selectionEnd).toBe(0);
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
