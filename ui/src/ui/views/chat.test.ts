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

  it("renders security approval strip for pending sentinel approval", () => {
    const container = document.createElement("div");
    const onSecurityApprove = vi.fn();
    const onSecurityDeny = vi.fn();
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "I encountered a security alert and need your explicit permission to continue. Would you like to allow this action?",
                },
              ],
            },
          ],
          onSecurityApprove,
          onSecurityDeny,
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-approval-strip")).not.toBeNull();

    const buttons = Array.from(container.querySelectorAll(".chat-approval-strip button"));
    const approve = buttons.find((btn) => btn.textContent?.trim() === "Approve");
    const deny = buttons.find((btn) => btn.textContent?.trim() === "Do not approve");
    approve?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    deny?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onSecurityApprove).toHaveBeenCalledTimes(1);
    expect(onSecurityDeny).toHaveBeenCalledTimes(1);
  });

  it("shows passphrase field and blocks approve until filled when required", () => {
    const container = document.createElement("div");
    const onSecurityApprove = vi.fn();
    const onSecurityPassphraseChange = vi.fn();
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Security sentinel blocked tool call: approval requires securitySentinelPassphrase in addition to securitySentinelApproved=true",
                },
              ],
            },
          ],
          securityApprovalPassphrase: "",
          onSecurityApprove,
          onSecurityDeny: vi.fn(),
          onSecurityApprovalPassphraseChange: onSecurityPassphraseChange,
        }),
      ),
      container,
    );

    const input = container.querySelector(".chat-approval-strip__secret");
    expect(input).not.toBeNull();
    const approve = Array.from(container.querySelectorAll(".chat-approval-strip button")).find(
      (btn) => btn.textContent?.trim() === "Approve",
    ) as HTMLButtonElement | undefined;
    expect(approve).not.toBeUndefined();
    expect(approve?.disabled).toBe(true);

    (input as HTMLInputElement).value = "letmein";
    input?.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onSecurityPassphraseChange).toHaveBeenCalled();
    expect(onSecurityApprove).toHaveBeenCalledTimes(0);
  });

  it("passes entered passphrase to approve callback", () => {
    const container = document.createElement("div");
    const onSecurityApprove = vi.fn();
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Security sentinel blocked tool call: approval requires securitySentinelPassphrase in addition to securitySentinelApproved=true",
                },
              ],
            },
          ],
          securityApprovalPassphrase: "letmein",
          onSecurityApprove,
          onSecurityDeny: vi.fn(),
          onSecurityApprovalPassphraseChange: vi.fn(),
        }),
      ),
      container,
    );

    const approve = Array.from(container.querySelectorAll(".chat-approval-strip button")).find(
      (btn) => btn.textContent?.trim() === "Approve",
    );
    approve?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSecurityApprove).toHaveBeenCalledWith("letmein");
  });

  it("hides security approval strip after explicit user approval response", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Security sentinel blocked tool call: set securitySentinelApproved=true to continue.",
                },
              ],
            },
            {
              role: "user",
              content: [{ type: "text", text: "SecuritySentinelApproved=true" }],
            },
          ],
          onSecurityApprove: vi.fn(),
          onSecurityDeny: vi.fn(),
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-approval-strip")).toBeNull();
  });

  it("hides security approval strip when assistant confirms approval completion", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Security sentinel blocked tool call: set securitySentinelApproved=true to continue.",
                },
              ],
              timestamp: 1000,
            },
            {
              role: "assistant",
              content: [{ type: "text", text: "SecuritySentinelApproved=true" }],
              timestamp: 2000,
            },
          ],
          onSecurityApprove: vi.fn(),
          onSecurityDeny: vi.fn(),
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-approval-strip")).toBeNull();
  });

  it("keeps security approval strip visible when assistant asks for passphrase", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Security sentinel blocked tool call: approval requires securitySentinelPassphrase in addition to securitySentinelApproved=true",
                },
              ],
              timestamp: 1000,
            },
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "I need both: securitySentinelApproved=true and your securitySentinelPassphrase.",
                },
              ],
              timestamp: 2000,
            },
          ],
          onSecurityApprove: vi.fn(),
          onSecurityDeny: vi.fn(),
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-approval-strip")).not.toBeNull();
  });

  it("hides stale security approval strip after any later user message", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Security sentinel blocked tool call: set securitySentinelApproved=true to continue.",
                },
              ],
              timestamp: 1000,
            },
            {
              role: "user",
              content: [{ type: "text", text: "ok let's continue" }],
              timestamp: 2000,
            },
          ],
          onSecurityApprove: vi.fn(),
          onSecurityDeny: vi.fn(),
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-approval-strip")).toBeNull();
  });

  it("keeps strip hidden after deny acknowledgement message", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Security sentinel blocked tool call: approval requires securitySentinelPassphrase in addition to securitySentinelApproved=true",
                },
              ],
              timestamp: 1000,
            },
            {
              role: "user",
              content: [{ type: "text", text: "SecuritySentinelApproved=false" }],
              timestamp: 2000,
            },
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Got it — approval is currently off. I won’t run any approval-gated actions unless you re-approve.",
                },
              ],
              timestamp: 3000,
            },
          ],
          onSecurityApprove: vi.fn(),
          onSecurityDeny: vi.fn(),
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-approval-strip")).toBeNull();
  });

  it("keeps strip hidden when deny acknowledgement arrives without a local deny user message", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Security sentinel blocked tool call: approval requires securitySentinelPassphrase in addition to securitySentinelApproved=true",
                },
              ],
              timestamp: 1000,
            },
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Got it — approval is currently off. I won’t run any approval-gated actions unless you re-approve.",
                },
              ],
              timestamp: 2000,
            },
          ],
          onSecurityApprove: vi.fn(),
          onSecurityDeny: vi.fn(),
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-approval-strip")).toBeNull();
  });

  it("re-shows strip when assistant asks to enable approval and provide passphrase after deny", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Understood — approval is now false/off again. I’ll stay paused on any gated actions.",
                },
              ],
              timestamp: 1000,
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Send a Signal message to my phone saying: test approval flow",
                },
              ],
              timestamp: 2000,
            },
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "I can’t run that right now — approval is currently off. Enable approval in the UI and provide securitySentinelPassphrase, then I’ll execute immediately.",
                },
              ],
              timestamp: 3000,
            },
          ],
          onSecurityApprove: vi.fn(),
          onSecurityDeny: vi.fn(),
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-approval-strip")).not.toBeNull();
    expect(container.querySelector(".chat-approval-passphrase")).not.toBeNull();
  });

  it("re-shows strip even when deny and re-prompt share the same timestamp", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Security sentinel blocked tool call: approval requires securitySentinelPassphrase in addition to securitySentinelApproved=true",
                },
              ],
              timestamp: 1000,
            },
            {
              role: "user",
              content: [{ type: "text", text: "SecuritySentinelApproved=false" }],
              timestamp: 1000,
            },
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "I can’t run that right now — approval is currently off. Enable approval in the UI and provide securitySentinelPassphrase, then I’ll execute immediately.",
                },
              ],
              timestamp: 1000,
            },
          ],
          onSecurityApprove: vi.fn(),
          onSecurityDeny: vi.fn(),
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-approval-strip")).not.toBeNull();
    expect(container.querySelector(".chat-approval-passphrase")).not.toBeNull();
  });

  it("keeps passphrase input visible while any unresolved request still requires passphrase", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Security sentinel blocked tool call: approval requires securitySentinelPassphrase in addition to securitySentinelApproved=true",
                },
              ],
              timestamp: 1000,
            },
          ],
          toolMessages: [
            {
              role: "assistant",
              content: [
                {
                  type: "toolresult",
                  name: "message",
                  text: "Security sentinel blocked tool call: explicit operator approval required (set securitySentinelApproved=true for this tool call)",
                },
              ],
              timestamp: 2000,
            },
          ],
          onSecurityApprove: vi.fn(),
          onSecurityDeny: vi.fn(),
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-approval-passphrase")).not.toBeNull();
  });

  it("hides security approval strip after later user message without text payload", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Security sentinel blocked tool call: set securitySentinelApproved=true to continue.",
                },
              ],
              timestamp: 1000,
            },
            {
              role: "user",
              timestamp: 2000,
            },
          ],
          onSecurityApprove: vi.fn(),
          onSecurityDeny: vi.fn(),
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-approval-strip")).toBeNull();
  });

  it("renders security approval strip when sentinel block appears in tool output", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [],
          toolMessages: [
            {
              role: "assistant",
              content: [
                { type: "toolcall", name: "sessions_spawn", arguments: {} },
                {
                  type: "toolresult",
                  name: "sessions_spawn",
                  text: "Security sentinel blocked tool call: explicit operator approval required (set securitySentinelApproved=true for this tool call)",
                },
              ],
              timestamp: 1000,
            },
          ],
          onSecurityApprove: vi.fn(),
          onSecurityDeny: vi.fn(),
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-approval-strip")).not.toBeNull();
  });

  it("renders approval strip when tool block has no timestamp and user messages use epoch timestamps", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "send signal ping" }],
              timestamp: 1771900000000,
            },
          ],
          toolMessages: [
            {
              role: "assistant",
              content: [
                {
                  type: "toolresult",
                  name: "message",
                  text: "Security sentinel blocked tool call: explicit operator approval required (set securitySentinelApproved=true for this tool call)",
                },
              ],
            },
          ],
          onSecurityApprove: vi.fn(),
          onSecurityDeny: vi.fn(),
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-approval-strip")).not.toBeNull();
  });

  it("renders security approval strip for non-text content blocks carrying text payloads", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "Security sentinel blocked tool call: explicit operator approval required (set securitySentinelApproved=true for this tool call).",
                },
              ],
            },
          ],
          onSecurityApprove: vi.fn(),
          onSecurityDeny: vi.fn(),
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-approval-strip")).not.toBeNull();
  });

  it("hides security approval strip when user already answered after tool block", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "SecuritySentinelApproved=true" }],
              timestamp: 2000,
            },
          ],
          toolMessages: [
            {
              role: "assistant",
              content: [
                {
                  type: "toolresult",
                  name: "sessions_spawn",
                  text: "Security sentinel blocked tool call: explicit operator approval required.",
                },
              ],
              timestamp: 1000,
            },
          ],
          onSecurityApprove: vi.fn(),
          onSecurityDeny: vi.fn(),
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-approval-strip")).toBeNull();
  });
});
