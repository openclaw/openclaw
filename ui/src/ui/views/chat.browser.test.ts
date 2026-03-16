import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import "../../styles.css";
import { renderChat, type ChatProps } from "./chat.ts";

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
    sessions: {
      ts: 0,
      path: "",
      count: 1,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [
        {
          key: "main",
          kind: "direct",
          updatedAt: null,
          // No totalTokensFresh field (old row) — should fall back to inputTokens
          inputTokens: 3_800,
          contextTokens: 4_000,
        },
      ],
    },
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

describe("chat context notice", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps the warning icon badge-sized", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(renderChat(createProps()), container);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const icon = container.querySelector<SVGElement>(".context-notice__icon");
    expect(icon).not.toBeNull();
    if (!icon) {
      return;
    }

    const iconStyle = getComputedStyle(icon);
    expect(iconStyle.width).toBe("16px");
    expect(iconStyle.height).toBe("16px");
    expect(icon.getBoundingClientRect().width).toBeLessThan(24);
  });

  it("shows notice when totalTokensFresh is absent (old row falls back to inputTokens)", async () => {
    // Rows without totalTokensFresh should fall back to inputTokens so the warning
    // is not silently suppressed for older gateway responses or test fixtures.
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderChat(
        createProps({
          sessions: {
            ts: 0,
            path: "",
            count: 1,
            defaults: { model: "gpt-5", contextTokens: null },
            sessions: [
              {
                key: "main",
                kind: "direct",
                updatedAt: null,
                inputTokens: 3_800,
                contextTokens: 4_000,
                // totalTokensFresh absent — treated as stale, falls back to inputTokens
              },
            ],
          },
        }),
      ),
      container,
    );
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(container.querySelector(".context-notice")).not.toBeNull();
  });

  it("shows notice using totalTokens when totalTokensFresh is true", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderChat(
        createProps({
          sessions: {
            ts: 0,
            path: "",
            count: 1,
            defaults: { model: "gpt-5", contextTokens: null },
            sessions: [
              {
                key: "main",
                kind: "direct",
                updatedAt: null,
                totalTokens: 3_500,
                totalTokensFresh: true,
                contextTokens: 4_000,
              },
            ],
          },
        }),
      ),
      container,
    );
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(container.querySelector(".context-notice")).not.toBeNull();
  });

  it("hides notice when totalTokensFresh is false and inputTokens is low", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderChat(
        createProps({
          sessions: {
            ts: 0,
            path: "",
            count: 1,
            defaults: { model: "gpt-5", contextTokens: null },
            sessions: [
              {
                key: "main",
                kind: "direct",
                updatedAt: null,
                inputTokens: 1_000,
                totalTokensFresh: false,
                contextTokens: 4_000,
              },
            ],
          },
        }),
      ),
      container,
    );
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    // inputTokens/contextTokens = 25% — below 85% threshold, no notice
    expect(container.querySelector(".context-notice")).toBeNull();
  });

  it("never shows notice with impossible values when inputTokens exceeds contextTokens", async () => {
    // inputTokens is cumulative and can exceed contextTokens — must be capped so
    // the displayed ratio never exceeds 100%.
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderChat(
        createProps({
          sessions: {
            ts: 0,
            path: "",
            count: 1,
            defaults: { model: "gpt-5", contextTokens: null },
            sessions: [
              {
                key: "main",
                kind: "direct",
                updatedAt: null,
                inputTokens: 550_000,
                totalTokensFresh: false,
                contextTokens: 200_000,
              },
            ],
          },
        }),
      ),
      container,
    );
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const notice = container.querySelector(".context-notice");
    expect(notice).not.toBeNull();
    const detail = notice?.querySelector(".context-notice__detail")?.textContent ?? "";
    // Should show "200k / 200k" (capped), not "550k / 200k" (impossible)
    expect(detail).not.toContain("550");
    expect(detail).toContain("200k");
  });
});
