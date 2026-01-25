import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { SessionsListResult } from "../types";
import type { ChatQueueItem } from "../ui-types";
import type { ChatItem, MessageGroup } from "../types/chat-types";
import type { ChatTask, ChatActivityLog } from "../types/task-types";
import type { TtsProviderId, TtsProviderInfo } from "../controllers/tts";
import {
  normalizeMessage,
  normalizeRoleForGrouping,
} from "../chat/message-normalizer";
import { extractText } from "../chat/message-extract";
import {
  renderMessageGroup,
  renderReadingIndicatorGroup,
  renderStreamingGroup,
} from "../chat/grouped-render";
import { renderMarkdownSidebar } from "./markdown-sidebar";
import { renderChatTaskSidebar } from "./chat-task-sidebar";
import { icon } from "../icons";
import "../components/resizable-divider";

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
  audioInputSupported: boolean;
  audioRecording: boolean;
  audioInputError: string | null;
  readAloudSupported: boolean;
  readAloudActive: boolean;
  readAloudError: string | null;
  ttsLoading: boolean;
  ttsError: string | null;
  ttsProviders: TtsProviderInfo[];
  ttsActiveProvider: TtsProviderId | null;
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
  // Event handlers
  onRefresh: () => void;
  onToggleFocusMode: () => void;
  onDraftChange: (next: string) => void;
  onSend: () => void;
  onAbort?: () => void;
  onToggleAudioRecording: () => void;
  onReadAloud: (text?: string | null) => void;
  onTtsProviderChange: (provider: TtsProviderId) => void;
  onQueueRemove: (id: string) => void;
  onNewSession: () => void;
  onOpenSidebar?: (content: string) => void;
  onCloseSidebar?: () => void;
  onSplitRatioChange?: (ratio: number) => void;
  onChatScroll?: (event: Event) => void;
  // Task sidebar props
  taskSidebarOpen?: boolean;
  tasks?: ChatTask[];
  activityLog?: ChatActivityLog[];
  expandedTaskIds?: Set<string>;
  taskCount?: number;
  onOpenTaskSidebar?: () => void;
  onCloseTaskSidebar?: () => void;
  onToggleTaskExpanded?: (taskId: string) => void;
};

const COMPACTION_TOAST_DURATION_MS = 5000;

/**
 * Render skeleton loading state for chat messages
 */
function renderChatSkeleton() {
  return html`
    <div class="chat-skeleton" aria-busy="true" aria-label="Loading chat history">
      <!-- User message skeleton -->
      <div class="chat-skeleton__bubble chat-skeleton__bubble--user">
        <div class="chat-skeleton__avatar skeleton skeleton--circle"></div>
        <div class="chat-skeleton__content">
          <div class="skeleton skeleton--text" style="width: 60%;"></div>
          <div class="skeleton skeleton--text" style="width: 40%;"></div>
        </div>
      </div>
      <!-- Assistant message skeleton -->
      <div class="chat-skeleton__bubble chat-skeleton__bubble--assistant">
        <div class="chat-skeleton__avatar skeleton skeleton--circle"></div>
        <div class="chat-skeleton__content">
          <div class="skeleton skeleton--text" style="width: 80%;"></div>
          <div class="skeleton skeleton--text" style="width: 70%;"></div>
          <div class="skeleton skeleton--text" style="width: 50%;"></div>
        </div>
      </div>
      <!-- Another user message skeleton -->
      <div class="chat-skeleton__bubble chat-skeleton__bubble--user">
        <div class="chat-skeleton__avatar skeleton skeleton--circle"></div>
        <div class="chat-skeleton__content">
          <div class="skeleton skeleton--text" style="width: 45%;"></div>
        </div>
      </div>
      <!-- Another assistant message skeleton -->
      <div class="chat-skeleton__bubble chat-skeleton__bubble--assistant">
        <div class="chat-skeleton__avatar skeleton skeleton--circle"></div>
        <div class="chat-skeleton__content">
          <div class="skeleton skeleton--text" style="width: 90%;"></div>
          <div class="skeleton skeleton--text" style="width: 75%;"></div>
        </div>
      </div>
    </div>
  `;
}

function renderCompactionIndicator(status: CompactionIndicatorStatus | null | undefined) {
  if (!status) return nothing;
  
  // Show "compacting..." while active
  if (status.active) {
    return html`
      <div class="callout info compaction-indicator compaction-indicator--active">
        🧹 Compacting context...
      </div>
    `;
  }
  
  // Show "compaction complete" briefly after completion
  if (status.completedAt) {
    const elapsed = Date.now() - status.completedAt;
    if (elapsed < COMPACTION_TOAST_DURATION_MS) {
      return html`
        <div class="callout success compaction-indicator compaction-indicator--complete">
          🧹 Context compacted
        </div>
      `;
    }
  }
  
  return nothing;
}

function resolveReadAloudText(props: ChatProps): string | null {
  for (let i = props.messages.length - 1; i >= 0; i -= 1) {
    const message = props.messages[i];
    const normalized = normalizeMessage(message);
    const role = normalizeRoleForGrouping(normalized.role);
    if (role !== "assistant") continue;
    const text = extractText(message)?.trim();
    if (text) return text;
  }
  return null;
}

function formatTtsProviderLabel(provider: TtsProviderInfo): string {
  const base = provider.id === "edge" ? "Local (Edge)" : provider.name;
  return provider.configured ? base : `${base} (not configured)`;
}

export function renderChat(props: ChatProps) {
  const canCompose = props.connected;
  const isBusy = props.sending || props.stream !== null;
  const canSend = props.canSend && !props.audioRecording;
  const canAbort = Boolean(props.canAbort && props.onAbort);
  const activeSession = props.sessions?.sessions?.find(
    (row) => row.key === props.sessionKey,
  );
  const reasoningLevel = activeSession?.reasoningLevel ?? "off";
  const showReasoning = props.showThinking && reasoningLevel !== "off";
  const assistantIdentity = {
    name: props.assistantName,
    avatar: props.assistantAvatar ?? props.assistantAvatarUrl ?? null,
  };

  const composePlaceholder = props.connected
    ? "Message (↩ to send, Shift+↩ for line breaks)"
    : "Connect to the gateway to start chatting…";

  const readAloudText = resolveReadAloudText(props);
  const canReadAloud = props.readAloudSupported && Boolean(readAloudText);
  const canRecordAudio = props.audioInputSupported && props.connected;
  const audioStatus = props.audioRecording
    ? "Listening…"
    : props.audioInputError
      ? props.audioInputError
      : null;
  const audioStatusClass = props.audioRecording
    ? "is-recording"
    : props.audioInputError
      ? "is-error"
      : "";
  const recordTitle = !props.audioInputSupported
    ? "Audio input is not supported in this browser"
    : !props.connected
      ? "Connect to start recording"
      : props.audioRecording
        ? "Stop recording"
        : "Record audio";
  const playTitle = !props.readAloudSupported
    ? "Read-aloud is not supported in this browser"
    : !readAloudText
      ? "No assistant reply to play yet"
      : "Play last reply";
  const ttsProviders = Array.isArray(props.ttsProviders) ? props.ttsProviders : [];
  const configuredTtsProviders = ttsProviders.filter((provider) => provider.configured);
  const hasServerTts = configuredTtsProviders.length > 0;
  const ttsSelectValue =
    props.ttsActiveProvider ??
    configuredTtsProviders[0]?.id ??
    ttsProviders[0]?.id ??
    "";
  const ttsSelectDisabled = !props.connected || props.ttsLoading || ttsProviders.length === 0;
  const ttsSelectTitle = !props.connected
    ? "Connect to select a server voice"
    : hasServerTts
      ? "Select server TTS provider"
      : "Configure a server TTS provider to enable server playback";
  const audioError = props.readAloudError ?? props.ttsError;

  const splitRatio = props.splitRatio ?? 0.6;
  const sidebarOpen = Boolean(props.sidebarOpen && props.onCloseSidebar);
  const thread = html`
    <div
      class="chat-thread"
      role="log"
      aria-live="polite"
      @scroll=${props.onChatScroll}
    >
      ${props.loading && props.messages.length === 0 ? renderChatSkeleton() : nothing}
      ${repeat(buildChatItems(props), (item) => item.key, (item) => {
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
      })}
    </div>
  `;

  return html`
    <section class="card chat">
      ${props.disabledReason
        ? html`<div class="callout">${props.disabledReason}</div>`
        : nothing}

      ${props.error
        ? html`<div class="callout danger">${props.error}</div>`
        : nothing}

      ${renderCompactionIndicator(props.compactionStatus)}

      ${props.focusMode
        ? html`
            <button
              class="chat-focus-exit"
              type="button"
              @click=${props.onToggleFocusMode}
              aria-label="Exit focus mode"
              title="Exit focus mode"
            >
              ${icon("x", { size: 16 })}
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
          ${thread}
        </div>

        ${sidebarOpen
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
                        ${icon("x", { size: 14 })}
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
              if (props.audioRecording) return;
              e.preventDefault();
              if (canCompose) props.onSend();
            }}
            @input=${(e: Event) =>
              props.onDraftChange((e.target as HTMLTextAreaElement).value)}
            placeholder=${composePlaceholder}
            ?readonly=${props.audioRecording}
          ></textarea>
        </label>
        <div class="chat-compose__actions">
          <div class="chat-compose__actions-group">
            <button
              class="chat-compose__record ${props.audioRecording ? "is-recording" : ""}"
              type="button"
              ?disabled=${!canRecordAudio}
              @click=${props.onToggleAudioRecording}
              title=${recordTitle}
              aria-pressed=${props.audioRecording}
            >
              ${icon(props.audioRecording ? "stop" : "mic", { size: 16 })}
              <span>${props.audioRecording ? "Stop" : "Record"}</span>
            </button>
            <button
              class="chat-compose__play ${props.readAloudActive ? "is-playing" : ""}"
              type="button"
              ?disabled=${!canReadAloud}
              @click=${() => props.onReadAloud(readAloudText)}
              title=${playTitle}
              aria-pressed=${props.readAloudActive}
            >
              ${icon(props.readAloudActive ? "pause" : "play", { size: 16 })}
              <span>${props.readAloudActive ? "Pause" : "Play"}</span>
            </button>
            ${ttsProviders.length
              ? html`
                  <label class="chat-compose__tts-select" title=${ttsSelectTitle}>
                    <span class="sr-only">TTS provider</span>
                    <select
                      .value=${ttsSelectValue}
                      ?disabled=${ttsSelectDisabled}
                      @change=${(e: Event) =>
                        props.onTtsProviderChange(
                          (e.target as HTMLSelectElement).value as TtsProviderId,
                        )}
                    >
                      ${ttsProviders.map(
                        (provider) => html`
                          <option value=${provider.id}>
                            ${formatTtsProviderLabel(provider)}
                          </option>
                        `,
                      )}
                    </select>
                  </label>
                `
              : nothing}
            ${audioStatus
              ? html`<div class="chat-compose__recording-pill ${audioStatusClass}">
                  ${audioStatus}
                </div>`
              : nothing}
            ${audioError
              ? html`<div class="chat-compose__audio-error">${audioError}</div>`
              : nothing}
          </div>
          <div class="chat-compose__actions-group chat-compose__actions-group--right">
            ${isBusy && canAbort
              ? html`
                  <button
                    class="chat-compose__abort"
                    type="button"
                    @click=${props.onAbort}
                  >
                    ${icon("stop", { size: 16 })}
                    <span>Stop</span>
                  </button>
                `
              : html`
                  <button
                    class="chat-compose__send"
                    type="button"
                    ?disabled=${!canSend || !props.draft.trim()}
                    @click=${props.onSend}
                  >
                    ${icon("send", { size: 16 })}
                    <span>${isBusy ? "Queue" : "Send"}</span>
                  </button>
                `}
            <button
              class="btn btn--secondary"
              type="button"
              @click=${props.onNewSession}
              title="New session"
            >
              ${icon("plus", { size: 16 })}
              <span>New</span>
            </button>
            ${props.onOpenTaskSidebar
              ? html`
                  <button
                    class="chat-task-toggle ${props.taskSidebarOpen ? "chat-task-toggle--active" : ""}"
                    type="button"
                    @click=${props.onOpenTaskSidebar}
                    title="View task breakdown"
                  >
                    ${icon("layers", { size: 16 })}
                    ${(props.taskCount ?? 0) > 0
                      ? html`<span class="chat-task-toggle__count">${props.taskCount}</span>`
                      : nothing}
                  </button>
                `
              : nothing}
          </div>
        </div>
      </div>
      ${props.taskSidebarOpen && props.onCloseTaskSidebar
        ? renderChatTaskSidebar({
            open: props.taskSidebarOpen,
            tasks: props.tasks ?? [],
            activityLog: props.activityLog ?? [],
            expandedIds: props.expandedTaskIds ?? new Set(),
            onClose: props.onCloseTaskSidebar,
            onToggleExpanded: (taskId) => props.onToggleTaskExpanded?.(taskId),
            onOpenToolOutput: props.onOpenSidebar,
          })
        : nothing}
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
    const msg = history[i];
    const normalized = normalizeMessage(msg);

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
  if (toolCallId) return `tool:${toolCallId}`;
  const id = typeof m.id === "string" ? m.id : "";
  if (id) return `msg:${id}`;
  const messageId = typeof m.messageId === "string" ? m.messageId : "";
  if (messageId) return `msg:${messageId}`;
  const timestamp = typeof m.timestamp === "number" ? m.timestamp : null;
  const role = typeof m.role === "string" ? m.role : "unknown";
  if (timestamp != null) return `msg:${role}:${timestamp}:${index}`;
  return `msg:${role}:${index}`;
}
