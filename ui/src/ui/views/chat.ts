import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import {
  renderMessageGroup,
  renderReadingIndicatorGroup,
  renderStreamingGroup,
} from "../chat/grouped-render.ts";
import { normalizeMessage, normalizeRoleForGrouping } from "../chat/message-normalizer.ts";
import { icons } from "../icons.ts";
import { detectTextDirection } from "../text-direction.ts";
import type { SessionsListResult } from "../types.ts";
import type { ChatItem, MessageGroup } from "../types/chat-types.ts";
import type { ChatAttachment, ChatQueueItem } from "../ui-types.ts";
import { renderMarkdownSidebar } from "./markdown-sidebar.ts";
import "../components/resizable-divider.ts";

export type CompactionIndicatorStatus = {
  active: boolean;
  startedAt: number | null;
  completedAt: number | null;
};

export type FallbackIndicatorStatus = {
  phase?: "active" | "cleared";
  selected: string;
  active: string;
  previous?: string;
  reason?: string;
  attempts: string[];
  occurredAt: number;
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
  fallbackStatus?: FallbackIndicatorStatus | null;
  messages: unknown[];
  toolMessages: unknown[];
  streamSegments: Array<{ text: string; ts: number }>;
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
const FALLBACK_TOAST_DURATION_MS = 8000;

function adjustTextareaHeight(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
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

function renderFallbackIndicator(status: FallbackIndicatorStatus | null | undefined) {
  if (!status) {
    return nothing;
  }
  const phase = status.phase ?? "active";
  const elapsed = Date.now() - status.occurredAt;
  if (elapsed >= FALLBACK_TOAST_DURATION_MS) {
    return nothing;
  }
  const details = [
    `Selected: ${status.selected}`,
    phase === "cleared" ? `Active: ${status.selected}` : `Active: ${status.active}`,
    phase === "cleared" && status.previous ? `Previous fallback: ${status.previous}` : null,
    status.reason ? `Reason: ${status.reason}` : null,
    status.attempts.length > 0 ? `Attempts: ${status.attempts.slice(0, 3).join(" | ")}` : null,
  ]
    .filter(Boolean)
    .join(" • ");
  const message =
    phase === "cleared"
      ? `Fallback cleared: ${status.selected}`
      : `Fallback active: ${status.active}`;
  const className =
    phase === "cleared"
      ? "compaction-indicator compaction-indicator--fallback-cleared"
      : "compaction-indicator compaction-indicator--fallback";
  const icon = phase === "cleared" ? icons.check : icons.brain;
  return html`
    <div
      class=${className}
      role="status"
      aria-live="polite"
      title=${details}
    >
      ${icon} ${message}
    </div>
  `;
}

function generateAttachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Read a single File into a ChatAttachment via FileReader. */
function readFileAsAttachment(file: File): Promise<ChatAttachment | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve({
        id: generateAttachmentId(),
        dataUrl: reader.result as string,
        mimeType: file.type,
      });
    });
    // Resolve null on error/abort so Promise.all always settles
    // and a single bad file doesn't block the entire batch.
    reader.addEventListener("error", () => resolve(null));
    reader.addEventListener("abort", () => resolve(null));
    reader.readAsDataURL(file);
  });
}

// NOTE: Singleton module-level state — assumes exactly one renderChat() call per document.
// This is true for the current app (app-render.ts calls renderChat once).
// If renderChat is ever called multiple times in the same document (multi-session panel,
// test harness, docs embed), these vars must be refactored into a per-instance closure or
// factory to avoid cross-instance state clobbering.
//
// Mutable refs to the latest attachments state, updated on every render.
// Async callbacks read from these refs instead of stale props closures.
let latestAttachments: ChatAttachment[] = [];
let latestOnAttachmentsChange: ((attachments: ChatAttachment[]) => void) | undefined;

// Accumulator for concurrent async batches. When multiple addFilesAsAttachments
// calls resolve before a render (e.g. rapid paste + drop), their results collect
// here and are flushed together in a single microtask, preventing one batch from
// overwriting another's files.
let pendingAttachments: ChatAttachment[] = [];
let flushScheduled = false;
let lastSessionKey: string | undefined;

function flushPendingAttachments() {
  flushScheduled = false;
  if (pendingAttachments.length === 0 || !latestOnAttachmentsChange) {
    return;
  }
  const toAdd = pendingAttachments;
  pendingAttachments = [];
  const merged = [...latestAttachments, ...toAdd];
  // Update the module-level ref immediately so that if another batch
  // flushes before Lit re-renders, it sees the combined state — not
  // the stale pre-flush snapshot.
  latestAttachments = merged;
  latestOnAttachmentsChange(merged);
}

/**
 * Batch-read files and append via accumulator to avoid race conditions.
 * Multiple concurrent calls (rapid paste + drop) collect into pendingAttachments
 * and flush together in a single microtask, ensuring no batch overwrites another.
 *
 * The originating `sessionKey` is captured at call time. If the user switches
 * sessions before the reads complete, the resolved batch is discarded to prevent
 * cross-session attachment leakage.
 */
function addFilesAsAttachments(files: File[], sessionKey: string) {
  if (!latestOnAttachmentsChange || files.length === 0) {
    return;
  }
  void Promise.all(files.map(readFileAsAttachment)).then((results) => {
    // Drop batch if the session changed while reads were in-flight
    if (sessionKey !== lastSessionKey) {
      return;
    }
    const newAttachments = results.filter((att): att is ChatAttachment => att !== null);
    if (newAttachments.length === 0) {
      return;
    }
    pendingAttachments.push(...newAttachments);
    if (!flushScheduled) {
      flushScheduled = true;
      queueMicrotask(flushPendingAttachments);
    }
  });
}

function handlePaste(e: ClipboardEvent, props: ChatProps) {
  const items = e.clipboardData?.items;
  if (!items || !props.onAttachmentsChange || !props.connected) {
    return;
  }

  const files: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        files.push(file);
      }
    }
  }

  if (files.length === 0) {
    return;
  }

  e.preventDefault();
  addFilesAsAttachments(files, props.sessionKey);
}

/** Handle file input change (from attach or camera buttons). */
function handleFileInput(e: Event, props: ChatProps) {
  const input = e.target as HTMLInputElement;
  const fileList = input.files;
  // Guard against disconnected state: the picker can open while connected but
  // the gateway may disconnect before the change event fires. Mirror the same
  // check applied to handleDrop/handleDragOver so that disabled compose state
  // is consistently enforced across all attachment input paths.
  if (!fileList || !props.onAttachmentsChange || !props.connected) {
    input.value = "";
    return;
  }
  // Filter to image/* even though the input has accept="image/*",
  // as some browsers may allow non-image files through the picker.
  const files: File[] = [];
  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    if (file && file.type.startsWith("image/")) {
      files.push(file);
    }
  }
  addFilesAsAttachments(files, props.sessionKey);
  // Reset so re-selecting the same file triggers change again
  input.value = "";
}

/** Handle drag-and-drop of files onto the chat area. */
function handleDrop(e: DragEvent, props: ChatProps) {
  const target = e.currentTarget as HTMLElement;
  target.classList.remove("chat--drag-over");

  // Check types first (same gate as handleDragOver) so we cancel the drop
  // event for ALL file drags — including cross-origin ones where browsers
  // restrict files[] to an empty list for security. Without this, handleDragOver
  // would have called preventDefault() (promising to handle the drop), but this
  // handler wouldn't cancel it, letting the browser navigate away.
  const hasFiles = e.dataTransfer?.types?.includes("Files") ?? false;
  if (!hasFiles) {
    return; // Not a file drag — let native behavior handle it
  }

  // Always cancel file drops to prevent the browser from navigating away
  // (its default action for dropped files). We filter to images below.
  e.preventDefault();
  e.stopPropagation();

  const fileList = e.dataTransfer?.files;
  if (!fileList || fileList.length === 0) {
    return; // Cross-origin drop or empty file list — cancelled but nothing to process
  }

  if (!props.onAttachmentsChange || !props.connected) {
    return;
  }
  const files: File[] = [];
  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    if (file && file.type.startsWith("image/")) {
      files.push(file);
    }
  }
  if (files.length > 0) {
    addFilesAsAttachments(files, props.sessionKey);
  }
}

function handleDragOver(e: DragEvent, props: ChatProps) {
  const hasFiles = e.dataTransfer?.types?.includes("Files") ?? false;
  if (!hasFiles) {
    return;
  }
  // ALWAYS prevent browser file-navigation for file drags,
  // even when disconnected. Only show the overlay when connected.
  e.preventDefault();
  e.stopPropagation();
  if (!props.connected) {
    return;
  }
  const target = e.currentTarget as HTMLElement;
  target.classList.add("chat--drag-over");
}

function handleDragLeave(e: DragEvent) {
  const hasFiles = e.dataTransfer?.types?.includes("Files") ?? false;
  if (!hasFiles) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  const target = e.currentTarget as HTMLElement;
  // Only remove overlay if leaving the container entirely, not child elements
  if (!target.contains(e.relatedTarget as Node)) {
    target.classList.remove("chat--drag-over");
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
  // Update mutable refs so async attachment callbacks always read latest state
  latestAttachments = props.attachments ?? [];
  latestOnAttachmentsChange = props.onAttachmentsChange;

  // Reset accumulator state when session changes to prevent cross-session injection
  if (props.sessionKey !== lastSessionKey) {
    pendingAttachments = [];
    flushScheduled = false;
    lastSessionKey = props.sessionKey;
  }

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
    <section
      class="card chat"
      @drop=${(e: DragEvent) => handleDrop(e, props)}
      @dragover=${(e: DragEvent) => handleDragOver(e, props)}
      @dragleave=${handleDragLeave}
    >
      <div class="chat-drop-overlay" aria-hidden="true">
        <div class="chat-drop-overlay__content">
          ${icons.image}
          <span>Drop images here</span>
        </div>
      </div>

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

      ${
        props.queue.length
          ? html`
            <div class="chat-queue" role="status" aria-live="polite">
              <div class="chat-queue__title">Queued (${props.queue.length})</div>
              <div class="chat-queue__list">
                ${props.queue.map(
                  (item) => html`
                    <div class="chat-queue__item">
                      <div class="chat-queue__text">
                        ${
                          item.text ||
                          (item.attachments?.length ? `Image (${item.attachments.length})` : "")
                        }
                      </div>
                      <button
                        class="btn chat-queue__remove"
                        type="button"
                        aria-label="Remove queued message"
                        @click=${() => props.onQueueRemove(item.id)}
                      >
                        ${icons.x}
                      </button>
                    </div>
                  `,
                )}
              </div>
            </div>
          `
          : nothing
      }

      ${renderFallbackIndicator(props.fallbackStatus)}
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

      <div class="chat-compose">
        ${renderAttachmentPreview(props)}
        <div class="chat-compose__row">
          <!-- Hidden file inputs (no global IDs or module-level refs; buttons query their own row) -->
          <input
            type="file"
            accept="image/*"
            multiple
            class="chat-compose__file-input"
            @change=${(e: Event) => handleFileInput(e, props)}
          />
          <input
            type="file"
            accept="image/*"
            capture="environment"
            class="chat-compose__file-input"
            @change=${(e: Event) => handleFileInput(e, props)}
          />

          <div class="chat-compose__attach-buttons">
            <button
              class="btn btn--icon chat-compose__attach-btn"
              type="button"
              title="Attach image"
              aria-label="Attach image"
              ?disabled=${!props.connected}
              @click=${(e: MouseEvent) => {
                const row = (e.currentTarget as HTMLElement).closest(".chat-compose__row");
                (
                  row?.querySelector(
                    ".chat-compose__file-input:not([capture])",
                  ) as HTMLInputElement | null
                )?.click();
              }}
            >
              ${icons.paperclip}
            </button>
            <button
              class="btn btn--icon chat-compose__camera-btn"
              type="button"
              title="Take photo"
              aria-label="Take photo"
              ?disabled=${!props.connected}
              @click=${(e: MouseEvent) => {
                const row = (e.currentTarget as HTMLElement).closest(".chat-compose__row");
                (
                  row?.querySelector(
                    ".chat-compose__file-input[capture]",
                  ) as HTMLInputElement | null
                )?.click();
              }}
            >
              ${icons.camera}
            </button>
          </div>

          <label class="field chat-compose__field">
            <span>Message</span>
            <textarea
              ${ref((el) => el && adjustTextareaHeight(el as HTMLTextAreaElement))}
              .value=${props.draft}
              dir=${detectTextDirection(props.draft)}
              ?disabled=${!props.connected}
              @keydown=${(e: KeyboardEvent) => {
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
                props.onDraftChange(target.value);
              }}
              @paste=${(e: ClipboardEvent) => handlePaste(e, props)}
              placeholder=${composePlaceholder}
            ></textarea>
          </label>
          <div class="chat-compose__actions">
            <button
              class="btn"
              ?disabled=${!props.connected || (!canAbort && props.sending)}
              @click=${canAbort ? props.onAbort : props.onNewSession}
            >
              ${canAbort ? "Stop" : "New session"}
            </button>
            <button
              class="btn primary"
              ?disabled=${!props.connected}
              @click=${props.onSend}
            >
              ${isBusy ? "Queue" : "Send"}<kbd class="btn-kbd">↵</kbd>
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
    const senderLabel = role.toLowerCase() === "user" ? (normalized.senderLabel ?? null) : null;
    const timestamp = normalized.timestamp || Date.now();

    if (
      !currentGroup ||
      currentGroup.role !== role ||
      (role.toLowerCase() === "user" && currentGroup.senderLabel !== senderLabel)
    ) {
      if (currentGroup) {
        result.push(currentGroup);
      }
      currentGroup = {
        kind: "group",
        key: `group:${role}:${item.key}`,
        role,
        senderLabel,
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
        label: "Compaction",
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
  // Interleave stream segments and tool cards in order. Each segment
  // contains text that was streaming before the corresponding tool started.
  // This ensures correct visual ordering: text → tool → text → tool → ...
  const segments = props.streamSegments ?? [];
  const maxLen = Math.max(segments.length, tools.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < segments.length && segments[i].text.trim().length > 0) {
      items.push({
        kind: "stream" as const,
        key: `stream-seg:${props.sessionKey}:${i}`,
        text: segments[i].text,
        startedAt: segments[i].ts,
      });
    }
    if (i < tools.length) {
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
