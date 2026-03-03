import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import {
  renderMessageGroup,
  renderReadingIndicatorGroup,
  renderStreamingGroup,
} from "../chat/grouped-render.ts";
import { extractTextCached } from "../chat/message-extract.ts";
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
  onSecurityApprove?: (passphrase?: string) => void;
  onSecurityDeny?: () => void;
  securityApprovalPassphrase?: string;
  onSecurityApprovalPassphraseChange?: (value: string) => void;
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
  const pendingSecurityApproval = resolvePendingSecurityApproval(
    props.messages,
    props.toolMessages,
  );
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
                          item.suppressLocalEcho
                            ? "Security approval action"
                            : item.text ||
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
        ${
          pendingSecurityApproval && props.onSecurityApprove && props.onSecurityDeny
            ? html`
                <div class="chat-approval-strip" role="status" aria-live="polite">
                  <span class="chat-approval-strip__label">Approval needed</span>
                  <span class="chat-approval-strip__detail">${pendingSecurityApproval.summary}</span>
                  ${
                    pendingSecurityApproval.requiresPassphrase &&
                    props.onSecurityApprovalPassphraseChange
                      ? html`
                          <input
                            class="chat-approval-strip__secret"
                            type="password"
                            autocomplete="off"
                            spellcheck="false"
                            placeholder="Passphrase"
                            .value=${props.securityApprovalPassphrase ?? ""}
                            @input=${(event: Event) =>
                              props.onSecurityApprovalPassphraseChange?.(
                                (event.target as HTMLInputElement).value,
                              )}
                          />
                        `
                      : nothing
                  }
                  <button
                    class="btn chat-approval-strip__btn"
                    type="button"
                    ?disabled=${
                      pendingSecurityApproval.requiresPassphrase &&
                      !(props.securityApprovalPassphrase ?? "").trim()
                    }
                    @click=${() =>
                      props.onSecurityApprove?.(
                        pendingSecurityApproval.requiresPassphrase
                          ? (props.securityApprovalPassphrase ?? "").trim()
                          : undefined,
                      )}
                  >
                    Approve
                  </button>
                  <button
                    class="btn chat-approval-strip__btn chat-approval-strip__btn--deny"
                    type="button"
                    @click=${props.onSecurityDeny}
                  >
                    Do not approve
                  </button>
                </div>
              `
            : nothing
        }
        ${renderAttachmentPreview(props)}
        <div class="chat-compose__row">
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

type PendingSecurityApproval = {
  summary: string;
  requiresPassphrase: boolean;
};

const SECURITY_APPROVAL_STALE_MS = 15 * 60 * 1000;

function resolvePendingSecurityApproval(
  messages: unknown[],
  toolMessages: unknown[],
): PendingSecurityApproval | null {
  const history = Array.isArray(messages) ? messages : [];
  const tools = Array.isArray(toolMessages) ? toolMessages : [];
  const fallbackBase = resolveFallbackOrderBase(history, tools);
  const requests: Array<{ order: number; requiresPassphrase: boolean }> = [];
  let latestRequestOrder = -1;
  let latestRequestEpochMs: number | null = null;
  let latestResolutionOrder = -1;
  let latestUserOrder = -1;
  let latestActionUserOrder = -1;
  let fallbackOrder = fallbackBase;

  const noteRequest = (text: string, order: number, epochMs: number | null) => {
    if (order < latestRequestOrder) {
      return;
    }
    latestRequestOrder = order;
    latestRequestEpochMs = epochMs;
    requests.push({
      order,
      requiresPassphrase: /securitysentinelpassphrase|passphrase/i.test(text),
    });
  };

  for (const raw of history) {
    if (!raw || typeof raw !== "object") {
      fallbackOrder += 1;
      continue;
    }
    const msg = raw as Record<string, unknown>;
    const role = normalizeRoleForGrouping(typeof msg.role === "string" ? msg.role : "other");
    const order = fallbackOrder;
    const epochMs = resolveMessageEpochMs(msg);
    fallbackOrder += 1;
    if (role === "user") {
      latestUserOrder = Math.max(latestUserOrder, order);
    }
    const text = extractSecurityText(msg);
    if (role === "user") {
      const isApprovalResolution = text ? isSecurityApprovalResolution(text) : false;
      if (!isApprovalResolution) {
        latestActionUserOrder = Math.max(latestActionUserOrder, order);
      }
    }
    if (!text) {
      continue;
    }
    if (role === "assistant") {
      const isPrompt = isSecurityApprovalPrompt(text);
      const isSignal = isSecuritySentinelSignal(text);
      const isDenyAck = isSecurityApprovalDenyAcknowledgement(text);
      if (isPrompt) {
        noteRequest(text, order, epochMs);
      }
      if (isSignal) {
        noteRequest(text, order, epochMs);
      }
      if (!isPrompt && !isSignal && isDenyAck) {
        const hasFreshOperatorAction =
          latestActionUserOrder > Math.max(latestResolutionOrder, latestRequestOrder);
        if (hasFreshOperatorAction) {
          noteRequest(text, order, epochMs);
        } else {
          latestResolutionOrder = Math.max(latestResolutionOrder, order);
        }
        continue;
      }
      if (!isPrompt && !isSignal && isSecurityApprovalResolution(text)) {
        latestResolutionOrder = Math.max(latestResolutionOrder, order);
      }
      continue;
    }
    if (isSecurityApprovalResolution(text)) {
      latestResolutionOrder = Math.max(latestResolutionOrder, order);
    }
  }

  for (const raw of tools) {
    if (!raw || typeof raw !== "object") {
      fallbackOrder += 1;
      continue;
    }
    const msg = raw as Record<string, unknown>;
    const text = extractSecurityText(msg);
    const order = fallbackOrder;
    const epochMs = resolveMessageEpochMs(msg);
    fallbackOrder += 1;
    if (!text) {
      continue;
    }
    if (isSecurityApprovalResolution(text)) {
      latestResolutionOrder = Math.max(latestResolutionOrder, order);
      continue;
    }
    if (isSecurityApprovalPrompt(text)) {
      noteRequest(text, order, epochMs);
    }
    if (isSecuritySentinelSignal(text)) {
      noteRequest(text, order, epochMs);
    }
  }

  if (
    latestRequestEpochMs !== null &&
    Date.now() - latestRequestEpochMs > SECURITY_APPROVAL_STALE_MS
  ) {
    return null;
  }
  if (
    latestRequestOrder >= 0 &&
    latestResolutionOrder < latestRequestOrder &&
    latestUserOrder <= latestRequestOrder
  ) {
    const unresolvedCutoff = Math.max(latestResolutionOrder, latestUserOrder);
    const unresolvedRequests = requests.filter((entry) => entry.order > unresolvedCutoff);
    const requiresPassphrase = unresolvedRequests.some((entry) => entry.requiresPassphrase);
    return {
      summary: requiresPassphrase
        ? "Access denied: approval and passphrase required"
        : "Access denied: approval required",
      requiresPassphrase,
    };
  }
  return null;
}

function resolveMessageEpochMs(message: Record<string, unknown>): number | null {
  const timestamp = message.timestamp;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }
  return normalizeEpochMs(timestamp);
}

function resolveFallbackOrderBase(messages: unknown[], toolMessages: unknown[]): number {
  const candidates: number[] = [];
  for (const list of [messages, toolMessages]) {
    if (!Array.isArray(list)) {
      continue;
    }
    for (const raw of list) {
      if (!raw || typeof raw !== "object") {
        continue;
      }
      const ts = (raw as Record<string, unknown>).timestamp;
      if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) {
        continue;
      }
      if (ts >= 1e12 && ts < 1e14) {
        candidates.push(ts);
      } else if (ts >= 1e9 && ts < 1e11) {
        candidates.push(ts * 1000);
      }
    }
  }
  if (candidates.length === 0) {
    return Date.now();
  }
  return Math.max(...candidates);
}

function normalizeEpochMs(value: number): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  if (value >= 1e12 && value < 1e14) {
    return value;
  }
  if (value >= 1e9 && value < 1e11) {
    return value * 1000;
  }
  return null;
}

function extractSecurityText(message: Record<string, unknown>): string {
  const direct = (extractTextCached(message) ?? "").trim();
  if (direct) {
    return direct;
  }
  const parts = collectSecurityTextParts(message);
  return parts.join("\n").trim();
}

function collectSecurityTextParts(value: unknown, depth = 0): string[] {
  if (depth > 3 || value === null || value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectSecurityTextParts(entry, depth + 1));
  }
  if (typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const fields = [
    "text",
    "content",
    "message",
    "reason",
    "summary",
    "error",
    "detail",
    "output",
    "result",
    "response",
    "value",
    "body",
  ];
  const parts = fields.flatMap((field) => collectSecurityTextParts(record[field], depth + 1));

  // Fallback for non-standard tool payloads where sentinel signals are nested in objects.
  if (
    parts.length === 0 &&
    (Object.hasOwn(record, "securitySentinelApproved") ||
      Object.hasOwn(record, "blocked") ||
      Object.hasOwn(record, "tamper_type"))
  ) {
    try {
      return [JSON.stringify(record)];
    } catch {
      return [];
    }
  }
  return parts;
}

function isSecuritySentinelSignal(text: string): boolean {
  if (!text) {
    return false;
  }
  return (
    /security sentinel blocked tool call/i.test(text) ||
    /explicit operator approval required/i.test(text) ||
    /tamper[_\s-]?type\s*[:=]/i.test(text)
  );
}

function isSecurityApprovalPrompt(text: string): boolean {
  if (!text) {
    return false;
  }
  return (
    /access denied/i.test(text) ||
    /security alert/i.test(text) ||
    /approval required/i.test(text) ||
    /requires securitysentinelpassphrase/i.test(text) ||
    /fill (the )?securitysentinelpassphrase/i.test(text) ||
    /provide securitysentinelpassphrase/i.test(text) ||
    /securitysentinelpassphrase/i.test(text) ||
    /passphrase credential/i.test(text) ||
    /need your explicit approval/i.test(text) ||
    /explicit permission/i.test(text) ||
    /explicit operator approval/i.test(text) ||
    /enable approval in the ui/i.test(text) ||
    /approval ui controls/i.test(text) ||
    /use the approval ui/i.test(text) ||
    /turn approval (back )?on/i.test(text) ||
    /re-approve/i.test(text) ||
    /reapprove/i.test(text) ||
    /can[’']?t run that right now/i.test(text) ||
    /cannot run that right now/i.test(text) ||
    /do you approve/i.test(text) ||
    /would you like to approve/i.test(text) ||
    /would you like to allow this action/i.test(text)
  );
}

function isSecurityApprovalResolution(text: string): boolean {
  if (!text) {
    return false;
  }
  const normalized = text.trim().toLowerCase();
  if (
    /^securitysentinelapproved\s*=\s*(true|false)(\s+securitysentinelpassphrase\s*=\s*\S+)?$/i.test(
      normalized,
    )
  ) {
    return true;
  }
  if (/^(yes|y|approve|approved|i approve|allow|deny|no|n|do not approve)$/i.test(normalized)) {
    return true;
  }
  return false;
}

function isSecurityApprovalDenyAcknowledgement(text: string): boolean {
  if (!text) {
    return false;
  }
  return (
    /approval is currently off/i.test(text) ||
    /won[’']?t run any approval-gated actions unless you re-approve/i.test(text)
  );
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
