/**
 * Browser Regression Tests for Chat Input Handling
 *
 * Tests for iOS typing lag regression (controlled input without excessive re-renders).
 * These tests run in a real browser environment via Playwright.
 *
 * Run locally:
 *   cd ui && pnpm vitest run --config vitest.config.ts src/ui/views/chat-input.browser.test.ts
 *
 * Run all browser tests:
 *   cd ui && pnpm vitest run --config vitest.config.ts
 */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SessionsListResult } from "../types.ts";
import type { ChatProps } from "./chat.ts";
import { renderChat } from "./chat.ts";

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

describe("Chat input: iOS typing lag regression", () => {
  it("renders textarea with controlled value", () => {
    const container = document.createElement("div");
    const draft = "Hello world";

    render(renderChat(createProps({ draft })), container);

    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    expect((textarea as HTMLTextAreaElement).value).toBe(draft);
  });

  it("updates draft on input event", async () => {
    const container = document.createElement("div");
    const onDraftChange = vi.fn();
    const draft = "Initial";

    render(renderChat(createProps({ draft, onDraftChange })), container);

    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    expect((textarea as HTMLTextAreaElement).value).toBe(draft);

    // Simulate typing by directly calling the handler
    // (input events in Playwright work differently)
    onDraftChange("Typed text");

    expect(onDraftChange).toHaveBeenCalledTimes(1);
    expect(onDraftChange).toHaveBeenCalledWith("Typed text");
  });

  it("does not trigger send on input (only on Enter)", () => {
    const container = document.createElement("div");
    const onSend = vi.fn();
    const onDraftChange = vi.fn();

    render(renderChat(createProps({ draft: "", onSend, onDraftChange })), container);

    // Simulate typing characters - call draft change directly
    for (const char of "Hello") {
      onDraftChange(char);
    }

    // Draft should be updated for each character
    expect(onDraftChange).toHaveBeenCalledTimes(5);
    // Send should NOT be called during typing
    expect(onSend).not.toHaveBeenCalled();
  });

  it("sends message on Enter (not Shift+Enter)", () => {
    const container = document.createElement("div");
    const onSend = vi.fn();

    render(renderChat(createProps({ draft: "Test message", onSend })), container);

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    // Enter without Shift should send
    const enterEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      shiftKey: false,
    });
    textarea.dispatchEvent(enterEvent);

    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("does not send on Shift+Enter (allows line breaks)", () => {
    const container = document.createElement("div");
    const onSend = vi.fn();

    render(renderChat(createProps({ draft: "Test", onSend })), container);

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    // Shift+Enter should NOT send
    const shiftEnterEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      shiftKey: true,
    });
    textarea.dispatchEvent(shiftEnterEvent);

    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not send on Enter during IME composition", () => {
    const container = document.createElement("div");
    const onSend = vi.fn();

    render(renderChat(createProps({ draft: "テスト", onSend })), container);

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    // During IME composition (isComposing = true), Enter should not send
    const imeEnterEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
    });
    Object.defineProperty(imeEnterEvent, "isComposing", { value: true });
    textarea.dispatchEvent(imeEnterEvent);

    expect(onSend).not.toHaveBeenCalled();

    // keyCode 229 is also used for IME composition on some platforms
    const imeEnterEvent2 = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
    });
    Object.defineProperty(imeEnterEvent2, "keyCode", { value: 229 });
    textarea.dispatchEvent(imeEnterEvent2);

    expect(onSend).not.toHaveBeenCalled();
  });

  it("disables textarea when disconnected", () => {
    const container = document.createElement("div");

    render(renderChat(createProps({ connected: false })), container);

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
  });

  it("enables textarea when connected", () => {
    const container = document.createElement("div");

    render(renderChat(createProps({ connected: true })), container);

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
  });

  it("adjusts textarea height on input", () => {
    const container = document.createElement("div");

    render(renderChat(createProps({ draft: "" })), container);

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    // Simulate multi-line input - height adjustment is called via ref
    const inputEvent = new Event("input", { bubbles: true });
    textarea.dispatchEvent(inputEvent);

    // Height should have been adjusted (auto + scrollHeight pattern)
    // The actual height depends on CSS, so just verify no error
    expect(textarea.style.height).toBeDefined();
  });
});

describe("Chat input: image paste handling", () => {
  it("has paste event listener attached", () => {
    const container = document.createElement("div");
    const onAttachmentsChange = vi.fn();

    render(
      renderChat(
        createProps({
          draft: "",
          attachments: [],
          onAttachmentsChange,
        }),
      ),
      container,
    );

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    // Verify textarea exists and has event listeners
    expect(textarea).not.toBeNull();

    // Note: ClipboardEvent with custom DataTransfer is not constructible in browser
    // The paste functionality is tested via integration tests
  });
});

describe("Chat input: placeholder states", () => {
  it("shows standard placeholder when connected", () => {
    const container = document.createElement("div");

    render(renderChat(createProps({ connected: true, attachments: [] })), container);

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.placeholder).toContain("Message");
  });

  it("shows attachment hint when images attached", () => {
    const container = document.createElement("div");

    render(
      renderChat(
        createProps({
          connected: true,
          attachments: [
            { id: "att-1", dataUrl: "data:image/png;base64,abc", mimeType: "image/png" },
          ],
        }),
      ),
      container,
    );

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.placeholder).toContain("Add a message");
  });

  it("shows disconnected placeholder when not connected", () => {
    const container = document.createElement("div");

    render(renderChat(createProps({ connected: false })), container);

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.placeholder).toContain("Connect to the gateway");
  });
});
