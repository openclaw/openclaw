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
});

describe("chat attachments", () => {
  function renderCompose(overrides: Partial<ChatProps> = {}) {
    const container = document.createElement("div");
    render(renderChat(createProps(overrides)), container);
    return container;
  }

  it("renders attach button when connected", () => {
    const container = renderCompose({ connected: true });
    const attachBtn = container.querySelector<HTMLButtonElement>(".chat-compose__attach");
    expect(attachBtn).not.toBeNull();
    expect(attachBtn?.disabled).toBe(false);
  });

  it("disables attach button when disconnected", () => {
    const container = renderCompose({ connected: false });
    const attachBtn = container.querySelector<HTMLButtonElement>(".chat-compose__attach");
    expect(attachBtn).not.toBeNull();
    expect(attachBtn?.disabled).toBe(true);
  });

  it("opens file input on attach button click", () => {
    const container = renderCompose({ connected: true });
    const fileInput = container.querySelector<HTMLInputElement>(".chat-compose__file-input");
    expect(fileInput).not.toBeNull();
    expect(fileInput?.type).toBe("file");
    expect(fileInput?.accept).toBe("image/*");
    expect(fileInput?.multiple).toBe(true);
    // Verify click wiring: attach button should trigger file input
    const clickSpy = vi.spyOn(fileInput!, "click");
    const attachBtn = container.querySelector<HTMLButtonElement>(".chat-compose__attach");
    attachBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clickSpy).toHaveBeenCalledTimes(1);
    clickSpy.mockRestore();
  });

  it("calls onAttachmentsChange when a valid image file is selected", async () => {
    const onAttachmentsChange = vi.fn();
    const container = renderCompose({
      connected: true,
      onAttachmentsChange,
    });

    const fileInput = container.querySelector<HTMLInputElement>(".chat-compose__file-input")!;
    const file = new File(["fake-image-data"], "test.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    // Wait for FileReader promise to settle
    await new Promise((r) => setTimeout(r, 50));
    expect(onAttachmentsChange).toHaveBeenCalledTimes(1);
    const attachments = onAttachmentsChange.mock.calls[0][0];
    expect(attachments).toHaveLength(1);
    expect(attachments[0].mimeType).toBe("image/png");
    expect(attachments[0].dataUrl).toContain("data:");
  });

  it("rejects files exceeding 5 MB size limit", async () => {
    const onAttachmentsChange = vi.fn();
    const container = renderCompose({
      connected: true,
      onAttachmentsChange,
    });

    const fileInput = container.querySelector<HTMLInputElement>(".chat-compose__file-input")!;
    // Create a file object that reports > 5 MB
    const bigFile = new File(["x"], "huge.png", { type: "image/png" });
    Object.defineProperty(bigFile, "size", { value: 6_000_000, configurable: true });
    Object.defineProperty(fileInput, "files", { value: [bigFile], configurable: true });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    await new Promise((r) => setTimeout(r, 50));
    expect(onAttachmentsChange).not.toHaveBeenCalled();
  });

  it("rejects non-image files", async () => {
    const onAttachmentsChange = vi.fn();
    const container = renderCompose({
      connected: true,
      onAttachmentsChange,
    });

    const fileInput = container.querySelector<HTMLInputElement>(".chat-compose__file-input")!;
    const textFile = new File(["hello"], "readme.txt", { type: "text/plain" });
    Object.defineProperty(fileInput, "files", { value: [textFile], configurable: true });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    await new Promise((r) => setTimeout(r, 50));
    expect(onAttachmentsChange).not.toHaveBeenCalled();
  });

  it("ignores drop events when disconnected", async () => {
    const onAttachmentsChange = vi.fn();
    const container = renderCompose({
      connected: false,
      onAttachmentsChange,
    });

    const compose = container.querySelector<HTMLElement>(".chat-compose")!;
    const file = new File(["img"], "drop.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    compose.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }));

    await new Promise((r) => setTimeout(r, 50));
    expect(onAttachmentsChange).not.toHaveBeenCalled();
  });

  it("adds dragover class only for file drags when connected", () => {
    const container = renderCompose({ connected: true });
    const compose = container.querySelector<HTMLElement>(".chat-compose")!;

    // Simulate dragover with Files type
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "f.png", { type: "image/png" }));
    compose.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: dt }));
    expect(compose.classList.contains("chat-compose--dragover")).toBe(true);
  });

  it("does not add dragover class when disconnected", () => {
    const container = renderCompose({ connected: false });
    const compose = container.querySelector<HTMLElement>(".chat-compose")!;

    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "f.png", { type: "image/png" }));
    compose.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: dt }));
    expect(compose.classList.contains("chat-compose--dragover")).toBe(false);
  });

  it("batches multiple files into a single onAttachmentsChange call", async () => {
    const onAttachmentsChange = vi.fn();
    const container = renderCompose({
      connected: true,
      onAttachmentsChange,
    });

    const fileInput = container.querySelector<HTMLInputElement>(".chat-compose__file-input")!;
    const file1 = new File(["img1"], "a.png", { type: "image/png" });
    const file2 = new File(["img2"], "b.jpg", { type: "image/jpeg" });
    Object.defineProperty(fileInput, "files", { value: [file1, file2], configurable: true });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    await new Promise((r) => setTimeout(r, 50));
    expect(onAttachmentsChange).toHaveBeenCalledTimes(1);
    expect(onAttachmentsChange.mock.calls[0][0]).toHaveLength(2);
  });
});
