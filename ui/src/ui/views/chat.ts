import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";

import { stripThinkingTags } from "../format";
import { toSanitizedMarkdownHtml } from "../markdown";
import { formatToolDetail, resolveToolDisplay } from "../tool-display";
import type { SessionsListResult } from "../types";
import type { ChatQueueItem } from "../ui-types";
import type { ChatItem, MessageGroup, ToolCard } from "../types/chat-types";
import { TOOL_INLINE_THRESHOLD } from "../chat/constants";
import {
  formatToolOutputForSidebar,
  getTruncatedPreview,
} from "../chat/tool-helpers";
import {
  normalizeMessage,
  normalizeRoleForGrouping,
  isToolResultMessage,
} from "../chat/message-normalizer";
import { renderMarkdownSidebar } from "./markdown-sidebar";
import "../components/resizable-divider";

export type ChatProps = {
  sessionKey: string;
  onSessionKeyChange: (next: string) => void;
  thinkingLevel: string | null;
  loading: boolean;
  sending: boolean;
  messages: unknown[];
  toolMessages: unknown[];
  stream: string | null;
  streamStartedAt: number | null;
  draft: string;
  queue: ChatQueueItem[];
  connected: boolean;
  canSend: boolean;
  disabledReason: string | null;
  error: string | null;
  sessions: SessionsListResult | null;
  // Legacy tool output expand/collapse (used when useNewChatLayout is false)
  isToolOutputExpanded: (id: string) => boolean;
  onToolOutputToggle: (id: string, expanded: boolean) => void;
  // Focus mode
  focusMode: boolean;
  // Feature flag for new Slack-style layout with sidebar
  useNewChatLayout?: boolean;
  // Sidebar state (used when useNewChatLayout is true)
  sidebarOpen?: boolean;
  sidebarContent?: string | null;
  sidebarError?: string | null;
  splitRatio?: number;
  // Event handlers
  onRefresh: () => void;
  onToggleFocusMode: () => void;
  onToggleLayout?: () => void;
  onDraftChange: (next: string) => void;
  onSend: () => void;
  onQueueRemove: (id: string) => void;
  onNewSession: () => void;
  onOpenSidebar?: (content: string) => void;
  onCloseSidebar?: () => void;
  onSplitRatioChange?: (ratio: number) => void;
};

export function renderChat(props: ChatProps) {
  const canCompose = props.connected;
  const isBusy = props.sending || Boolean(props.stream);
  const activeSession = props.sessions?.sessions?.find(
    (row) => row.key === props.sessionKey,
  );
  const reasoningLevel = activeSession?.reasoningLevel ?? "off";
  const showReasoning = reasoningLevel !== "off";

  const composePlaceholder = props.connected
    ? "Message (↩ to send, Shift+↩ for line breaks)"
    : "Connect to the gateway to start chatting…";

  const splitRatio = props.splitRatio ?? 0.6;
  const sidebarOpen = Boolean(props.sidebarOpen && props.onCloseSidebar);
  const useNewLayout = props.useNewChatLayout ?? false;

  return html`
    <section class="card chat">
      ${props.disabledReason
        ? html`<div class="callout">${props.disabledReason}</div>`
        : nothing}

      ${props.error
        ? html`<div class="callout danger">${props.error}</div>`
        : nothing}

      ${props.focusMode
        ? html`
            <button
              class="chat-focus-exit"
              type="button"
              @click=${props.onToggleFocusMode}
              aria-label="Exit focus mode"
              title="Exit focus mode"
            >
              ✕
            </button>
          `
        : nothing}

      <div
        class="chat-split-container ${sidebarOpen ? "chat-split-container--open" : ""}"
      >
        <div
          class="chat-main"
          style="flex: ${sidebarOpen ? `0 0 ${splitRatio * 100}%` : "1 1 100%"}"
        >
          <div class="chat-thread" role="log" aria-live="polite">
            ${props.loading
              ? html`<div class="muted">Loading chat…</div>`
              : nothing}
            ${repeat(buildChatItems(props), (item) => item.key, (item) => {
              if (item.kind === "reading-indicator") {
                return useNewLayout
                  ? renderReadingIndicatorGroup()
                  : renderReadingIndicator();
              }

              if (item.kind === "stream") {
                return useNewLayout
                  ? renderStreamingGroup(
                      item.text,
                      item.startedAt,
                      props.onOpenSidebar,
                    )
                  : renderMessage(
                      {
                        role: "assistant",
                        content: [{ type: "text", text: item.text }],
                        timestamp: item.startedAt,
                      },
                      props,
                      { streaming: true, showReasoning },
                    );
              }

              if (item.kind === "group") {
                return renderMessageGroup(item, {
                  onOpenSidebar: props.onOpenSidebar,
                  showReasoning,
                });
              }

              return renderMessage(item.message, props, { showReasoning });
            })}
          </div>
        </div>

        ${useNewLayout && sidebarOpen
          ? html`
              <resizable-divider
                .splitRatio=${splitRatio}
                @resize=${(e: CustomEvent) =>
                  props.onSplitRatioChange?.(e.detail.splitRatio)}
              ></resizable-divider>
              <div class="chat-sidebar">
                ${renderMarkdownSidebar({
                  content: props.sidebarContent ?? null,
                  error: props.sidebarError ?? null,
                  onClose: props.onCloseSidebar!,
                  onViewRawText: () => {
                    if (!props.sidebarContent || !props.onOpenSidebar) return;
                    props.onOpenSidebar(`\`\`\`\n${props.sidebarContent}\n\`\`\``);
                  },
                })}
              </div>
            `
          : nothing}
      </div>

      ${props.queue.length
        ? html`
            <div class="chat-queue" role="status" aria-live="polite">
              <div class="chat-queue__title">Queued (${props.queue.length})</div>
              <div class="chat-queue__list">
                ${props.queue.map(
                  (item) => html`
                    <div class="chat-queue__item">
                      <div class="chat-queue__text">${item.text}</div>
                      <button
                        class="btn chat-queue__remove"
                        type="button"
                        aria-label="Remove queued message"
                        @click=${() => props.onQueueRemove(item.id)}
                      >
                        ✕
                      </button>
                    </div>
                  `,
                )}
              </div>
            </div>
          `
        : nothing}

      <div class="chat-compose">
        <label class="field chat-compose__field">
          <span>Message</span>
          <textarea
            .value=${props.draft}
            ?disabled=${!props.connected}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key !== "Enter") return;
              if (e.isComposing || e.keyCode === 229) return;
              if (e.shiftKey) return; // Allow Shift+Enter for line breaks
              if (!props.connected) return;
              e.preventDefault();
              if (canCompose) props.onSend();
            }}
            @input=${(e: Event) =>
              props.onDraftChange((e.target as HTMLTextAreaElement).value)}
            placeholder=${composePlaceholder}
          ></textarea>
        </label>
        <div class="chat-compose__actions">
          <button
            class="btn"
            ?disabled=${!props.connected || props.sending}
            @click=${props.onNewSession}
          >
            New session
          </button>
          <button
            class="btn primary"
            ?disabled=${!props.connected}
            @click=${props.onSend}
          >
            ${isBusy ? "Queue" : "Send"}
          </button>
        </div>
      </div>
    </section>
  `;
}

const CHAT_HISTORY_RENDER_LIMIT = 200;

function groupMessages(items: ChatItem[]): Array<ChatItem | MessageGroup> {
  const result: Array<ChatItem | MessageGroup> = [];
  let currentGroup: MessageGroup | null = null;

  for (const item of items) {
    if (item.kind !== "message") {
      if (currentGroup) {
        result.push(currentGroup);
        currentGroup = null;
      }
      result.push(item);
      continue;
    }

    const normalized = normalizeMessage(item.message);
    const role = normalizeRoleForGrouping(normalized.role);
    const timestamp = normalized.timestamp || Date.now();

    if (!currentGroup || currentGroup.role !== role) {
      if (currentGroup) result.push(currentGroup);
      currentGroup = {
        kind: "group",
        key: `group:${role}:${item.key}`,
        role,
        messages: [{ message: item.message, key: item.key }],
        timestamp,
        isStreaming: false,
      };
    } else {
      currentGroup.messages.push({ message: item.message, key: item.key });
    }
  }

  if (currentGroup) result.push(currentGroup);
  return result;
}

function buildChatItems(props: ChatProps): Array<ChatItem | MessageGroup> {
  const items: ChatItem[] = [];
  const history = Array.isArray(props.messages) ? props.messages : [];
  const tools = Array.isArray(props.toolMessages) ? props.toolMessages : [];
  const historyStart = Math.max(0, history.length - CHAT_HISTORY_RENDER_LIMIT);
  if (historyStart > 0) {
    items.push({
      kind: "message",
      key: "chat:history:notice",
      message: {
        role: "system",
        content: `Showing last ${CHAT_HISTORY_RENDER_LIMIT} messages (${historyStart} hidden).`,
        timestamp: Date.now(),
      },
    });
  }
  for (let i = historyStart; i < history.length; i++) {
    items.push({
      kind: "message",
      key: messageKey(history[i], i),
      message: history[i],
    });
  }
  for (let i = 0; i < tools.length; i++) {
    items.push({
      kind: "message",
      key: messageKey(tools[i], i + history.length),
      message: tools[i],
    });
  }

  if (props.stream !== null) {
    const key = `stream:${props.sessionKey}:${props.streamStartedAt ?? "live"}`;
    if (props.stream.trim().length > 0) {
      items.push({
        kind: "stream",
        key,
        text: props.stream,
        startedAt: props.streamStartedAt ?? Date.now(),
      });
    } else {
      items.push({ kind: "reading-indicator", key });
    }
  }

  if (props.useNewChatLayout) return groupMessages(items);
  return items;
}

function messageKey(message: unknown, index: number): string {
  const m = message as Record<string, unknown>;
  const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
  if (toolCallId) return `tool:${toolCallId}`;
  const id = typeof m.id === "string" ? m.id : "";
  if (id) return `msg:${id}`;
  const messageId = typeof m.messageId === "string" ? m.messageId : "";
  if (messageId) return `msg:${messageId}`;
  const timestamp = typeof m.timestamp === "number" ? m.timestamp : null;
  const role = typeof m.role === "string" ? m.role : "unknown";
  const fingerprint =
    extractText(message) ?? (typeof m.content === "string" ? m.content : null);
  const seed = fingerprint ?? safeJson(message) ?? String(index);
  const hash = fnv1a(seed);
  return timestamp ? `msg:${role}:${timestamp}:${hash}` : `msg:${role}:${hash}`;
}

function safeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function renderReadingIndicator() {
  return html`
    <div class="chat-line assistant">
      <div class="chat-msg">
        <div class="chat-bubble chat-reading-indicator" aria-hidden="true">
          <span class="chat-reading-indicator__dots">
            <span></span><span></span><span></span>
          </span>
        </div>
      </div>
    </div>
  `;
}

function renderReadingIndicatorGroup() {
  return html`
    <div class="chat-group assistant">
      ${renderAvatar("assistant")}
      <div class="chat-group-messages">
        <div class="chat-bubble chat-reading-indicator" aria-hidden="true">
          <span class="chat-reading-indicator__dots">
            <span></span><span></span><span></span>
          </span>
        </div>
      </div>
    </div>
  `;
}

function renderMessage(
  message: unknown,
  props?: Pick<ChatProps, "isToolOutputExpanded" | "onToolOutputToggle">,
  opts?: { streaming?: boolean; showReasoning?: boolean },
) {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "unknown";
  const toolCards = extractToolCards(message);
  const hasToolCards = toolCards.length > 0;
  const isToolResult =
    isToolResultMessage(message) ||
    typeof m.toolCallId === "string" ||
    typeof m.tool_call_id === "string";
  const extractedText = extractText(message);
  const extractedThinking =
    opts?.showReasoning && role === "assistant" ? extractThinking(message) : null;
  const contentText = typeof m.content === "string" ? m.content : null;
  const fallback = hasToolCards ? null : JSON.stringify(message, null, 2);

  const display =
    !isToolResult && extractedText?.trim()
      ? { kind: "text" as const, value: extractedText }
      : !isToolResult && contentText?.trim()
        ? { kind: "text" as const, value: contentText }
        : !isToolResult && fallback
          ? { kind: "json" as const, value: fallback }
          : null;

  const markdownBase =
    display?.kind === "json"
      ? ["```json", display.value, "```"].join("\n")
      : (display?.value ?? null);
  const markdown = extractedThinking
    ? [formatReasoningMarkdown(extractedThinking), markdownBase]
        .filter(Boolean)
        .join("\n\n")
    : markdownBase;

  const timestamp =
    typeof m.timestamp === "number" ? new Date(m.timestamp).toLocaleTimeString() : "";

  const normalizedRole = normalizeRoleForGrouping(role);
  const klass =
    normalizedRole === "assistant"
      ? "assistant"
      : normalizedRole === "user"
        ? "user"
        : "other";
  const who =
    normalizedRole === "assistant"
      ? "Assistant"
      : normalizedRole === "user"
        ? "You"
        : normalizedRole;

  const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
  const toolCardBase =
    toolCallId ||
    (typeof m.id === "string" ? m.id : "") ||
    (typeof m.messageId === "string" ? m.messageId : "") ||
    (typeof m.timestamp === "number" ? String(m.timestamp) : "tool-card");

  return html`
    <div class="chat-line ${klass}">
      <div class="chat-msg">
        <div class="chat-bubble ${opts?.streaming ? "streaming" : ""}">
          ${markdown
            ? html`<div class="chat-text">${unsafeHTML(toSanitizedMarkdownHtml(markdown))}</div>`
            : nothing}
          ${toolCards.map((card, index) =>
            renderToolCardLegacy(card, {
              id: `${toolCardBase}:${index}`,
              expanded: props?.isToolOutputExpanded
                ? props.isToolOutputExpanded(`${toolCardBase}:${index}`)
                : false,
              onToggle: props?.onToolOutputToggle,
            }),
          )}
        </div>
        <div class="chat-stamp mono">
          ${who}${timestamp ? html` · ${timestamp}` : nothing}
        </div>
      </div>
    </div>
  `;
}

function extractText(message: unknown): string | null {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "";
  const content = m.content;
  if (typeof content === "string") {
    return role === "assistant" ? stripThinkingTags(content) : content;
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => {
        const item = p as Record<string, unknown>;
        if (item.type === "text" && typeof item.text === "string") return item.text;
        return null;
      })
      .filter((v): v is string => typeof v === "string");
    if (parts.length > 0) {
      const joined = parts.join("\n");
      return role === "assistant" ? stripThinkingTags(joined) : joined;
    }
  }
  if (typeof m.text === "string") {
    return role === "assistant" ? stripThinkingTags(m.text) : m.text;
  }
  return null;
}

function extractThinking(message: unknown): string | null {
  const m = message as Record<string, unknown>;
  const content = m.content;
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const p of content) {
      const item = p as Record<string, unknown>;
      if (item.type === "thinking" && typeof item.thinking === "string") {
        const cleaned = item.thinking.trim();
        if (cleaned) parts.push(cleaned);
      }
    }
  }
  if (parts.length > 0) return parts.join("\n");

  // Back-compat: older logs may still have <think> tags inside text blocks.
  const rawText = extractRawText(message);
  if (!rawText) return null;
  const matches = [
    ...rawText.matchAll(
      /<\s*think(?:ing)?\s*>([\s\S]*?)<\s*\/\s*think(?:ing)?\s*>/gi,
    ),
  ];
  const extracted = matches
    .map((m) => (m[1] ?? "").trim())
    .filter(Boolean);
  return extracted.length > 0 ? extracted.join("\n") : null;
}

function extractRawText(message: unknown): string | null {
  const m = message as Record<string, unknown>;
  const content = m.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => {
        const item = p as Record<string, unknown>;
        if (item.type === "text" && typeof item.text === "string") return item.text;
        return null;
      })
      .filter((v): v is string => typeof v === "string");
    if (parts.length > 0) return parts.join("\n");
  }
  if (typeof m.text === "string") return m.text;
  return null;
}

function formatReasoningMarkdown(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `_${line}_`);
  return lines.length ? ["_Reasoning:_", ...lines].join("\n") : "";
}

function extractToolCards(message: unknown): ToolCard[] {
  const m = message as Record<string, unknown>;
  const content = normalizeContent(m.content);
  const cards: ToolCard[] = [];

  for (const item of content) {
    const kind = String(item.type ?? "").toLowerCase();
    const isToolCall =
      ["toolcall", "tool_call", "tooluse", "tool_use"].includes(kind) ||
      (typeof item.name === "string" && item.arguments != null);
    if (isToolCall) {
      cards.push({
        kind: "call",
        name: (item.name as string) ?? "tool",
        args: coerceArgs(item.arguments ?? item.args),
      });
    }
  }

  for (const item of content) {
    const kind = String(item.type ?? "").toLowerCase();
    if (kind !== "toolresult" && kind !== "tool_result") continue;
    const text = extractToolText(item);
    const name = typeof item.name === "string" ? item.name : "tool";
    cards.push({ kind: "result", name, text });
  }

  if (
    isToolResultMessage(message) &&
    !cards.some((card) => card.kind === "result")
  ) {
    const name =
      (typeof m.toolName === "string" && m.toolName) ||
      (typeof m.tool_name === "string" && m.tool_name) ||
      "tool";
    const text = extractText(message) ?? undefined;
    cards.push({ kind: "result", name, text });
  }

  return cards;
}

function renderToolCardLegacy(
  card: ToolCard,
  opts?: {
    id: string;
    expanded: boolean;
    onToggle?: (id: string, expanded: boolean) => void;
  },
) {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);
  const hasOutput = typeof card.text === "string" && card.text.length > 0;
  const expanded = opts?.expanded ?? false;
  const id = opts?.id ?? `${card.name}-${Math.random()}`;
  return html`
    <div class="chat-tool-card">
      <div class="chat-tool-card__header">
        <div class="chat-tool-card__title">
          <span class="chat-tool-card__icon">${display.emoji}</span>
          <span>${display.label}</span>
        </div>
        ${!hasOutput ? html`<span class="chat-tool-card__status">✓</span>` : nothing}
      </div>
      ${detail
        ? html`<div class="chat-tool-card__detail">${detail}</div>`
        : nothing}
      ${hasOutput
        ? html`
            <details
              class="chat-tool-card__details"
              ?open=${expanded}
              @toggle=${(e: Event) => {
                if (!opts?.onToggle) return;
                const target = e.currentTarget as HTMLDetailsElement;
                opts.onToggle(id, target.open);
              }}
            >
              <summary class="chat-tool-card__summary">
                ${expanded ? "Hide output" : "Show output"}
                <span class="chat-tool-card__summary-meta">
                  (${card.text?.length ?? 0} chars)
                </span>
              </summary>
              ${expanded
                ? html`<div class="chat-tool-card__output chat-text">
                    ${unsafeHTML(toSanitizedMarkdownHtml(card.text ?? ""))}
                  </div>`
                : nothing}
            </details>
          `
        : nothing}
    </div>
  `;
}

function renderToolCardSidebar(
  card: ToolCard,
  onOpenSidebar?: (content: string) => void,
) {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);
  const hasText = Boolean(card.text?.trim());

  const canClick = Boolean(onOpenSidebar);
  const handleClick = canClick
    ? () => {
        if (hasText) {
          onOpenSidebar!(formatToolOutputForSidebar(card.text!));
          return;
        }
        const info = `## ${display.label}\n\n${
          detail ? `**Command:** \`${detail}\`\n\n` : ""
        }*No output — tool completed successfully.*`;
        onOpenSidebar!(info);
      }
    : undefined;

  const isShort = hasText && (card.text?.length ?? 0) <= TOOL_INLINE_THRESHOLD;
  const showCollapsed = hasText && !isShort;
  const showInline = hasText && isShort;
  const isEmpty = !hasText;

  return html`
    <div
      class="chat-tool-card ${canClick ? "chat-tool-card--clickable" : ""}"
      @click=${handleClick}
      role=${canClick ? "button" : nothing}
      tabindex=${canClick ? "0" : nothing}
      @keydown=${canClick
        ? (e: KeyboardEvent) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            handleClick?.();
          }
        : nothing}
    >
      <div class="chat-tool-card__header">
        <div class="chat-tool-card__title">
          <span class="chat-tool-card__icon">${display.emoji}</span>
          <span>${display.label}</span>
        </div>
        ${canClick
          ? html`<span class="chat-tool-card__action">${hasText ? "View ›" : "›"}</span>`
          : nothing}
        ${isEmpty && !canClick ? html`<span class="chat-tool-card__status">✓</span>` : nothing}
      </div>
      ${detail
        ? html`<div class="chat-tool-card__detail">${detail}</div>`
        : nothing}
      ${isEmpty
        ? html`<div class="chat-tool-card__status-text muted">Completed</div>`
        : nothing}
      ${showCollapsed
        ? html`<div class="chat-tool-card__preview mono">${getTruncatedPreview(card.text!)}</div>`
        : nothing}
      ${showInline
        ? html`<div class="chat-tool-card__inline mono">${card.text}</div>`
        : nothing}
    </div>
  `;
}

function renderAvatar(role: string) {
  const normalized = normalizeRoleForGrouping(role);
  const initial = normalized === "user" ? "U" : normalized === "assistant" ? "A" : "?";
  const className = normalized === "user" ? "user" : normalized === "assistant" ? "assistant" : "other";
  return html`<div class="chat-avatar ${className}">${initial}</div>`;
}

function renderStreamingGroup(
  text: string,
  startedAt: number,
  onOpenSidebar?: (content: string) => void,
) {
  const timestamp = new Date(startedAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  return html`
    <div class="chat-group assistant">
      ${renderAvatar("assistant")}
      <div class="chat-group-messages">
        ${renderGroupedMessage(
          {
            role: "assistant",
            content: [{ type: "text", text }],
            timestamp: startedAt,
          },
          { isStreaming: true, showReasoning: false },
          onOpenSidebar,
        )}
        <div class="chat-group-footer">
          <span class="chat-sender-name">Assistant</span>
          <span class="chat-group-timestamp">${timestamp}</span>
        </div>
      </div>
    </div>
  `;
}

function renderMessageGroup(
  group: MessageGroup,
  opts: { onOpenSidebar?: (content: string) => void; showReasoning: boolean },
) {
  const normalizedRole = normalizeRoleForGrouping(group.role);
  const who =
    normalizedRole === "user"
      ? "You"
      : normalizedRole === "assistant"
        ? "Assistant"
        : normalizedRole;
  const roleClass =
    normalizedRole === "user"
      ? "user"
      : normalizedRole === "assistant"
        ? "assistant"
        : "other";
  const timestamp = new Date(group.timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  return html`
    <div class="chat-group ${roleClass}">
      ${renderAvatar(group.role)}
      <div class="chat-group-messages">
        ${group.messages.map((item, index) =>
          renderGroupedMessage(
            item.message,
            {
              isStreaming:
                group.isStreaming && index === group.messages.length - 1,
              showReasoning: opts.showReasoning,
            },
            opts.onOpenSidebar,
          ),
        )}
        <div class="chat-group-footer">
          <span class="chat-sender-name">${who}</span>
          <span class="chat-group-timestamp">${timestamp}</span>
        </div>
      </div>
    </div>
  `;
}

function renderGroupedMessage(
  message: unknown,
  opts: { isStreaming: boolean; showReasoning: boolean },
  onOpenSidebar?: (content: string) => void,
) {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "unknown";
  const isToolResult =
    isToolResultMessage(message) ||
    role.toLowerCase() === "toolresult" ||
    role.toLowerCase() === "tool_result" ||
    typeof m.toolCallId === "string" ||
    typeof m.tool_call_id === "string";

  const toolCards = extractToolCards(message);
  const hasToolCards = toolCards.length > 0;

  const extractedText = extractText(message);
  const extractedThinking =
    opts.showReasoning && role === "assistant" ? extractThinking(message) : null;
  const markdownBase = extractedText?.trim() ? extractedText : null;
  const markdown = extractedThinking
    ? [formatReasoningMarkdown(extractedThinking), markdownBase]
        .filter(Boolean)
        .join("\n\n")
    : markdownBase;

  const bubbleClasses = [
    "chat-bubble",
    opts.isStreaming ? "streaming" : "",
    "fade-in",
  ]
    .filter(Boolean)
    .join(" ");

  if (!markdown && hasToolCards && isToolResult) {
    return html`${toolCards.map((card) =>
      renderToolCardSidebar(card, onOpenSidebar),
    )}`;
  }

  if (!markdown && !hasToolCards) return nothing;

  return html`
    <div class="${bubbleClasses}">
      ${markdown
        ? html`<div class="chat-text">${unsafeHTML(toSanitizedMarkdownHtml(markdown))}</div>`
        : nothing}
      ${toolCards.map((card) => renderToolCardSidebar(card, onOpenSidebar))}
    </div>
  `;
}

function normalizeContent(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content.filter(Boolean) as Array<Record<string, unknown>>;
}

function coerceArgs(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function extractToolText(item: Record<string, unknown>): string | undefined {
  if (typeof item.text === "string") return item.text;
  if (typeof item.content === "string") return item.content;
  return undefined;
}
