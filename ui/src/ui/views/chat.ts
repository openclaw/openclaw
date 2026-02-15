import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import type { SessionsListResult } from "../types.ts";
import type { ChatItem, MessageGroup } from "../types/chat-types.ts";
import type { ChatAttachment, ChatQueueItem } from "../ui-types.ts";
import {
  renderMessageGroup,
  renderReadingIndicatorGroup,
  renderStreamingGroup,
} from "../chat/grouped-render.ts";
import { normalizeMessage, normalizeRoleForGrouping } from "../chat/message-normalizer.ts";
import { icons } from "../icons.ts";
import { detectTextDirection } from "../text-direction.ts";
import { renderMarkdownSidebar } from "./markdown-sidebar.ts";
import "../components/resizable-divider.ts";

// Module-level state for autosuggest
let showSlashMenu = false;
let showAtMenu = false;
let menuFilter = "";

// Module-level state for queue
let queueExpanded = false;

// Slash commands
const SLASH_COMMANDS = [
  { cmd: "/status", desc: "Show session status" },
  { cmd: "/clear", desc: "Clear chat history" },
  { cmd: "/model", desc: "Change model" },
  { cmd: "/thinking", desc: "Toggle thinking level" },
  { cmd: "/verbose", desc: "Toggle verbose mode" },
  { cmd: "/reasoning", desc: "Toggle reasoning" },
  { cmd: "/help", desc: "Show available commands" },
];

export type CompactionIndicatorStatus = {
  active: boolean;
  startedAt: number | null;
  completedAt: number | null;
};

export type ChatProps = {
  sessionKey: string;
  onSessionKeyChange: (next: string) => void;
  thinkingLevel: string | null;
  showThinking: boolean;
  loading: boolean;
  sending: boolean;
  canAbort?: boolean;
  compactionStatus?: CompactionIndicatorStatus | null;
  messages: unknown[];
  toolMessages: unknown[];
  stream: string | null;
  streamStartedAt: number | null;
  assistantAvatarUrl?: string | null;
  draft: string;
  queue: ChatQueueItem[];
  connected: boolean;
  canSend: boolean;
  disabledReason: string | null;
  error: string | null;
  sessions: SessionsListResult | null;
  // Focus mode
  focusMode: boolean;
  // Sidebar state
  sidebarOpen?: boolean;
  sidebarContent?: string | null;
  sidebarError?: string | null;
  splitRatio?: number;
  assistantName: string;
  assistantAvatar: string | null;
  // Image attachments
  attachments?: ChatAttachment[];
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
  // Scroll control
  showNewMessages?: boolean;
  onScrollToBottom?: () => void;
  // Event handlers
  onRefresh: () => void;
  onToggleFocusMode: () => void;
  onDraftChange: (next: string) => void;
  onSend: () => void;
  onAbort?: () => void;
  onQueueRemove: (id: string) => void;
  onNewSession: () => void;
  onOpenSidebar?: (content: string) => void;
  onCloseSidebar?: () => void;
  onSplitRatioChange?: (ratio: number) => void;
  onChatScroll?: (event: Event) => void;
};

const COMPACTION_TOAST_DURATION_MS = 5000;

/** Detect system-role messages that should render as dividers instead of bubbles */
function detectSystemDivider(msg: { role: string; content: string }): string | null {
  if (msg.role.toLowerCase() !== "system") return null;
  const text = (msg.content ?? "").toLowerCase().trim();
  if (/new\s+session/i.test(text)) return "NEW SESSION";
  if (/session\s+(reset|cleared|started)/i.test(text)) return "SESSION RESET";
  if (/heartbeat/i.test(text) && text.length < 40) return "HEARTBEAT";
  if (/context\s+(window|limit|truncat)/i.test(text)) return "CONTEXT LIMIT";
  if (/compaction/i.test(text)) return "COMPACTION";
  if (/model\s+change/i.test(text)) return "MODEL CHANGE";
  if (/resumed/i.test(text) && text.length < 40) return "RESUMED";
  if (/connected/i.test(text) && text.length < 40) return "CONNECTED";
  return null;
}

function adjustTextareaHeight(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

function renderSessionTabs(props: ChatProps) {
  const sessions = props.sessions?.sessions ?? [];

  if (sessions.length === 0) {
    return nothing;
  }

  // Find main session
  const mainSession =
    sessions.find((s) => s.key === "agent:main:main" || !s.key.includes(":")) ??
    sessions.find((s) => !s.key.includes("subagent:"));

  // Get all other sessions, sorted by updatedAt descending
  const otherSessions = sessions
    .filter((s) => s.key !== mainSession?.key)
    .toSorted((a, b) => {
      const aTime = typeof a.updatedAt === "number" ? a.updatedAt : 0;
      const bTime = typeof b.updatedAt === "number" ? b.updatedAt : 0;
      return bTime - aTime;
    })
    .slice(0, 7); // Limit to 7 recent (plus main = 8 total)

  // If only main session exists, don't show the bar
  if (otherSessions.length === 0) {
    return nothing;
  }

  const getSessionDisplayName = (session: any): string => {
    // Use label or displayName if available
    if (session.label?.trim()) {
      return session.label.trim();
    }
    if (session.displayName?.trim()) {
      return session.displayName.trim();
    }

    // Extract last meaningful segment from key
    const key = session.key ?? "";
    const parts = key.split(":");
    const lastPart = parts[parts.length - 1];

    // If it's a subagent UUID, truncate to first 8 chars
    if (lastPart.length > 20) {
      return lastPart.substring(0, 8);
    }

    return lastPart || key;
  };

  return html`
    <div class="chat-session-tabs">
      <div class="chat-session-tabs__label">Recent</div>
      ${
        mainSession
          ? html`
        <button
          class="chat-session-chip ${props.sessionKey === mainSession.key ? "active" : ""}"
          @click=${() => props.onSessionKeyChange(mainSession.key)}
        >
          main
        </button>
      `
          : nothing
      }
      ${otherSessions.map((session) => {
        const displayName = getSessionDisplayName(session);
        const isActive = props.sessionKey === session.key;
        return html`
          <button
            class="chat-session-chip ${isActive ? "active" : ""}"
            @click=${() => props.onSessionKeyChange(session.key)}
            title=${session.key}
          >
            ${displayName}
          </button>
        `;
      })}
    </div>
  `;
}

function renderAutosuggestMenu(props: ChatProps, textareaEl: HTMLTextAreaElement | null) {
  if (!showSlashMenu && !showAtMenu) {
    return nothing;
  }

  if (showSlashMenu) {
    const filtered = SLASH_COMMANDS.filter((cmd) =>
      cmd.cmd.toLowerCase().includes(menuFilter.toLowerCase()),
    );

    if (filtered.length === 0) {
      return nothing;
    }

    return html`
      <div class="rpc-suggestions">
        ${filtered.map(
          (cmd) => html`
          <div
            class="rpc-suggestion"
            @click=${() => {
              if (textareaEl) {
                props.onDraftChange(cmd.cmd + " ");
                showSlashMenu = false;
                menuFilter = "";
                textareaEl.focus();
              }
            }}
          >
            <div class="rpc-suggestion__name">${cmd.cmd}</div>
            <div class="rpc-suggestion__desc">${cmd.desc}</div>
          </div>
        `,
        )}
      </div>
    `;
  }

  if (showAtMenu) {
    const sessions = props.sessions?.sessions ?? [];
    const subAgents = sessions.filter((s) => s.key.includes("subagent:"));

    if (subAgents.length === 0) {
      return nothing;
    }

    const filtered = subAgents.filter((s) =>
      s.key.toLowerCase().includes(menuFilter.toLowerCase()),
    );

    return html`
      <div class="rpc-suggestions">
        ${filtered.map((session) => {
          const shortName = session.key.split(":").pop() ?? session.key;
          return html`
            <div
              class="rpc-suggestion"
              @click=${() => {
                if (textareaEl) {
                  const cursorPos = textareaEl.selectionStart;
                  const text = props.draft;
                  const beforeAt = text.lastIndexOf("@", cursorPos - 1);
                  const newText =
                    text.substring(0, beforeAt) + `@${shortName} ` + text.substring(cursorPos);
                  props.onDraftChange(newText);
                  showAtMenu = false;
                  menuFilter = "";
                  textareaEl.focus();
                }
              }}
            >
              <div class="rpc-suggestion__name">@${shortName}</div>
            </div>
          `;
        })}
      </div>
    `;
  }

  return nothing;
}

function renderCompactionIndicator(status: CompactionIndicatorStatus | null | undefined) {
  if (!status) {
    return nothing;
  }

  // Show "compacting..." while active
  if (status.active) {
    return html`
      <div class="compaction-indicator compaction-indicator--active" role="status" aria-live="polite">
        ${icons.loader} Compacting context...
      </div>
    `;
  }

  // Show "compaction complete" briefly after completion
  if (status.completedAt) {
    const elapsed = Date.now() - status.completedAt;
    if (elapsed < COMPACTION_TOAST_DURATION_MS) {
      return html`
        <div class="compaction-indicator compaction-indicator--complete" role="status" aria-live="polite">
          ${icons.check} Context compacted
        </div>
      `;
    }
  }

  return nothing;
}

function generateAttachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function handlePaste(e: ClipboardEvent, props: ChatProps) {
  const items = e.clipboardData?.items;
  if (!items || !props.onAttachmentsChange) {
    return;
  }

  const imageItems: DataTransferItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type.startsWith("image/")) {
      imageItems.push(item);
    }
  }

  if (imageItems.length === 0) {
    return;
  }

  e.preventDefault();

  for (const item of imageItems) {
    const file = item.getAsFile();
    if (!file) {
      continue;
    }

    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const dataUrl = reader.result as string;
      const newAttachment: ChatAttachment = {
        id: generateAttachmentId(),
        dataUrl,
        mimeType: file.type,
      };
      const current = props.attachments ?? [];
      props.onAttachmentsChange?.([...current, newAttachment]);
    });
    reader.readAsDataURL(file);
  }
}

function renderAttachmentPreview(props: ChatProps) {
  const attachments = props.attachments ?? [];
  if (attachments.length === 0) {
    return nothing;
  }

  return html`
    <div class="chat-attachments">
      ${attachments.map(
        (att) => html`
          <div class="chat-attachment">
            <img
              src=${att.dataUrl}
              alt="Attachment preview"
              class="chat-attachment__img"
            />
            <button
              class="chat-attachment__remove"
              type="button"
              aria-label="Remove attachment"
              @click=${() => {
                const next = (props.attachments ?? []).filter((a) => a.id !== att.id);
                props.onAttachmentsChange?.(next);
              }}
            >
              ${icons.x}
            </button>
          </div>
        `,
      )}
    </div>
  `;
}

export function renderChat(props: ChatProps) {
  const canCompose = props.connected;
  const isBusy = props.sending || props.stream !== null;
  const canAbort = Boolean(props.canAbort && props.onAbort);
  const activeSession = props.sessions?.sessions?.find((row) => row.key === props.sessionKey);
  const reasoningLevel = activeSession?.reasoningLevel ?? "off";
  const showReasoning = props.showThinking && reasoningLevel !== "off";
  const assistantIdentity = {
    name: props.assistantName,
    avatar: props.assistantAvatar ?? props.assistantAvatarUrl ?? null,
  };

  const hasAttachments = (props.attachments?.length ?? 0) > 0;
  const composePlaceholder = props.connected
    ? hasAttachments
      ? "Add a message or paste more images..."
      : "Message (↩ to send, Shift+↩ for line breaks, paste images)"
    : "Connect to the gateway to start chatting…";

  const splitRatio = props.splitRatio ?? 0.6;
  const sidebarOpen = Boolean(props.sidebarOpen && props.onCloseSidebar);
  const thread = html`
    <div
      class="chat-thread"
      role="log"
      aria-live="polite"
      @scroll=${props.onChatScroll}
    >
      ${
        props.loading
          ? html`
              <div class="muted">Loading chat…</div>
            `
          : nothing
      }
      ${repeat(
        buildChatItems(props),
        (item) => item.key,
        (item) => {
          if (item.kind === "divider") {
            return html`
              <div class="chat-divider" role="separator" data-ts=${String(item.timestamp)}>
                <span class="chat-divider__line"></span>
                <span class="chat-divider__label">${item.label}</span>
                <span class="chat-divider__line"></span>
              </div>
            `;
          }

          if (item.kind === "reading-indicator") {
            return renderReadingIndicatorGroup(assistantIdentity);
          }

          if (item.kind === "stream") {
            return renderStreamingGroup(
              item.text,
              item.startedAt,
              props.onOpenSidebar,
              assistantIdentity,
            );
          }

          if (item.kind === "group") {
            return renderMessageGroup(item, {
              onOpenSidebar: props.onOpenSidebar,
              showReasoning,
              assistantName: props.assistantName,
              assistantAvatar: assistantIdentity.avatar,
            });
          }

          return nothing;
        },
      )}
    </div>
  `;

  return html`
    <section class="card chat">
      ${props.disabledReason ? html`<div class="callout">${props.disabledReason}</div>` : nothing}

      ${props.error ? html`<div class="callout danger">${props.error}</div>` : nothing}

      ${
        props.focusMode
          ? html`
            <button
              class="chat-focus-exit"
              type="button"
              @click=${props.onToggleFocusMode}
              aria-label="Exit focus mode"
              title="Exit focus mode"
            >
              ${icons.x}
            </button>
          `
          : nothing
      }

      ${renderSessionTabs(props)}

      <div
        class="chat-split-container ${sidebarOpen ? "chat-split-container--open" : ""}"
      >
        <div
          class="chat-main"
          style="flex: ${sidebarOpen ? `0 0 ${splitRatio * 100}%` : "1 1 100%"}"
        >
          ${thread}
        </div>

        ${
          sidebarOpen
            ? html`
              <resizable-divider
                .splitRatio=${splitRatio}
                @resize=${(e: CustomEvent) => props.onSplitRatioChange?.(e.detail.splitRatio)}
              ></resizable-divider>
              <div class="chat-sidebar">
                ${renderMarkdownSidebar({
                  content: props.sidebarContent ?? null,
                  error: props.sidebarError ?? null,
                  onClose: props.onCloseSidebar!,
                  onViewRawText: () => {
                    if (!props.sidebarContent || !props.onOpenSidebar) {
                      return;
                    }
                    props.onOpenSidebar(`\`\`\`\n${props.sidebarContent}\n\`\`\``);
                  },
                })}
              </div>
            `
            : nothing
        }
      </div>

      ${renderCompactionIndicator(props.compactionStatus)}

      ${
        props.showNewMessages
          ? html`
            <button
              class="btn chat-new-messages"
              type="button"
              @click=${props.onScrollToBottom}
            >
              New messages ${icons.arrowDown}
            </button>
          `
          : nothing
      }

      ${
        props.queue.length
          ? html`
            <div class="chat-queue-tab" @click=${() => {
              queueExpanded = !queueExpanded;
            }}>
              <span>Queued (${props.queue.length})</span>
              <span class="icon-sm" style="width:10px;height:10px;${queueExpanded ? '' : 'transform:rotate(180deg)'}">${icons.arrowDown}</span>
            </div>
            ${
              queueExpanded
                ? html`
                  <div class="chat-queue-panel">
                    ${props.queue.map(
                      (item) => html`
                        <div class="chat-queue-item">
                          <div class="chat-queue-text mono">
                            ${item.text || (item.attachments?.length ? `Image (${item.attachments.length})` : "")}
                          </div>
                          <button
                            class="btn btn--sm"
                            @click=${() => props.onQueueRemove(item.id)}
                          >
                            <span class="icon-sm" style="width:10px;height:10px;">${icons.x}</span>
                          </button>
                        </div>
                      `,
                    )}
                  </div>
                `
                : nothing
            }
          `
          : nothing
      }

      <div class="chat-compose">
        ${renderAttachmentPreview(props)}
        <div class="chat-compose__row">
          <label class="field chat-compose__field">
            <span>Message</span>
            <textarea
              ${ref((el) => {
                if (el) {
                  adjustTextareaHeight(el as HTMLTextAreaElement);
                  (el as any)._textareaRef = el;
                }
              })}
              .value=${props.draft}
              dir=${detectTextDirection(props.draft)}
              ?disabled=${!props.connected}
              @keydown=${(e: KeyboardEvent) => {
                const target = e.target as HTMLTextAreaElement;

                // Tab completion for autosuggest
                if (e.key === "Tab" && (showSlashMenu || showAtMenu)) {
                  e.preventDefault();
                  const firstSuggestion = showSlashMenu
                    ? SLASH_COMMANDS.filter((cmd) =>
                        cmd.cmd.toLowerCase().includes(menuFilter.toLowerCase()),
                      )[0]
                    : null;
                  if (firstSuggestion && showSlashMenu) {
                    props.onDraftChange(firstSuggestion.cmd + " ");
                    showSlashMenu = false;
                    menuFilter = "";
                  }
                  return;
                }

                // Escape closes menu
                if (e.key === "Escape" && (showSlashMenu || showAtMenu)) {
                  showSlashMenu = false;
                  showAtMenu = false;
                  menuFilter = "";
                  return;
                }

                if (e.key !== "Enter") {
                  return;
                }
                if (e.isComposing || e.keyCode === 229) {
                  return;
                }
                if (e.shiftKey) {
                  return;
                } // Allow Shift+Enter for line breaks
                if (!props.connected) {
                  return;
                }
                e.preventDefault();
                if (canCompose) {
                  props.onSend();
                }
              }}
              @input=${(e: Event) => {
                const target = e.target as HTMLTextAreaElement;
                adjustTextareaHeight(target);
                const newValue = target.value;
                props.onDraftChange(newValue);

                // Detect slash command
                if (newValue.startsWith("/")) {
                  showSlashMenu = true;
                  showAtMenu = false;
                  menuFilter = newValue.substring(1);
                } else {
                  showSlashMenu = false;
                }

                // Detect @ mention
                const cursorPos = target.selectionStart;
                const textBeforeCursor = newValue.substring(0, cursorPos);
                const lastAtIndex = textBeforeCursor.lastIndexOf("@");

                if (lastAtIndex !== -1) {
                  const afterAt = textBeforeCursor.substring(lastAtIndex + 1);
                  if (!afterAt.includes(" ")) {
                    showAtMenu = true;
                    showSlashMenu = false;
                    menuFilter = afterAt;
                  } else {
                    showAtMenu = false;
                  }
                } else {
                  showAtMenu = false;
                }
              }}
              @paste=${(e: ClipboardEvent) => handlePaste(e, props)}
              placeholder=${composePlaceholder}
            ></textarea>
            ${renderAutosuggestMenu(props, document.querySelector(".chat-compose__field textarea") as HTMLTextAreaElement)}
          </label>
          <div class="chat-compose__actions">
            <button
              class="btn primary"
              ?disabled=${!props.connected}
              @click=${props.onSend}
            >
              ${isBusy ? "Queue" : "Send"}<kbd class="btn-kbd">↵</kbd>
            </button>
            <button
              class="btn"
              ?disabled=${!props.connected || (!canAbort && props.sending)}
              @click=${canAbort ? props.onAbort : props.onNewSession}
            >
              ${canAbort ? "Stop" : "New session"}
            </button>
          </div>
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
      if (currentGroup) {
        result.push(currentGroup);
      }
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

  if (currentGroup) {
    result.push(currentGroup);
  }
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
    const msg = history[i];
    const normalized = normalizeMessage(msg);
    const raw = msg as Record<string, unknown>;
    const marker = raw.__openclaw as Record<string, unknown> | undefined;
    if (marker && marker.kind === "compaction") {
      items.push({
        kind: "divider",
        key:
          typeof marker.id === "string"
            ? `divider:compaction:${marker.id}`
            : `divider:compaction:${normalized.timestamp}:${i}`,
        label: "COMPACTION",
        timestamp: normalized.timestamp ?? Date.now(),
      });
      continue;
    }

    // Detect system events and render as dividers
    const systemDividerLabel = detectSystemDivider(normalized);
    if (systemDividerLabel) {
      items.push({
        kind: "divider",
        key: `divider:system:${normalized.timestamp}:${i}`,
        label: systemDividerLabel,
        timestamp: normalized.timestamp ?? Date.now(),
      });
      continue;
    }

    if (!props.showThinking && normalized.role.toLowerCase() === "toolresult") {
      continue;
    }

    items.push({
      kind: "message",
      key: messageKey(msg, i),
      message: msg,
    });
  }
  if (props.showThinking) {
    for (let i = 0; i < tools.length; i++) {
      items.push({
        kind: "message",
        key: messageKey(tools[i], i + history.length),
        message: tools[i],
      });
    }
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

  return groupMessages(items);
}

function messageKey(message: unknown, index: number): string {
  const m = message as Record<string, unknown>;
  const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
  if (toolCallId) {
    return `tool:${toolCallId}`;
  }
  const id = typeof m.id === "string" ? m.id : "";
  if (id) {
    return `msg:${id}`;
  }
  const messageId = typeof m.messageId === "string" ? m.messageId : "";
  if (messageId) {
    return `msg:${messageId}`;
  }
  const timestamp = typeof m.timestamp === "number" ? m.timestamp : null;
  const role = typeof m.role === "string" ? m.role : "unknown";
  if (timestamp != null) {
    return `msg:${role}:${timestamp}:${index}`;
  }
  return `msg:${role}:${index}`;
}
