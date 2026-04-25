/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderChatQueue } from "../chat/chat-queue.ts";
import { buildRawSidebarContent } from "../chat/chat-sidebar-raw.ts";
import { renderWelcomeState } from "../chat/chat-welcome.ts";
import type { ChatQueueItem } from "../ui-types.ts";

vi.mock("../icons.ts", () => ({
  icons: new Proxy(
    {},
    {
      get: () => "",
    },
  ),
}));

vi.mock("./agents-utils.ts", () => ({
  agentLogoUrl: () => "/openclaw-logo.svg",
  assistantAvatarFallbackUrl: () => "apple-touch-icon.png",
  resolveChatAvatarRenderUrl: (
    candidate: string | null | undefined,
    agent: { identity?: { avatar?: string; avatarUrl?: string } },
  ) => {
    if (typeof candidate === "string" && candidate.startsWith("blob:")) {
      return candidate;
    }
    if (
      typeof agent.identity?.avatarUrl === "string" &&
      agent.identity.avatarUrl.startsWith("blob:")
    ) {
      return agent.identity.avatarUrl;
    }
    return null;
  },
  resolveAssistantTextAvatar: (value: string | null | undefined) => {
    if (!value) {
      return null;
    }
    return value.length <= 3 ? value : null;
  },
}));

function renderQueue(params: {
  queue: ChatQueueItem[];
  canAbort?: boolean;
  onQueueSteer?: (id: string) => void;
}) {
  const container = document.createElement("div");
  render(
    renderChatQueue({
      queue: params.queue,
      canAbort: params.canAbort ?? true,
      onQueueSteer: params.onQueueSteer,
      onQueueRemove: () => undefined,
    }),
    container,
  );
  return container;
}

describe("chat queue", () => {
  it("renders Steer only for queued messages during an active run", () => {
    const onQueueSteer = vi.fn();
    const container = renderQueue({
      onQueueSteer,
      queue: [
        { id: "queued-1", text: "tighten the plan", createdAt: 1 },
        { id: "steered-1", text: "already sent", createdAt: 2, kind: "steered" },
        { id: "local-1", text: "/status", createdAt: 3, localCommandName: "status" },
      ],
    });

    const steerButtons = container.querySelectorAll<HTMLButtonElement>(".chat-queue__steer");
    expect(steerButtons).toHaveLength(1);
    expect(steerButtons[0].textContent?.trim()).toBe("Steer");
    expect(container.querySelector(".chat-queue__badge")?.textContent?.trim()).toBe("Steered");

    steerButtons[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onQueueSteer).toHaveBeenCalledWith("queued-1");
  });

  it("hides queued-message Steer when no run is active", () => {
    const container = renderQueue({
      canAbort: false,
      onQueueSteer: vi.fn(),
      queue: [{ id: "queued-1", text: "tighten the plan", createdAt: 1 }],
    });

    expect(container.querySelector(".chat-queue__steer")).toBeNull();
  });
});

describe("chat sidebar raw content", () => {
  it("keeps markdown raw text toggles idempotent", () => {
    const rawMarkdown = "```ts\nconst value = 1;\n```";

    expect(
      buildRawSidebarContent({
        kind: "markdown",
        content: `\`\`\`\n${rawMarkdown}\n\`\`\``,
        rawText: rawMarkdown,
      }),
    ).toEqual({
      kind: "markdown",
      content: `\`\`\`\n${rawMarkdown}\n\`\`\``,
      rawText: rawMarkdown,
    });
  });
});

describe("chat welcome", () => {
  function renderWelcome(params: {
    assistantAvatar: string | null;
    assistantAvatarUrl?: string | null;
  }) {
    const container = document.createElement("div");
    render(
      renderWelcomeState({
        assistantName: "Val",
        assistantAvatar: params.assistantAvatar,
        assistantAvatarUrl: params.assistantAvatarUrl,
        onDraftChange: () => undefined,
        onSend: () => undefined,
      }),
      container,
    );
    return container;
  }

  it("renders configured assistant text avatars in the welcome state", () => {
    const container = renderWelcome({ assistantAvatar: "VC", assistantAvatarUrl: null });

    const avatar = container.querySelector<HTMLElement>(".agent-chat__avatar");
    expect(avatar).not.toBeNull();
    expect(avatar?.tagName).toBe("DIV");
    expect(avatar?.textContent).toContain("VC");
    expect(avatar?.getAttribute("aria-label")).toBe("Val");
  });

  it("renders configured assistant image avatars in the welcome state", () => {
    const container = renderWelcome({
      assistantAvatar: "avatars/val.png",
      assistantAvatarUrl: "blob:identity-avatar",
    });

    const avatar = container.querySelector<HTMLImageElement>("img");
    expect(avatar).not.toBeNull();
    expect(avatar?.getAttribute("src")).toBe("blob:identity-avatar");
    expect(avatar?.getAttribute("alt")).toBe("Val");
  });

  it("uses the Molty png as the welcome fallback assistant avatar", () => {
    const container = renderWelcome({ assistantAvatar: null, assistantAvatarUrl: null });

    const avatar = container.querySelector<HTMLImageElement>(".agent-chat__avatar--logo img");
    expect(avatar).not.toBeNull();
    expect(avatar?.getAttribute("src")).toBe("apple-touch-icon.png");
    expect(avatar?.getAttribute("alt")).toBe("Val");
  });
});
