// Control UI view renders chat screen content.
import { html, nothing, type TemplateResult } from "lit";
import { guard } from "lit/directives/guard.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { formatApprovalDisplayPath } from "../../../../src/infra/approval-display-paths.ts";
import { t } from "../../i18n/index.ts";
import type { CompactionStatus, FallbackStatus } from "../app-tool-stream.ts";
import {
  getChatAttachmentPreviewUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayload,
} from "../chat/attachment-payload-store.ts";
import {
  CHAT_ATTACHMENT_ACCEPT,
  isSupportedChatAttachmentFile,
} from "../chat/attachment-support.ts";
import { buildChatItems, type BuildChatItemsProps } from "../chat/build-chat-items.ts";
import { renderChatQueue } from "../chat/chat-queue.ts";
import { buildRawSidebarContent } from "../chat/chat-sidebar-raw.ts";
import { renderWelcomeState, resolveAssistantDisplayAvatar } from "../chat/chat-welcome.ts";
import { renderContextNotice } from "../chat/context-notice.ts";
import { summarizeControlDirectorDiagnostics } from "../chat/control-director-diagnostics.ts";
import { DeletedMessages } from "../chat/deleted-messages.ts";
import { exportChatMarkdown } from "../chat/export.ts";
import {
  getAssistantAttachmentAvailabilityRenderVersion,
  renderMessageGroup,
  renderReadingIndicatorGroup,
  renderStreamingGroup,
} from "../chat/grouped-render.ts";
import { CHAT_HISTORY_RENDER_LIMIT } from "../chat/history-limits.ts";
import type { ChatInputHistoryKeyInput, ChatInputHistoryKeyResult } from "../chat/input-history.ts";
import { PinnedMessages } from "../chat/pinned-messages.ts";
import { getPinnedMessageSummary } from "../chat/pinned-summary.ts";
import {
  chatGoalStatusLabel,
  isActiveChatGoal,
  resolveCurrentChatGoal,
  type ChatGoalFlowSummary,
} from "../chat/pursue-goal.ts";
import {
  REALTIME_TALK_FALLBACK_PROVIDERS,
  listSelectableRealtimeTalkProviders,
  resolveControlUiRealtimeTalkProviderTransports,
  type RealtimeTalkCatalogProvider,
} from "../chat/realtime-talk-catalog.ts";
import type { RealtimeTalkConversationEntry } from "../chat/realtime-talk-conversation.ts";
import type { RealtimeTalkStatus } from "../chat/realtime-talk.ts";
import { renderChatRunControls } from "../chat/run-controls.ts";
import type { ChatRunUiStatus } from "../chat/run-lifecycle.ts";
import { getOrCreateSessionCacheValue } from "../chat/session-cache.ts";
import { renderSideResult } from "../chat/side-result-render.ts";
import type { ChatSideResult } from "../chat/side-result.ts";
import {
  CATEGORY_LABELS,
  SLASH_COMMANDS,
  getHiddenCommandCount,
  getSlashCommandCompletions,
  type SlashCommandCategory,
  type SlashCommandDef,
} from "../chat/slash-commands.ts";
import {
  renderChatRunStatusIndicator,
  renderCompactionIndicator,
  renderFallbackIndicator,
} from "../chat/status-indicators.ts";
import { getExpandedToolCards, syncToolCardExpansionState } from "../chat/tool-expansion-state.ts";
import {
  buildWorkSurfaceSnapshot,
  hasActiveWork,
  type WorkSurfaceItem,
  type WorkSurfaceTaskSummary,
} from "../chat/work-snapshot.ts";
import {
  buildAgentWorkTreeSnapshot,
  type AgentWorkTreeNode,
  type AgentWorkTreeSnapshot,
} from "../chat/work-tree.ts";
import type {
  ExecApprovalRequest,
  ExecApprovalRequestPayload,
} from "../controllers/exec-approval.ts";
import type { EmbedSandboxMode } from "../embed-sandbox.ts";
import { icons } from "../icons.ts";
import { formatGoalDetail, formatGoalSummary } from "../session-goal.ts";
import type { SidebarContent } from "../sidebar-content.ts";
import { detectTextDirection } from "../text-direction.ts";
import type {
  ProjectRecord,
  ProjectsListResult,
  SessionGoal,
  SessionsListResult,
  GatewaySessionRow,
  SessionWorkspaceListResult,
} from "../types.ts";
import type { ChatAttachment, ChatQueueItem } from "../ui-types.ts";
import { resolveLocalUserName } from "../user-identity.ts";
import { renderMarkdownSidebar } from "./markdown-sidebar.ts";
import "../components/resizable-divider.ts";

const COMPOSER_CHROME_INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[contenteditable='true']",
  "[role='button']",
  "[role='listbox']",
  "[role='option']",
].join(",");

function hasTerminalRunStatus(status: ChatRunUiStatus | null | undefined): boolean {
  return status?.phase === "done" || status?.phase === "interrupted";
}

function isCurrentSessionSubmittedProgress(
  item: ChatQueueItem,
  sessionKey: string,
  status: ChatRunUiStatus | null | undefined,
): boolean {
  return (
    item.sessionKey === sessionKey &&
    !item.pendingRunId &&
    (item.sendState === "sending" || item.sendState === "waiting-model") &&
    (status == null || item.sendRunId !== status.runId)
  );
}

export type ChatProps = {
  sessionKey: string;
  onSessionKeyChange: (next: string) => void;
  thinkingLevel: string | null;
  showThinking: boolean;
  showToolCalls: boolean;
  loading: boolean;
  sending: boolean;
  canAbort?: boolean;
  runStatus?: ChatRunUiStatus | null;
  compactionStatus?: CompactionStatus | null;
  fallbackStatus?: FallbackStatus | null;
  messages: unknown[];
  sideResult?: ChatSideResult | null;
  toolMessages: unknown[];
  streamSegments: Array<{ text: string; ts: number }>;
  stream: string | null;
  streamStartedAt: number | null;
  currentRunId?: string | null;
  workTasks?: WorkSurfaceTaskSummary[];
  workTasksLoading?: boolean;
  workTasksError?: string | null;
  goalFlows?: ChatGoalFlowSummary[];
  goalLoading?: boolean;
  goalBusy?: boolean;
  goalError?: string | null;
  goalDraft?: string;
  goalPanelOpen?: boolean;
  projectsList?: ProjectsListResult | null;
  projectsLoading?: boolean;
  projectPickerOpen?: boolean;
  projectBusy?: boolean;
  projectError?: string | null;
  projectCreateName?: string;
  projectCreateDescription?: string;
  projectCreateInstructions?: string;
  execApprovalQueue?: ExecApprovalRequest[];
  execApprovalBusy?: boolean;
  execApprovalError?: string | null;
  assistantAvatarUrl?: string | null;
  draft: string;
  queue: ChatQueueItem[];
  realtimeTalkActive?: boolean;
  realtimeTalkStatus?: RealtimeTalkStatus;
  realtimeTalkDetail?: string | null;
  realtimeTalkTranscript?: string | null;
  realtimeTalkConversation?: RealtimeTalkConversationEntry[];
  realtimeTalkOptionsOpen?: boolean;
  realtimeTalkCatalogProviders?: RealtimeTalkCatalogProvider[] | null;
  realtimeTalkOptions?: {
    provider: string;
    model: string;
    voice: string;
    transport: string;
    vadThreshold: string;
    silenceDurationMs: string;
    prefixPaddingMs: string;
    reasoningEffort: string;
  };
  connected: boolean;
  canSend: boolean;
  disabledReason: string | null;
  error: string | null;
  sessions: SessionsListResult | null;
  focusMode?: boolean;
  sidebarOpen?: boolean;
  sidebarContent?: SidebarContent | null;
  sidebarError?: string | null;
  splitRatio?: number;
  canvasPluginSurfaceUrl?: string | null;
  embedSandboxMode?: EmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
  assistantName: string;
  assistantAvatar: string | null;
  userName?: string | null;
  userAvatar?: string | null;
  localMediaPreviewRoots?: string[];
  assistantAttachmentAuthToken?: string | null;
  autoExpandToolCalls?: boolean;
  attachments?: ChatAttachment[];
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
  showNewMessages?: boolean;
  onScrollToBottom?: () => void;
  onRefresh: () => void;
  onToggleFocusMode?: () => void;
  getDraft?: () => string;
  onDraftChange: (next: string) => void;
  onRequestUpdate?: () => void;
  onHistoryKeydown?: (input: ChatInputHistoryKeyInput) => ChatInputHistoryKeyResult;
  onSlashIntent?: () => void | Promise<void>;
  onSend: () => void;
  onCompact?: () => void | Promise<void>;
  onOpenSessionCheckpoints?: () => void | Promise<void>;
  onToggleRealtimeTalk?: () => void;
  onToggleRealtimeTalkOptions?: () => void;
  onRealtimeTalkOptionsChange?: (
    next: Partial<NonNullable<ChatProps["realtimeTalkOptions"]>>,
  ) => void;
  onDismissError?: () => void;
  onDismissRealtimeTalkError?: () => void;
  onAbort?: () => void;
  onQueueRemove: (id: string) => void;
  onQueueRetry?: (id: string) => void;
  onQueueSteer?: (id: string) => void;
  onWorkTaskCancel?: (taskId: string) => void;
  onGoalPanelToggle?: (open: boolean) => void;
  onGoalDraftChange?: (value: string) => void;
  onGoalStart?: () => void | Promise<void>;
  onGoalContinue?: (flowId: string) => void | Promise<void>;
  onGoalCancel?: (flowId: string) => void | Promise<void>;
  onGoalRefresh?: () => void | Promise<void>;
  onProjectPickerToggle?: (open: boolean) => void;
  onProjectCreateFieldChange?: (
    field: "name" | "description" | "instructions",
    value: string,
  ) => void;
  onProjectCreateAndAttach?: () => void | Promise<void>;
  onProjectAttach?: (projectId: string) => void | Promise<void>;
  onProjectDetach?: () => void | Promise<void>;
  onNewProjectChat?: (projectId: string) => void | Promise<void>;
  onProjectRefresh?: () => void | Promise<void>;
  onExecApprovalDecision?: (
    decision: "allow-once" | "allow-always" | "deny",
  ) => void | Promise<void>;
  onDismissSideResult?: () => void;
  onNewSession: () => void;
  onClearHistory?: () => void;
  agentsList: {
    agents: Array<{ id: string; name?: string; identity?: { name?: string; avatarUrl?: string } }>;
    defaultId?: string;
  } | null;
  currentAgentId: string;
  fullMessageAgentId?: string;
  onAgentChange: (agentId: string) => void;
  onNavigateToAgent?: () => void;
  onSessionSelect?: (sessionKey: string) => void;
  onOpenSidebar?: (content: SidebarContent) => void;
  onCloseSidebar?: () => void;
  onSplitRatioChange?: (ratio: number) => void;
  onChatScroll?: (event: Event) => void;
  basePath?: string;
  composerControls?: TemplateResult | typeof nothing | ReturnType<typeof guard>;
  sessionWorkspace?: {
    collapsed: boolean;
    sessionKey: string;
    list: SessionWorkspaceListResult | null;
    loading: boolean;
    error: string | null;
    activeId: string | null;
    onToggleCollapsed: () => void;
    onRefresh: () => void;
    onBrowsePath: (path: string) => void;
    onCopyPath: (path: string) => void;
    onOpenFile: (path: string) => void;
    onSearch: (search: string) => void;
    onOpenArtifact: (artifactId: string) => void;
  };
};

const pinnedMessagesMap = new Map<string, PinnedMessages>();
const deletedMessagesMap = new Map<string, DeletedMessages>();
const SLASH_MENU_LISTBOX_ID = "chat-slash-menu-listbox";
const SLASH_MENU_ACTIVE_ANNOUNCEMENT_ID = "chat-slash-active-announcement";
type TalkSelectOption = { label: string; value: string };

const TALK_VOICE_OPTIONS: TalkSelectOption[] = [
  { label: "Default", value: "" },
  { label: "Alloy", value: "alloy" },
  { label: "Ash", value: "ash" },
  { label: "Ballad", value: "ballad" },
  { label: "Coral", value: "coral" },
  { label: "Echo", value: "echo" },
  { label: "Sage", value: "sage" },
  { label: "Shimmer", value: "shimmer" },
  { label: "Verse", value: "verse" },
  { label: "Marin", value: "marin" },
  { label: "Cedar", value: "cedar" },
];
const TALK_SENSITIVITY_OPTIONS: TalkSelectOption[] = [
  { label: "Default", value: "" },
  { label: "Low", value: "0.65" },
  { label: "Medium", value: "0.5" },
  { label: "High", value: "0.35" },
];
const TALK_PROVIDER_AUTO_OPTION: TalkSelectOption = { label: "Auto", value: "" };
const TALK_PROVIDER_FALLBACK_OPTIONS: TalkSelectOption[] = [
  TALK_PROVIDER_AUTO_OPTION,
  ...REALTIME_TALK_FALLBACK_PROVIDERS.map((provider) => ({
    label: provider.label,
    value: provider.id,
  })),
];
const TALK_TRANSPORT_OPTIONS: TalkSelectOption[] = [
  { label: "Auto", value: "" },
  { label: "WebRTC", value: "webrtc" },
  { label: "Gateway relay", value: "gateway-relay" },
  { label: "Provider WebSocket", value: "provider-websocket" },
];
const TALK_REASONING_OPTIONS: TalkSelectOption[] = [
  { label: "Default", value: "" },
  { label: "Minimal", value: "minimal" },
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
];
const INITIAL_CHAT_HISTORY_RENDER_WINDOW = 30;
const CHAT_HISTORY_RENDER_WINDOW_BATCH = 30;
const CHAT_HISTORY_RENDER_EXPAND_SCROLL_TOP_PX = 48;

function getPinnedMessages(sessionKey: string): PinnedMessages {
  return getOrCreateSessionCacheValue(
    pinnedMessagesMap,
    sessionKey,
    () => new PinnedMessages(sessionKey),
  );
}

function getDeletedMessages(sessionKey: string): DeletedMessages {
  return getOrCreateSessionCacheValue(
    deletedMessagesMap,
    sessionKey,
    () => new DeletedMessages(sessionKey),
  );
}

function renderNativeTalkSelect(params: {
  label: string;
  value: string;
  options: TalkSelectOption[];
  onSelect: (value: string) => void;
  selectedLabel?: string;
}) {
  const selectedLabel =
    params.selectedLabel ?? params.options.find((entry) => entry.value === params.value)?.label;
  return html`
    <label class="agent-chat__talk-field" data-talk-select=${params.label.toLowerCase()}>
      <span>${params.label}</span>
      ${selectedLabel
        ? html`<span class="agent-chat__talk-select-label">${selectedLabel}</span>`
        : nothing}
      <select
        .value=${params.value}
        @change=${(event: Event) =>
          params.onSelect((event.currentTarget as HTMLSelectElement).value)}
      >
        ${repeat(
          params.options,
          (entry) => entry.value,
          (entry) => html`
            <option
              value=${entry.value}
              data-talk-select-option=${entry.value}
              ?selected=${entry.value === params.value}
              @click=${() => params.onSelect(entry.value)}
            >
              ${entry.label}
            </option>
          `,
        )}
      </select>
    </label>
  `;
}

function renderRealtimeTalkOptions(props: ChatProps) {
  const options = props.realtimeTalkOptions;
  const onChange = props.onRealtimeTalkOptionsChange;
  if (!props.realtimeTalkOptionsOpen || !options || !onChange) {
    return nothing;
  }
  const catalogProviders = props.realtimeTalkCatalogProviders;
  const selectableProviders = listSelectableRealtimeTalkProviders(catalogProviders ?? []);
  const providerOptions: TalkSelectOption[] = catalogProviders
    ? [
        TALK_PROVIDER_AUTO_OPTION,
        ...selectableProviders.map((provider) => ({ label: provider.label, value: provider.id })),
      ]
    : TALK_PROVIDER_FALLBACK_OPTIONS;
  const selectedCatalogProvider = options.provider
    ? selectableProviders.find((provider) => provider.id === options.provider)
    : null;
  const selectedProviderTransports = selectedCatalogProvider
    ? resolveControlUiRealtimeTalkProviderTransports(selectedCatalogProvider)
    : undefined;
  const transportOptions: TalkSelectOption[] = selectedProviderTransports
    ? [
        { label: "Auto", value: "" },
        ...TALK_TRANSPORT_OPTIONS.filter(
          (opt) => opt.value !== "" && selectedProviderTransports.includes(opt.value),
        ),
      ]
    : TALK_TRANSPORT_OPTIONS;
  const update = (key: keyof NonNullable<ChatProps["realtimeTalkOptions"]>) => (event: Event) => {
    const value = (event.currentTarget as HTMLInputElement | HTMLSelectElement).value;
    onChange({ [key]: value });
  };
  const isDefaultSensitivity = options.vadThreshold === "";
  const isPresetSensitivity = ["0.65", "0.5", "0.35"].includes(options.vadThreshold);
  const isCustomSensitivity = !isDefaultSensitivity && !isPresetSensitivity;
  const sensitivityValue = isDefaultSensitivity
    ? ""
    : isPresetSensitivity
      ? options.vadThreshold
      : "__custom";
  const sensitivityOptions = isCustomSensitivity
    ? [...TALK_SENSITIVITY_OPTIONS, { label: "Custom", value: "__custom" }]
    : TALK_SENSITIVITY_OPTIONS;
  const sensitivityLabel =
    sensitivityOptions.find((entry) => entry.value === sensitivityValue)?.label ?? "Custom";
  const updateSensitivity = (value: string) => {
    if (value !== "__custom") {
      onChange({ vadThreshold: value });
    }
  };
  return html`
    <div class="agent-chat__talk-options" aria-label="Talk options">
      <div class="agent-chat__talk-options-primary">
        ${renderNativeTalkSelect({
          label: "Voice",
          value: options.voice,
          options: TALK_VOICE_OPTIONS,
          onSelect: (voice) => onChange({ voice }),
        })}
        <label class="agent-chat__talk-field">
          <span>Model</span>
          <input
            .value=${options.model}
            @input=${update("model")}
            placeholder="Auto"
            spellcheck="false"
          />
        </label>
        ${renderNativeTalkSelect({
          label: "Sensitivity",
          value: sensitivityValue,
          options: sensitivityOptions,
          selectedLabel: sensitivityLabel,
          onSelect: updateSensitivity,
        })}
      </div>
      <details class="agent-chat__talk-options-advanced">
        <summary>Advanced</summary>
        <div class="agent-chat__talk-options-grid">
          ${renderNativeTalkSelect({
            label: "Provider",
            value: options.provider,
            options: providerOptions,
            onSelect: (provider) => {
              const selectedProvider = selectableProviders.find((entry) => entry.id === provider);
              const transports = selectedProvider
                ? resolveControlUiRealtimeTalkProviderTransports(selectedProvider)
                : null;
              const transport = options.transport;
              onChange(
                transports && transport && !transports.includes(transport)
                  ? { provider, transport: "" }
                  : { provider },
              );
            },
          })}
          ${renderNativeTalkSelect({
            label: "Transport",
            value: options.transport,
            options: transportOptions,
            onSelect: (transport) => onChange({ transport }),
          })}
          ${renderNativeTalkSelect({
            label: "Reasoning",
            value: options.reasoningEffort,
            options: TALK_REASONING_OPTIONS,
            onSelect: (reasoningEffort) => onChange({ reasoningEffort }),
          })}
          <label class="agent-chat__talk-field">
            <span>Exact VAD</span>
            <input
              type="number"
              min="0"
              max="1"
              step="0.05"
              .value=${options.vadThreshold}
              @input=${update("vadThreshold")}
              placeholder="0.5"
            />
          </label>
          <label class="agent-chat__talk-field">
            <span>Pause before send</span>
            <input
              type="number"
              min="1"
              step="50"
              .value=${options.silenceDurationMs}
              @input=${update("silenceDurationMs")}
              placeholder="500"
            />
          </label>
          <label class="agent-chat__talk-field">
            <span>Lead-in</span>
            <input
              type="number"
              min="0"
              step="50"
              .value=${options.prefixPaddingMs}
              @input=${update("prefixPaddingMs")}
              placeholder="300"
            />
          </label>
        </div>
      </details>
    </div>
  `;
}

function renderRealtimeTalkConversation(props: ChatProps) {
  const entries = props.realtimeTalkConversation ?? [];
  if (entries.length === 0) {
    return nothing;
  }
  return html`
    <div class="agent-chat__voice-turns" role="log" aria-label=${t("chat.composer.talkTranscript")}>
      ${repeat(
        entries,
        (entry) => entry.id,
        (entry) => {
          const label =
            entry.role === "user" ? props.userName?.trim() || "You" : props.assistantName;
          return html`
            <div
              class="agent-chat__voice-turn agent-chat__voice-turn--${entry.role}"
              data-role=${entry.role}
            >
              <span class="agent-chat__voice-turn-speaker">${label}</span>
              <span class="agent-chat__voice-turn-text">${entry.text}</span>
              ${entry.isStreaming
                ? html`<span
                    class="agent-chat__voice-turn-stream"
                    aria-label=${t("chat.composer.stillListening")}
                  ></span>`
                : nothing}
            </div>
          `;
        },
      )}
    </div>
  `;
}

interface ChatEphemeralState {
  slashMenuOpen: boolean;
  slashMenuItems: SlashCommandDef[];
  slashMenuIndex: number;
  slashMenuMode: "command" | "args";
  slashMenuCommand: SlashCommandDef | null;
  slashMenuArgItems: string[];
  slashMenuExpanded: boolean;
  slashCommandRefreshPending: boolean;
  searchOpen: boolean;
  searchQuery: string;
  pinnedExpanded: boolean;
  composerComposing: boolean;
  historyRenderSessionKey: string | null;
  historyRenderMessagesRef: unknown[] | null;
  historyRenderMessageCount: number;
  historyRenderLimit: number;
  historyRenderLastScrollTop: number | null;
  historyRenderExpansionFrame: number | null;
  historyRenderAnchorAdjustment: {
    scrollHeight: number;
    scrollTop: number;
  } | null;
  historyRenderAnchorFrame: number | null;
}

function createChatEphemeralState(): ChatEphemeralState {
  return {
    slashMenuOpen: false,
    slashMenuItems: [],
    slashMenuIndex: 0,
    slashMenuMode: "command",
    slashMenuCommand: null,
    slashMenuArgItems: [],
    slashMenuExpanded: false,
    slashCommandRefreshPending: false,
    searchOpen: false,
    searchQuery: "",
    pinnedExpanded: false,
    composerComposing: false,
    historyRenderSessionKey: null,
    historyRenderMessagesRef: null,
    historyRenderMessageCount: 0,
    historyRenderLimit: 0,
    historyRenderLastScrollTop: null,
    historyRenderExpansionFrame: null,
    historyRenderAnchorAdjustment: null,
    historyRenderAnchorFrame: null,
  };
}

const vs = createChatEphemeralState();

type CachedChatItems = {
  input: BuildChatItemsProps | null;
  items: ReturnType<typeof buildChatItems>;
};

type ComposerDraftMirror = {
  hostDraft: string;
  value: string;
};

const chatItemsBySession = new Map<string, CachedChatItems>();
const composerDraftMirrors = new Map<string, ComposerDraftMirror>();

function composerDraftMirrorKey(props: Pick<ChatProps, "currentAgentId" | "sessionKey">): string {
  return `${props.currentAgentId}\u0000${props.sessionKey}`;
}

function getComposerDraftMirror(props: ChatProps): ComposerDraftMirror {
  const mirror = getOrCreateSessionCacheValue(
    composerDraftMirrors,
    composerDraftMirrorKey(props),
    () => ({
      hostDraft: props.draft,
      value: props.draft,
    }),
  );
  if (mirror.hostDraft !== props.draft) {
    mirror.hostDraft = props.draft;
    mirror.value = props.draft;
  }
  return mirror;
}

function commitComposerDraft(props: ChatProps, value: string): void {
  const mirror = getComposerDraftMirror(props);
  mirror.value = value;
  if (mirror.hostDraft === value) {
    return;
  }
  mirror.hostDraft = value;
  props.onDraftChange(value);
}

function sameChatItemsInput(previous: BuildChatItemsProps, next: BuildChatItemsProps): boolean {
  return (
    previous.sessionKey === next.sessionKey &&
    previous.messages === next.messages &&
    previous.toolMessages === next.toolMessages &&
    previous.streamSegments === next.streamSegments &&
    previous.stream === next.stream &&
    previous.streamStartedAt === next.streamStartedAt &&
    previous.queue === next.queue &&
    previous.showToolCalls === next.showToolCalls &&
    previous.searchOpen === next.searchOpen &&
    previous.searchQuery === next.searchQuery &&
    previous.historyRenderLimit === next.historyRenderLimit
  );
}

function buildCachedChatItems(input: BuildChatItemsProps): ReturnType<typeof buildChatItems> {
  const cached = getOrCreateSessionCacheValue(chatItemsBySession, input.sessionKey, () => ({
    input: null,
    items: [],
  }));
  if (cached.input && sameChatItemsInput(cached.input, input)) {
    return cached.items;
  }
  const items = buildChatItems(input);
  cached.input = input;
  cached.items = items;
  return items;
}

function deletedChatItemsSignature(
  deleted: DeletedMessages,
  chatItems: ReturnType<typeof buildChatItems>,
): string {
  const deletedKeys = chatItems
    .map((item) => item.key)
    .filter((key) => deleted.has(key))
    .toSorted();
  return deletedKeys.length === 0 ? "" : deletedKeys.join("\u0000");
}

function stableBooleanMapSignature(values: ReadonlyMap<string, boolean>): string {
  if (values.size === 0) {
    return "";
  }
  return Array.from(values)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value ? "1" : "0"}`)
    .join("\u0000");
}

/**
 * Reset chat view ephemeral state when navigating away.
 * Clears search/slash UI that should not survive navigation.
 */
export function resetChatViewState() {
  if (vs.historyRenderExpansionFrame != null) {
    cancelAnimationFrame(vs.historyRenderExpansionFrame);
  }
  if (vs.historyRenderAnchorFrame != null) {
    cancelAnimationFrame(vs.historyRenderAnchorFrame);
  }
  Object.assign(vs, createChatEphemeralState());
  chatItemsBySession.clear();
  composerDraftMirrors.clear();
}

export const cleanupChatModuleState = resetChatViewState;

function resolveChatHistoryRenderCap(messageCount: number): number {
  return Math.min(Math.max(0, messageCount), CHAT_HISTORY_RENDER_LIMIT);
}

function shouldRenderFullChatHistoryWindow(messageCount: number): boolean {
  return (
    messageCount <= INITIAL_CHAT_HISTORY_RENDER_WINDOW ||
    (vs.searchOpen && vs.searchQuery.trim().length > 0)
  );
}

function resolveChatHistoryRenderWindow(props: ChatProps): number {
  const messages = Array.isArray(props.messages) ? props.messages : [];
  const cap = resolveChatHistoryRenderCap(messages.length);
  const sessionChanged = vs.historyRenderSessionKey !== props.sessionKey;
  const refChanged = vs.historyRenderMessagesRef !== messages;
  const previousCount = vs.historyRenderMessageCount;
  if (sessionChanged || (refChanged && previousCount === 0)) {
    vs.historyRenderLastScrollTop = null;
  }

  if (cap === 0) {
    vs.historyRenderSessionKey = props.sessionKey;
    vs.historyRenderMessagesRef = messages;
    vs.historyRenderMessageCount = messages.length;
    vs.historyRenderLimit = 0;
    vs.historyRenderLastScrollTop = null;
    return 0;
  }

  if (shouldRenderFullChatHistoryWindow(messages.length)) {
    vs.historyRenderSessionKey = props.sessionKey;
    vs.historyRenderMessagesRef = messages;
    vs.historyRenderMessageCount = messages.length;
    vs.historyRenderLimit = cap;
    return cap;
  }

  if (sessionChanged || (refChanged && previousCount === 0)) {
    vs.historyRenderLimit = Math.min(INITIAL_CHAT_HISTORY_RENDER_WINDOW, cap);
  } else if (refChanged) {
    const grewBy = messages.length - previousCount;
    if (vs.historyRenderLimit >= previousCount) {
      vs.historyRenderLimit = cap;
    } else if (grewBy > 0 && grewBy <= CHAT_HISTORY_RENDER_WINDOW_BATCH) {
      vs.historyRenderLimit = Math.min(cap, vs.historyRenderLimit + grewBy);
    } else {
      vs.historyRenderLimit = Math.min(
        Math.max(vs.historyRenderLimit, INITIAL_CHAT_HISTORY_RENDER_WINDOW),
        cap,
      );
    }
  }

  vs.historyRenderSessionKey = props.sessionKey;
  vs.historyRenderMessagesRef = messages;
  vs.historyRenderMessageCount = messages.length;
  vs.historyRenderLimit = Math.min(Math.max(1, vs.historyRenderLimit), cap);
  return vs.historyRenderLimit;
}

function maybeExpandChatHistoryRenderWindow(event: Event, requestUpdate: () => void) {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const scrollTop = Math.max(0, target.scrollTop);
  const previousScrollTop = vs.historyRenderLastScrollTop;
  vs.historyRenderLastScrollTop = scrollTop;
  const distanceFromBottom = Math.max(0, target.scrollHeight - scrollTop - target.clientHeight);
  const isTop = scrollTop <= CHAT_HISTORY_RENDER_EXPAND_SCROLL_TOP_PX;
  const isBottomAutoScroll =
    scrollTop > 0 && distanceFromBottom <= CHAT_HISTORY_RENDER_EXPAND_SCROLL_TOP_PX;
  const isTopScrollUp =
    isTop &&
    (scrollTop === 0 ||
      (!isBottomAutoScroll && (previousScrollTop == null || scrollTop < previousScrollTop)));
  if (!isTopScrollUp) {
    return;
  }
  const cap = resolveChatHistoryRenderCap(vs.historyRenderMessageCount);
  if (vs.historyRenderLimit >= cap) {
    return;
  }
  vs.historyRenderAnchorAdjustment = {
    scrollHeight: target.scrollHeight,
    scrollTop,
  };
  scheduleChatHistoryRenderAnchorPreservation(target);
  vs.historyRenderLimit = Math.min(cap, vs.historyRenderLimit + CHAT_HISTORY_RENDER_WINDOW_BATCH);
  requestUpdate();
}

function scheduleChatHistoryRenderAnchorPreservation(thread: HTMLElement) {
  const adjustment = vs.historyRenderAnchorAdjustment;
  if (!adjustment || vs.historyRenderAnchorFrame != null) {
    return;
  }
  vs.historyRenderAnchorFrame = requestAnimationFrame(() => {
    vs.historyRenderAnchorFrame = null;
    vs.historyRenderAnchorAdjustment = null;
    const heightDelta = thread.scrollHeight - adjustment.scrollHeight;
    if (heightDelta <= 0) {
      return;
    }
    thread.scrollTop = adjustment.scrollTop + heightDelta;
  });
}

function scheduleChatHistoryRenderWindowFill(
  thread: HTMLElement | null,
  requestUpdate: () => void,
  scrollToBottom: () => void,
) {
  if (!thread || vs.historyRenderExpansionFrame != null) {
    return;
  }
  const cap = resolveChatHistoryRenderCap(vs.historyRenderMessageCount);
  if (vs.historyRenderLimit >= cap) {
    return;
  }
  vs.historyRenderExpansionFrame = requestAnimationFrame(() => {
    vs.historyRenderExpansionFrame = null;
    const nextCap = resolveChatHistoryRenderCap(vs.historyRenderMessageCount);
    if (vs.historyRenderLimit >= nextCap) {
      return;
    }
    const canScroll = thread.scrollHeight - thread.clientHeight > 1;
    if (canScroll) {
      return;
    }
    vs.historyRenderLimit = Math.min(
      nextCap,
      vs.historyRenderLimit + CHAT_HISTORY_RENDER_WINDOW_BATCH,
    );
    requestUpdate();
    scrollToBottom();
  });
}

function adjustTextareaHeight(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
}

function focusComposerFromChrome(event: MouseEvent, connected: boolean) {
  if (!connected || event.defaultPrevented) {
    return;
  }
  const target = event.target;
  const currentTarget = event.currentTarget;
  if (!(target instanceof Element) || !(currentTarget instanceof HTMLElement)) {
    return;
  }
  if (target.closest(COMPOSER_CHROME_INTERACTIVE_SELECTOR)) {
    return;
  }
  currentTarget
    .querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox > textarea")
    ?.focus({ preventScroll: true });
}

function clickComposerFileInput(event: MouseEvent) {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  target
    .closest(".agent-chat__input")
    ?.querySelector<HTMLInputElement>(".agent-chat__file-input")
    ?.click();
}

function restoreHistoryCaret(target: HTMLTextAreaElement, direction: "up" | "down") {
  requestAnimationFrame(() => {
    if (document.activeElement !== target) {
      return;
    }
    adjustTextareaHeight(target);
    const caret = direction === "up" ? 0 : target.value.length;
    target.selectionStart = caret;
    target.selectionEnd = caret;
  });
}

function generateAttachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function chatAttachmentFromFile(file: File, dataUrl: string): ChatAttachment {
  const attachment = {
    id: generateAttachmentId(),
    mimeType: file.type || "application/octet-stream",
    fileName: file.name || undefined,
    sizeBytes: file.size,
  };
  return registerChatAttachmentPayload({ attachment, dataUrl, file });
}

function dataImageClipboardFile(dataUrl: string): { file: File; dataUrl: string } | null {
  const match = /^\s*data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)\s*$/i.exec(dataUrl);
  if (!match) {
    return null;
  }
  const mimeType = match[1].toLowerCase();
  if (!isSupportedChatAttachmentFile({ name: "pasted-image", type: mimeType })) {
    return null;
  }
  const base64 = match[2].replace(/\s+/g, "");
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const extension = mimeType.split("/")[1]?.replace(/[^a-z0-9.+-]/gi, "") || "png";
    return {
      file: new File([bytes], `pasted-image.${extension}`, { type: mimeType }),
      dataUrl: `data:${mimeType};base64,${base64}`,
    };
  } catch {
    return null;
  }
}

function isImageAttachment(att: ChatAttachment): boolean {
  return att.mimeType.startsWith("image/");
}

function handlePaste(e: ClipboardEvent, props: ChatProps) {
  const items = e.clipboardData?.items;
  if (!items || !props.onAttachmentsChange) {
    return;
  }
  const imageItems: DataTransferItem[] = [];
  for (const item of Array.from(items)) {
    if (item.type.startsWith("image/")) {
      imageItems.push(item);
    }
  }
  if (imageItems.length === 0) {
    const text = e.clipboardData?.getData("text/plain");
    const pasted = text ? dataImageClipboardFile(text) : null;
    if (!pasted) {
      return;
    }
    e.preventDefault();
    props.onAttachmentsChange([
      ...(props.attachments ?? []),
      chatAttachmentFromFile(pasted.file, pasted.dataUrl),
    ]);
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
      const newAttachment = chatAttachmentFromFile(file, dataUrl);
      const current = props.attachments ?? [];
      props.onAttachmentsChange?.([...current, newAttachment]);
    });
    reader.readAsDataURL(file);
  }
}

function handleFileSelect(e: Event, props: ChatProps) {
  const input = e.target as HTMLInputElement;
  if (!input.files || !props.onAttachmentsChange) {
    return;
  }
  const current = props.attachments ?? [];
  const additions: ChatAttachment[] = [];
  let pending = 0;
  for (const file of input.files) {
    if (!isSupportedChatAttachmentFile(file)) {
      continue;
    }
    pending++;
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      additions.push(chatAttachmentFromFile(file, reader.result as string));
      pending--;
      if (pending === 0) {
        props.onAttachmentsChange?.([...current, ...additions]);
      }
    });
    reader.readAsDataURL(file);
  }
  input.value = "";
}

function handleDrop(e: DragEvent, props: ChatProps) {
  e.preventDefault();
  const files = e.dataTransfer?.files;
  if (!files || !props.onAttachmentsChange) {
    return;
  }
  const current = props.attachments ?? [];
  const additions: ChatAttachment[] = [];
  let pending = 0;
  for (const file of files) {
    if (!isSupportedChatAttachmentFile(file)) {
      continue;
    }
    pending++;
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      additions.push(chatAttachmentFromFile(file, reader.result as string));
      pending--;
      if (pending === 0) {
        props.onAttachmentsChange?.([...current, ...additions]);
      }
    });
    reader.readAsDataURL(file);
  }
}

function renderAttachmentPreview(props: ChatProps): TemplateResult | typeof nothing {
  const attachments = props.attachments ?? [];
  if (attachments.length === 0) {
    return nothing;
  }
  return html`
    <div class="chat-attachments-preview">
      ${attachments.map(
        (att) => html`
          <div
            class=${[
              "chat-attachment-thumb",
              isImageAttachment(att) ? "" : "chat-attachment-thumb--file",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            ${isImageAttachment(att) && getChatAttachmentPreviewUrl(att)
              ? html`<img src=${getChatAttachmentPreviewUrl(att)!} alt="Attachment preview" />`
              : html`
                  <div class="chat-attachment-file" title=${att.fileName ?? "Attached file"}>
                    <span class="chat-attachment-file__icon">${icons.paperclip}</span>
                    <span class="chat-attachment-file__name"
                      >${att.fileName ?? "Attached file"}</span
                    >
                  </div>
                `}
            <button
              class="chat-attachment-remove"
              type="button"
              aria-label="Remove attachment"
              @click=${() => {
                const next = (props.attachments ?? []).filter((a) => a.id !== att.id);
                releaseChatAttachmentPayload(att.id);
                props.onAttachmentsChange?.(next);
              }}
            >
              &times;
            </button>
          </div>
        `,
      )}
    </div>
  `;
}

function renderChatGoal(goal: SessionGoal | undefined): TemplateResult | typeof nothing {
  if (!goal) {
    return nothing;
  }
  return html`
    <div
      class="agent-chat__goal agent-chat__goal--${goal.status}"
      role="status"
      title=${formatGoalDetail(goal)}
      aria-label=${formatGoalDetail(goal)}
    >
      <span class="agent-chat__goal-label">${formatGoalSummary(goal)}</span>
      <span class="agent-chat__goal-objective">${goal.objective}</span>
    </div>
  `;
}

function formatWorkspaceFileSize(file: { size?: number }): string {
  const size = file.size;
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
    return "";
  }
  if (size >= 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
  }
  if (size >= 1024) {
    return `${(size / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  }
  return `${size} B`;
}

function renderWorkspaceArtifactSize(artifact: { sizeBytes?: number }): string {
  return formatWorkspaceFileSize({ size: artifact.sizeBytes });
}

function renderWorkspaceRailSection(
  title: string,
  content: TemplateResult | typeof nothing,
): TemplateResult | typeof nothing {
  if (content === nothing) {
    return nothing;
  }
  return html`
    <section class="chat-workspace-rail__section">
      <div class="chat-workspace-rail__section-title">${title}</div>
      ${content}
    </section>
  `;
}

function renderSessionWorkspaceRail(
  sessionWorkspace: NonNullable<ChatProps["sessionWorkspace"]> | undefined,
): TemplateResult | typeof nothing {
  if (!sessionWorkspace) {
    return nothing;
  }
  if (sessionWorkspace.collapsed) {
    return html`
      <aside
        class="chat-workspace-rail chat-workspace-rail--collapsed"
        aria-label=${t("chat.workspaceFiles.label")}
      >
        <button
          type="button"
          class="nav-collapse-toggle chat-workspace-rail__collapse-toggle"
          title=${t("chat.workspaceFiles.expand")}
          aria-label=${t("chat.workspaceFiles.expand")}
          aria-expanded="false"
          @click=${sessionWorkspace.onToggleCollapsed}
        >
          <span class="nav-collapse-toggle__icon" aria-hidden="true">${icons.panelRightOpen}</span>
        </button>
        <span class="chat-workspace-rail__collapsed-icon" aria-hidden="true"
          >${icons.fileText}</span
        >
      </aside>
    `;
  }
  const files = sessionWorkspace.list?.files ?? [];
  const modifiedFiles = files.filter((file) => file.kind === "modified");
  const readFiles = files.filter((file) => file.kind === "read");
  const artifacts = sessionWorkspace.list?.artifacts ?? [];
  const browser = sessionWorkspace.list?.browser ?? null;
  const hasSessionItems = files.length > 0 || artifacts.length > 0;
  const hasBrowserItems = (browser?.entries.length ?? 0) > 0;
  const hasItems = hasSessionItems || hasBrowserItems;
  const renderPathActions = (
    path: string,
    options: { preview?: boolean } = {},
  ): TemplateResult => html`
    <span
      class="chat-workspace-rail__row-actions"
      role="group"
      aria-label=${t("chat.workspaceFiles.actions")}
    >
      ${options.preview === false
        ? nothing
        : html`<button
            class="chat-workspace-rail__row-action"
            type="button"
            title=${t("chat.workspaceFiles.preview")}
            aria-label=${t("chat.workspaceFiles.preview")}
            @click=${(event: Event) => {
              event.stopPropagation();
              sessionWorkspace.onOpenFile(path);
            }}
          >
            ${icons.eye}
          </button>`}
      <button
        class="chat-workspace-rail__row-action"
        type="button"
        title=${t("chat.workspaceFiles.copyPath")}
        aria-label=${t("chat.workspaceFiles.copyPath")}
        @click=${(event: Event) => {
          event.stopPropagation();
          sessionWorkspace.onCopyPath(path);
        }}
      >
        ${icons.copy}
      </button>
    </span>
  `;
  const renderSessionSummary = (): TemplateResult | typeof nothing => {
    if (!sessionWorkspace.list) {
      return nothing;
    }
    const browserCount = browser?.entries.length ?? 0;
    return html`
      <div class="chat-workspace-rail__summary" aria-label=${t("chat.workspaceFiles.summary")}>
        <span
          >${t("chat.workspaceFiles.changedCount", { count: String(modifiedFiles.length) })}</span
        >
        <span>${t("chat.workspaceFiles.readCount", { count: String(readFiles.length) })}</span>
        <span>${t("chat.workspaceFiles.artifactCount", { count: String(artifacts.length) })}</span>
        <span>${t("chat.workspaceFiles.browserCount", { count: String(browserCount) })}</span>
      </div>
    `;
  };
  const renderFileRows = (rows: typeof files): TemplateResult | typeof nothing =>
    rows.length === 0
      ? nothing
      : html`
          <div class="chat-workspace-rail__list" role="list">
            ${rows.map((file) => {
              const size = formatWorkspaceFileSize(file);
              const itemId = `file:${file.path}`;
              const isActive = itemId === sessionWorkspace.activeId;
              return html`
                <div
                  class="chat-workspace-rail__file ${isActive
                    ? "chat-workspace-rail__file--active"
                    : ""}"
                  role="listitem"
                  title=${file.path || file.name}
                >
                  <button
                    class="chat-workspace-rail__file-open"
                    type="button"
                    @click=${() => sessionWorkspace.onOpenFile(file.path)}
                  >
                    <span class="chat-workspace-rail__file-icon">${icons.fileText}</span>
                    <span class="chat-workspace-rail__file-main">
                      <span class="chat-workspace-rail__file-name">${file.path || file.name}</span>
                      ${size
                        ? html`<span class="chat-workspace-rail__file-meta">${size}</span>`
                        : nothing}
                    </span>
                  </button>
                  ${file.missing
                    ? html`<span class="chat-workspace-rail__file-badge"
                        >${t("chat.workspaceFiles.missing")}</span
                      >`
                    : nothing}
                  ${renderPathActions(file.path)}
                </div>
              `;
            })}
          </div>
        `;
  const renderBrowserBadge = (
    sessionKind: "modified" | "read" | "mixed" | undefined,
  ): TemplateResult | typeof nothing => {
    if (!sessionKind) {
      return nothing;
    }
    const label =
      sessionKind === "modified"
        ? t("chat.workspaceFiles.changed")
        : sessionKind === "read"
          ? t("chat.workspaceFiles.read")
          : t("chat.workspaceFiles.session");
    return html`<span class="chat-workspace-rail__file-badge">${label}</span>`;
  };
  const renderBrowserBreadcrumbs = (): TemplateResult | typeof nothing => {
    if (!browser || browser.search) {
      return nothing;
    }
    const parts = browser.path ? browser.path.split("/").filter(Boolean) : [];
    let currentPath = "";
    return html`
      <div class="chat-workspace-rail__breadcrumbs" aria-label=${t("chat.workspaceFiles.path")}>
        <button
          class="chat-workspace-rail__crumb"
          type="button"
          @click=${() => sessionWorkspace.onBrowsePath("")}
        >
          ${t("chat.workspaceFiles.root")}
        </button>
        ${parts.map((part) => {
          currentPath = currentPath ? `${currentPath}/${part}` : part;
          const pathForPart = currentPath;
          return html`
            <span class="chat-workspace-rail__crumb-separator">/</span>
            <button
              class="chat-workspace-rail__crumb"
              type="button"
              @click=${() => sessionWorkspace.onBrowsePath(pathForPart)}
            >
              ${part}
            </button>
          `;
        })}
      </div>
    `;
  };
  const renderBrowserRows = (): TemplateResult => {
    const entries = browser?.entries ?? [];
    const parentPath = browser?.parentPath;
    return html`
      <section class="chat-workspace-rail__browser">
        <div class="chat-workspace-rail__browser-tools">
          <label class="chat-workspace-rail__search">
            <span class="chat-workspace-rail__search-icon" aria-hidden="true">${icons.search}</span>
            <input
              type="search"
              placeholder=${t("chat.workspaceFiles.search")}
              aria-label=${t("chat.workspaceFiles.search")}
              .value=${browser?.search ?? ""}
              @input=${(event: Event) => {
                const target = event.target as HTMLInputElement;
                sessionWorkspace.onSearch(target.value);
              }}
            />
          </label>
        </div>
        ${renderBrowserBreadcrumbs()}
        ${browser?.search
          ? html`<div class="chat-workspace-rail__browser-caption">
              ${t("chat.workspaceFiles.searchResults")}
            </div>`
          : nothing}
        <div class="chat-workspace-rail__list chat-workspace-rail__list--browser" role="list">
          ${!browser?.search && parentPath != null
            ? html`
                <div
                  class="chat-workspace-rail__file chat-workspace-rail__file--directory"
                  role="listitem"
                >
                  <button
                    class="chat-workspace-rail__file-open"
                    type="button"
                    @click=${() => sessionWorkspace.onBrowsePath(parentPath)}
                  >
                    <span class="chat-workspace-rail__file-icon">${icons.folder}</span>
                    <span class="chat-workspace-rail__file-main">
                      <span class="chat-workspace-rail__file-name">..</span>
                      <span class="chat-workspace-rail__file-meta"
                        >${t("chat.workspaceFiles.parentFolder")}</span
                      >
                    </span>
                  </button>
                </div>
              `
            : nothing}
          ${entries.length === 0
            ? html`<div class="chat-workspace-rail__state">
                ${browser?.search
                  ? t("chat.workspaceFiles.noSearchResults")
                  : t("chat.workspaceFiles.noBrowserFiles")}
              </div>`
            : entries.map((entry) => {
                const size = entry.kind === "file" ? formatWorkspaceFileSize(entry) : "";
                const itemId = `file:${entry.path}`;
                const isActive = itemId === sessionWorkspace.activeId;
                const canPreview = entry.kind === "file" && Boolean(entry.sessionKind);
                return html`
                  <div
                    class="chat-workspace-rail__file ${entry.kind === "directory"
                      ? "chat-workspace-rail__file--directory"
                      : ""} ${isActive ? "chat-workspace-rail__file--active" : ""}"
                    role="listitem"
                    title=${entry.path || entry.name}
                  >
                    <button
                      class="chat-workspace-rail__file-open"
                      type="button"
                      ?disabled=${entry.kind === "file" && !canPreview}
                      @click=${() =>
                        entry.kind === "directory"
                          ? sessionWorkspace.onBrowsePath(entry.path)
                          : canPreview
                            ? sessionWorkspace.onOpenFile(entry.path)
                            : undefined}
                    >
                      <span class="chat-workspace-rail__file-icon"
                        >${entry.kind === "directory" ? icons.folder : icons.fileText}</span
                      >
                      <span class="chat-workspace-rail__file-main">
                        <span class="chat-workspace-rail__file-name">${entry.name}</span>
                        <span class="chat-workspace-rail__file-meta">
                          ${entry.kind === "directory"
                            ? entry.path || t("chat.workspaceFiles.root")
                            : [entry.path, size].filter(Boolean).join(" / ")}
                        </span>
                      </span>
                    </button>
                    ${renderBrowserBadge(entry.sessionKind)}
                    ${entry.kind === "file"
                      ? renderPathActions(entry.path, { preview: canPreview })
                      : nothing}
                  </div>
                `;
              })}
        </div>
        ${browser?.truncated
          ? html`<div class="chat-workspace-rail__state">
              ${t("chat.workspaceFiles.truncated")}
            </div>`
          : nothing}
      </section>
    `;
  };
  const renderArtifactRows = (): TemplateResult | typeof nothing =>
    artifacts.length === 0
      ? nothing
      : html`
          <div class="chat-workspace-rail__list" role="list">
            ${artifacts.map((artifact) => {
              const size = renderWorkspaceArtifactSize(artifact);
              const itemId = `artifact:${artifact.id}`;
              const isActive = itemId === sessionWorkspace.activeId;
              const isImage = artifact.mimeType?.startsWith("image/");
              return html`
                <div
                  class="chat-workspace-rail__file ${isActive
                    ? "chat-workspace-rail__file--active"
                    : ""}"
                  role="listitem"
                  title=${artifact.title}
                >
                  <button
                    class="chat-workspace-rail__file-open"
                    type="button"
                    @click=${() => sessionWorkspace.onOpenArtifact(artifact.id)}
                  >
                    <span class="chat-workspace-rail__file-icon"
                      >${isImage ? icons.image : icons.paperclip}</span
                    >
                    <span class="chat-workspace-rail__file-main">
                      <span class="chat-workspace-rail__file-name">${artifact.title}</span>
                      ${size || artifact.mimeType
                        ? html`<span class="chat-workspace-rail__file-meta"
                            >${[artifact.mimeType, size].filter(Boolean).join(" / ")}</span
                          >`
                        : nothing}
                    </span>
                  </button>
                  <span class="chat-workspace-rail__row-actions">
                    <button
                      class="chat-workspace-rail__row-action"
                      type="button"
                      title=${t("chat.workspaceFiles.preview")}
                      aria-label=${t("chat.workspaceFiles.preview")}
                      @click=${(event: Event) => {
                        event.stopPropagation();
                        sessionWorkspace.onOpenArtifact(artifact.id);
                      }}
                    >
                      ${icons.eye}
                    </button>
                  </span>
                </div>
              `;
            })}
          </div>
        `;
  return html`
    <aside class="chat-workspace-rail" aria-label=${t("chat.workspaceFiles.label")}>
      <div class="chat-workspace-rail__header">
        <div class="chat-workspace-rail__title">
          <span class="chat-workspace-rail__eyebrow">${t("chat.workspaceFiles.workspace")}</span>
          <strong>${t("chat.workspaceFiles.files")}</strong>
        </div>
        <div class="chat-workspace-rail__actions">
          <button
            class="btn btn--ghost btn--sm chat-workspace-rail__refresh"
            type="button"
            title=${t("chat.workspaceFiles.refresh")}
            aria-label=${t("chat.workspaceFiles.refresh")}
            ?disabled=${sessionWorkspace.loading}
            @click=${sessionWorkspace.onRefresh}
          >
            ${icons.refresh}
          </button>
          <button
            type="button"
            class="nav-collapse-toggle chat-workspace-rail__collapse-toggle"
            title=${t("chat.workspaceFiles.collapse")}
            aria-label=${t("chat.workspaceFiles.collapse")}
            aria-expanded="true"
            @click=${sessionWorkspace.onToggleCollapsed}
          >
            <span class="nav-collapse-toggle__icon" aria-hidden="true"
              >${icons.panelRightClose}</span
            >
          </button>
        </div>
      </div>
      ${sessionWorkspace.list?.root
        ? html`<div class="chat-workspace-rail__path" title=${sessionWorkspace.list.root}>
            ${sessionWorkspace.list.root}
          </div>`
        : nothing}
      ${renderSessionSummary()}
      ${sessionWorkspace.error
        ? html`<div class="chat-workspace-rail__state chat-workspace-rail__state--error">
            ${sessionWorkspace.error}
          </div>`
        : sessionWorkspace.loading && !hasItems
          ? html`<div class="chat-workspace-rail__state">${t("chat.workspaceFiles.loading")}</div>`
          : html`
              <div class="chat-workspace-rail__scroll">
                ${!hasSessionItems
                  ? html`<div class="chat-workspace-rail__state">
                      ${t("chat.workspaceFiles.empty")}
                    </div>`
                  : html`
                      ${renderWorkspaceRailSection(
                        t("chat.workspaceFiles.changed"),
                        renderFileRows(modifiedFiles),
                      )}
                      ${renderWorkspaceRailSection(
                        t("chat.workspaceFiles.read"),
                        renderFileRows(readFiles),
                      )}
                      ${renderWorkspaceRailSection(
                        t("chat.workspaceFiles.artifacts"),
                        renderArtifactRows(),
                      )}
                    `}
                ${renderWorkspaceRailSection(
                  t("chat.workspaceFiles.browser"),
                  browser ? renderBrowserRows() : nothing,
                )}
              </div>
            `}
    </aside>
  `;
}

function resetSlashMenuState(): void {
  vs.slashMenuMode = "command";
  vs.slashMenuCommand = null;
  vs.slashMenuArgItems = [];
  vs.slashMenuItems = [];
  vs.slashMenuExpanded = false;
}

function hasVisibleSlashMenuState(): boolean {
  return (
    vs.slashMenuOpen ||
    vs.slashMenuMode !== "command" ||
    vs.slashMenuCommand !== null ||
    vs.slashMenuArgItems.length > 0 ||
    vs.slashMenuItems.length > 0 ||
    vs.slashMenuExpanded
  );
}

function closeSlashMenuIfNeeded(requestUpdate: () => void): void {
  if (!hasVisibleSlashMenuState()) {
    return;
  }
  vs.slashMenuOpen = false;
  resetSlashMenuState();
  requestUpdate();
}

function requestSlashCommandRefresh(
  value: string,
  props: ChatProps,
  requestUpdate: () => void,
  getCurrentValue?: () => string,
): void {
  if (!props.onSlashIntent || vs.slashCommandRefreshPending) {
    return;
  }
  const refresh = props.onSlashIntent();
  if (!refresh || typeof refresh.then !== "function") {
    return;
  }
  vs.slashCommandRefreshPending = true;
  void Promise.resolve(refresh).finally(() => {
    vs.slashCommandRefreshPending = false;
    const nextValue = getCurrentValue?.() ?? props.getDraft?.() ?? value;
    if (!nextValue.startsWith("/")) {
      closeSlashMenuIfNeeded(requestUpdate);
      return;
    }
    updateSlashMenu(nextValue, requestUpdate, props, { skipSlashIntent: true });
  });
}

function updateSlashMenu(
  value: string,
  requestUpdate: () => void,
  props: ChatProps,
  opts: { skipSlashIntent?: boolean } = {},
  getCurrentValue?: () => string,
): void {
  // Arg mode: /command <partial-arg>
  const argMatch = value.match(/^\/(\S+)\s(.*)$/);
  if (argMatch) {
    if (!opts.skipSlashIntent) {
      requestSlashCommandRefresh(value, props, requestUpdate, getCurrentValue);
    }
    const cmdName = argMatch[1].toLowerCase();
    const argFilter = argMatch[2].toLowerCase();
    const cmd = SLASH_COMMANDS.find((c) => c.name === cmdName);
    if (cmd?.argOptions?.length) {
      const filtered = argFilter
        ? cmd.argOptions.filter((opt) => opt.toLowerCase().startsWith(argFilter))
        : cmd.argOptions;
      if (filtered.length > 0) {
        vs.slashMenuMode = "args";
        vs.slashMenuCommand = cmd;
        vs.slashMenuArgItems = filtered;
        vs.slashMenuOpen = true;
        vs.slashMenuIndex = 0;
        vs.slashMenuItems = [];
        requestUpdate();
        return;
      }
    }
    closeSlashMenuIfNeeded(requestUpdate);
    return;
  }

  // Command mode: /partial-command
  const match = value.match(/^\/(\S*)$/);
  if (match) {
    if (!opts.skipSlashIntent) {
      requestSlashCommandRefresh(value, props, requestUpdate, getCurrentValue);
    }
    const items = getSlashCommandCompletions(match[1], { showAll: vs.slashMenuExpanded });
    vs.slashMenuItems = items;
    vs.slashMenuOpen = items.length > 0;
    vs.slashMenuIndex = 0;
    vs.slashMenuMode = "command";
    vs.slashMenuCommand = null;
    vs.slashMenuArgItems = [];
  } else {
    closeSlashMenuIfNeeded(requestUpdate);
    return;
  }
  requestUpdate();
}

function selectSlashCommand(
  cmd: SlashCommandDef,
  props: ChatProps,
  requestUpdate: () => void,
): void {
  // Transition to arg picker when the command has fixed options
  if (cmd.argOptions?.length) {
    commitComposerDraft(props, `/${cmd.name} `);
    vs.slashMenuMode = "args";
    vs.slashMenuCommand = cmd;
    vs.slashMenuArgItems = cmd.argOptions;
    vs.slashMenuOpen = true;
    vs.slashMenuIndex = 0;
    vs.slashMenuItems = [];
    requestUpdate();
    return;
  }

  vs.slashMenuOpen = false;
  resetSlashMenuState();

  if (cmd.executeLocal && !cmd.args) {
    commitComposerDraft(props, `/${cmd.name}`);
    requestUpdate();
    props.onSend();
  } else {
    commitComposerDraft(props, `/${cmd.name} `);
    requestUpdate();
  }
}

function tabCompleteSlashCommand(
  cmd: SlashCommandDef,
  props: ChatProps,
  requestUpdate: () => void,
): void {
  // Tab: fill in the command text without executing
  if (cmd.argOptions?.length) {
    commitComposerDraft(props, `/${cmd.name} `);
    vs.slashMenuMode = "args";
    vs.slashMenuCommand = cmd;
    vs.slashMenuArgItems = cmd.argOptions;
    vs.slashMenuOpen = true;
    vs.slashMenuIndex = 0;
    vs.slashMenuItems = [];
    requestUpdate();
    return;
  }

  vs.slashMenuOpen = false;
  resetSlashMenuState();
  commitComposerDraft(props, cmd.args ? `/${cmd.name} ` : `/${cmd.name}`);
  requestUpdate();
}

function selectSlashArg(
  arg: string,
  props: ChatProps,
  requestUpdate: () => void,
  execute: boolean,
): void {
  const cmdName = vs.slashMenuCommand?.name ?? "";
  vs.slashMenuOpen = false;
  resetSlashMenuState();
  commitComposerDraft(props, `/${cmdName} ${arg}`);
  requestUpdate();
  if (execute) {
    props.onSend();
  }
}

function slashOptionIdSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "item"
  );
}

function getSlashCommandOptionId(cmd: SlashCommandDef): string {
  return `chat-slash-option-command-${slashOptionIdSegment(cmd.name)}`;
}

function getSlashArgOptionId(commandName: string, arg: string): string {
  return `chat-slash-option-arg-${slashOptionIdSegment(commandName)}-${slashOptionIdSegment(arg)}`;
}

function isSlashMenuVisible(): boolean {
  if (!vs.slashMenuOpen) {
    return false;
  }
  if (vs.slashMenuMode === "args") {
    return Boolean(vs.slashMenuCommand && vs.slashMenuArgItems.length > 0);
  }
  return vs.slashMenuItems.length > 0;
}

function getActiveSlashMenuOptionId(): string | null {
  if (!isSlashMenuVisible()) {
    return null;
  }
  if (vs.slashMenuMode === "args") {
    const commandName = vs.slashMenuCommand?.name;
    const arg = vs.slashMenuArgItems[vs.slashMenuIndex];
    return commandName && arg ? getSlashArgOptionId(commandName, arg) : null;
  }
  const cmd = vs.slashMenuItems[vs.slashMenuIndex];
  return cmd ? getSlashCommandOptionId(cmd) : null;
}

function getActiveSlashMenuOptionLabel(): string {
  if (!isSlashMenuVisible()) {
    return "";
  }
  if (vs.slashMenuMode === "args") {
    const commandName = vs.slashMenuCommand?.name;
    const arg = vs.slashMenuArgItems[vs.slashMenuIndex];
    return commandName && arg ? `/${commandName} ${arg}` : "";
  }
  const cmd = vs.slashMenuItems[vs.slashMenuIndex];
  if (!cmd) {
    return "";
  }
  const command = `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}`;
  return `${command} ${cmd.description}`;
}

function tokenEstimate(draft: string): string | null {
  if (draft.length < 100) {
    return null;
  }
  return `~${Math.ceil(draft.length / 4)} tokens`;
}

/**
 * Export chat markdown - delegates to shared utility.
 */
function exportMarkdown(props: ChatProps): void {
  exportChatMarkdown(props.messages, props.assistantName);
}

function workItemKindLabel(kind: WorkSurfaceItem["kind"]): string {
  switch (kind) {
    case "chat_run":
      return "Chat";
    case "queued_message":
      return "Queue";
    case "task":
      return "Task";
    case "active_session":
      return "Session";
    default:
      return "Work";
  }
}

function closeDetailsOnEscape(event: KeyboardEvent, onClose?: () => void) {
  if (event.key !== "Escape") {
    return;
  }
  const details = event.currentTarget;
  if (!(details instanceof HTMLDetailsElement) || !details.open) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  details.open = false;
  onClose?.();
}

function renderWorkItemActions(props: ChatProps, item: WorkSurfaceItem) {
  return html`
    ${item.actions.includes("stop_run") && props.onAbort
      ? html`<button
          class="btn btn--sm"
          type="button"
          aria-label=${`Stop ${item.title}`}
          @click=${props.onAbort}
        >
          Stop
        </button>`
      : nothing}
    ${item.actions.includes("remove_queue")
      ? html`
          <button
            class="btn btn--sm"
            type="button"
            aria-label=${`Remove queued message ${item.title}`}
            @click=${() => props.onQueueRemove(item.id.replace(/^queued:/, ""))}
          >
            Remove
          </button>
        `
      : nothing}
    ${item.actions.includes("open_session") && item.sessionKey && props.onSessionSelect
      ? html`
          <button
            class="btn btn--sm"
            type="button"
            aria-label=${`Open session ${item.title}`}
            @click=${() => props.onSessionSelect?.(item.sessionKey!)}
          >
            Open
          </button>
        `
      : nothing}
    ${item.actions.includes("cancel_task") && item.taskId && props.onWorkTaskCancel
      ? html`
          <button
            class="btn btn--sm"
            type="button"
            aria-label=${`Cancel task ${item.title}`}
            @click=${() => props.onWorkTaskCancel?.(item.taskId!)}
          >
            Cancel
          </button>
        `
      : nothing}
  `;
}

function renderAgentWorkTreeActions(props: ChatProps, node: AgentWorkTreeNode) {
  return html`
    ${node.actions.includes("open_session") && props.onSessionSelect
      ? html`
          <button
            class="btn btn--sm"
            type="button"
            aria-label=${`Open child session ${node.title}`}
            @click=${() => props.onSessionSelect?.(node.sessionKey)}
          >
            Open
          </button>
        `
      : nothing}
    ${node.actions.includes("cancel_task") && node.taskId && props.onWorkTaskCancel
      ? html`
          <button
            class="btn btn--sm"
            type="button"
            aria-label=${`Cancel child task ${node.title}`}
            @click=${() => props.onWorkTaskCancel?.(node.taskId!)}
          >
            Cancel
          </button>
        `
      : nothing}
  `;
}

function renderAgentWorkTree(props: ChatProps, tree: AgentWorkTreeSnapshot) {
  const nodes = tree.flat;
  if (nodes.length === 0) {
    return html`
      <section class="chat-agent-work-tree" aria-label="Agent Work Tree">
        <div class="chat-agent-work-tree__header">
          <div>
            <h4>Agent Work Tree</h4>
            <p>No child agents running.</p>
          </div>
        </div>
        <div class="chat-agent-work-tree__empty">No child agents running.</div>
      </section>
    `;
  }

  return html`
    <section class="chat-agent-work-tree" aria-label="Agent Work Tree">
      <div class="chat-agent-work-tree__header">
        <div>
          <h4>Agent Work Tree</h4>
          <p>
            ${tree.activeChildCount > 0
              ? `${tree.activeChildCount} active child ${tree.activeChildCount === 1 ? "agent" : "agents"}.`
              : "Child agents are idle."}
          </p>
        </div>
      </div>
      <div class="chat-agent-work-tree__list" role="list">
        ${nodes.map(
          (node) => html`
            <article
              class="chat-agent-work-tree__node ${node.isActive
                ? "chat-agent-work-tree__node--active"
                : ""}"
              data-agent-work-tree-node=${node.sessionKey}
              role="listitem"
              style=${`--agent-work-depth: ${node.depth};`}
            >
              <div class="chat-agent-work-tree__rail" aria-hidden="true"></div>
              <div class="chat-agent-work-tree__main">
                <div class="chat-agent-work-tree__topline">
                  <span>${node.depth === 0 ? "Parent" : "Child agent"}</span>
                  <strong>${node.status}</strong>
                  ${node.activeDescendants > 0
                    ? html`<em>${node.activeDescendants} active below</em>`
                    : nothing}
                </div>
                <div class="chat-agent-work-tree__title">${node.title}</div>
                ${node.detail
                  ? html`<div class="chat-agent-work-tree__detail">${node.detail}</div>`
                  : nothing}
                <div class="chat-agent-work-tree__meta">
                  <span>${node.sessionKey}</span>
                </div>
              </div>
              <div class="chat-agent-work-tree__actions">
                ${renderAgentWorkTreeActions(props, node)}
              </div>
            </article>
          `,
        )}
      </div>
    </section>
  `;
}

function renderWorkingNow(props: ChatProps, items: WorkSurfaceItem[], tree: AgentWorkTreeSnapshot) {
  const hasItems = hasActiveWork(items);
  const hasTree = tree.flat.length > 0;
  const visibleCount = items.length + tree.childCount;
  const hasActiveWorkVisible = hasItems || tree.activeChildCount > 0;
  const hasError = Boolean(props.workTasksError);
  const summaryLabel = hasActiveWorkVisible
    ? "Working"
    : hasError
      ? "Work status unavailable"
      : props.workTasksLoading
        ? "Checking work…"
        : "Nothing running";
  return html`
    <details class="chat-work-surface" data-chat-work-surface @keydown=${closeDetailsOnEscape}>
      <summary
        class="chat-work-surface__summary"
        role="button"
        aria-label=${`Working Now: ${summaryLabel}`}
      >
        <span
          class="chat-work-surface__dot ${hasItems ? "chat-work-surface__dot--active" : ""}"
          aria-hidden="true"
        ></span>
        <span>${summaryLabel}</span>
        ${visibleCount > 0 ? html`<strong>${visibleCount}</strong>` : nothing}
      </summary>
      <div class="chat-work-surface__panel" role="region" aria-label="Working Now">
        <div class="chat-work-surface__header">
          <div>
            <h3>Working Now</h3>
            <p>
              ${hasItems || hasTree
                ? "Current OpenClaw work and child agents."
                : "Nothing is running."}
            </p>
          </div>
        </div>
        ${hasError
          ? html`<div class="chat-work-surface__error">Work status unavailable</div>`
          : nothing}
        ${hasItems
          ? html`
              <div class="chat-work-surface__list" role="list">
                ${items.map(
                  (item) => html`
                    <article
                      class="chat-work-surface__item"
                      data-work-kind=${item.kind}
                      role="listitem"
                    >
                      <div class="chat-work-surface__item-main">
                        <div class="chat-work-surface__item-topline">
                          <span>${workItemKindLabel(item.kind)}</span>
                          <strong>${item.status}</strong>
                        </div>
                        <div class="chat-work-surface__item-title">${item.title}</div>
                        ${item.detail
                          ? html`<div class="chat-work-surface__item-detail">${item.detail}</div>`
                          : nothing}
                        ${item.projectId || item.sessionKey
                          ? html`
                              <div class="chat-work-surface__item-meta">
                                ${item.projectId
                                  ? html`<span>Project ${item.projectId}</span>`
                                  : nothing}
                                ${item.sessionKey ? html`<span>${item.sessionKey}</span>` : nothing}
                              </div>
                            `
                          : nothing}
                      </div>
                      <div class="chat-work-surface__actions">
                        ${renderWorkItemActions(props, item)}
                      </div>
                    </article>
                  `,
                )}
              </div>
            `
          : html`<div class="chat-work-surface__empty">Nothing is running.</div>`}
        ${renderAgentWorkTree(props, tree)}
      </div>
    </details>
  `;
}

function renderControlDirectorDiagnosticsCard(session: GatewaySessionRow | undefined) {
  const summary = summarizeControlDirectorDiagnostics(session);
  if (!summary.hasDiagnostics) {
    return nothing;
  }
  return html`
    <section
      class="chat-control-director-diagnostics chat-control-director-diagnostics--${summary.tone}"
      data-control-director-diagnostics
      aria-label="Truth and completion diagnostics"
    >
      <div class="chat-control-director-diagnostics__header">
        <div>
          <div class="chat-control-director-diagnostics__eyebrow">Control Director</div>
          <h3>${summary.title}</h3>
        </div>
        <span class="chat-control-director-diagnostics__status">${summary.status}</span>
      </div>
      <p class="chat-control-director-diagnostics__summary">${summary.detail}</p>
      ${summary.details.length > 0
        ? html`
            <dl class="chat-control-director-diagnostics__grid">
              ${summary.details.slice(0, 16).map(
                (detail) => html`
                  <div>
                    <dt>${detail.label}</dt>
                    <dd>${detail.value}</dd>
                  </div>
                `,
              )}
            </dl>
          `
        : nothing}
    </section>
  `;
}

function formatChatApprovalRemaining(ms: number): string {
  const remaining = Math.max(0, ms);
  const totalSeconds = Math.floor(remaining / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function renderChatApprovalMetaRow(
  label: string,
  value?: string | null,
  opts?: { path?: boolean },
) {
  if (!value) {
    return nothing;
  }
  const displayValue = opts?.path ? formatApprovalDisplayPath(value) : value;
  return html`<div class="chat-approval-card__meta-row">
    <span>${label}</span><span>${displayValue}</span>
  </div>`;
}

function renderChatApprovalCommandWithSpans(request: ExecApprovalRequestPayload) {
  const commandSpans = [...(request.commandSpans ?? [])]
    .filter(
      (span) =>
        Number.isSafeInteger(span.startIndex) &&
        Number.isSafeInteger(span.endIndex) &&
        span.startIndex >= 0 &&
        span.endIndex > span.startIndex &&
        span.endIndex <= request.command.length,
    )
    .toSorted((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex);
  const accepted: typeof commandSpans = [];
  let cursor = 0;
  for (const span of commandSpans) {
    if (span.startIndex < cursor) {
      continue;
    }
    accepted.push(span);
    cursor = span.endIndex;
  }
  if (accepted.length === 0) {
    return html`<div class="chat-approval-card__command mono">${request.command}</div>`;
  }
  const parts: Array<string | TemplateResult> = [];
  cursor = 0;
  for (const span of accepted) {
    if (span.startIndex > cursor) {
      parts.push(request.command.slice(cursor, span.startIndex));
    }
    parts.push(
      html`<mark class="chat-approval-card__command-span"
        >${request.command.slice(span.startIndex, span.endIndex)}</mark
      >`,
    );
    cursor = span.endIndex;
  }
  if (cursor < request.command.length) {
    parts.push(request.command.slice(cursor));
  }
  return html`<div class="chat-approval-card__command mono">${parts}</div>`;
}

function renderChatExecApprovalBody(request: ExecApprovalRequestPayload) {
  return html`
    ${renderChatApprovalCommandWithSpans(request)}
    <div class="chat-approval-card__meta">
      ${renderChatApprovalMetaRow("Host", request.host)}
      ${renderChatApprovalMetaRow("Agent", request.agentId)}
      ${renderChatApprovalMetaRow("Session", request.sessionKey)}
      ${renderChatApprovalMetaRow("Working folder", request.cwd, { path: true })}
      ${renderChatApprovalMetaRow("Resolved path", request.resolvedPath, { path: true })}
      ${renderChatApprovalMetaRow("Security", request.security)}
      ${renderChatApprovalMetaRow("Ask mode", request.ask)}
    </div>
  `;
}

function resolveChatApprovalTitle(active: ExecApprovalRequest): string {
  if (active.kind === "exec") {
    return "Exec approval needed";
  }
  if (active.kind === "network") {
    return "Network approval needed";
  }
  if (active.kind === "remote_proof") {
    return "Remote proof approval needed";
  }
  return active.pluginTitle ?? "Plugin approval needed";
}

function resolveChatApprovalKindLabel(active: ExecApprovalRequest): string {
  if (active.kind === "network") {
    return "Network";
  }
  if (active.kind === "remote_proof") {
    return "Remote proof";
  }
  return active.kind === "plugin" ? "Plugin" : "Exec";
}

function resolveChatApprovalSourceLabel(active: ExecApprovalRequest): string {
  if (active.kind === "network") {
    return "Network source";
  }
  if (active.kind === "remote_proof") {
    return "Proof source";
  }
  return "Plugin";
}

function renderChatPluginBackedApprovalBody(active: ExecApprovalRequest) {
  return html`
    ${active.pluginDescription
      ? html`<pre class="chat-approval-card__command mono">${active.pluginDescription}</pre>`
      : nothing}
    <div class="chat-approval-card__meta">
      ${renderChatApprovalMetaRow("Severity", active.pluginSeverity)}
      ${renderChatApprovalMetaRow(resolveChatApprovalSourceLabel(active), active.pluginId)}
      ${renderChatApprovalMetaRow("Agent", active.request.agentId)}
      ${renderChatApprovalMetaRow("Session", active.request.sessionKey)}
    </div>
  `;
}

function renderChatApprovalCard(props: ChatProps) {
  const active = props.execApprovalQueue?.[0];
  if (!active) {
    return nothing;
  }
  const isExec = active.kind === "exec";
  const queueCount = props.execApprovalQueue?.length ?? 1;
  const remainingMs = active.expiresAtMs - Date.now();
  const remaining =
    remainingMs > 0 ? `Expires in ${formatChatApprovalRemaining(remainingMs)}` : "Approval expired";
  const title = resolveChatApprovalTitle(active);
  const summaryDetail = isExec
    ? active.request.command
    : (active.pluginTitle ?? active.request.command);
  const busy = Boolean(props.execApprovalBusy);
  const decide = (decision: "allow-once" | "allow-always" | "deny") => {
    if (!busy) {
      void props.onExecApprovalDecision?.(decision);
    }
  };
  return html`
    <details
      class="chat-approval-card"
      data-chat-approval-card
      data-approval-kind=${active.kind}
      open
      @keydown=${closeDetailsOnEscape}
    >
      <summary
        class="chat-approval-card__summary"
        role="button"
        aria-label=${`${title}: ${summaryDetail}`}
      >
        <span class="chat-approval-card__dot" aria-hidden="true"></span>
        <span class="chat-approval-card__kicker">Approval needed</span>
        <strong>${summaryDetail}</strong>
        ${queueCount > 1
          ? html`<span class="chat-approval-card__count">${queueCount} pending</span>`
          : nothing}
      </summary>
      <div class="chat-approval-card__panel" role="region" aria-label="Approval needed">
        <div class="chat-approval-card__header">
          <div>
            <h3>${title}</h3>
            <p>${remaining}</p>
          </div>
          <span class="chat-approval-card__kind">${resolveChatApprovalKindLabel(active)}</span>
        </div>
        ${isExec
          ? renderChatExecApprovalBody(active.request)
          : renderChatPluginBackedApprovalBody(active)}
        ${props.execApprovalError
          ? html`<div class="chat-approval-card__error" role="alert">
              ${props.execApprovalError}
            </div>`
          : nothing}
        <div class="chat-approval-card__actions">
          <button
            class="btn btn--sm primary"
            type="button"
            aria-label="Allow approval once"
            ?disabled=${busy}
            @click=${() => decide("allow-once")}
          >
            Allow once
          </button>
          <button
            class="btn btn--sm"
            type="button"
            aria-label="Always allow this approval"
            ?disabled=${busy}
            @click=${() => decide("allow-always")}
          >
            Always allow
          </button>
          <button
            class="btn btn--sm danger"
            type="button"
            aria-label="Deny approval"
            ?disabled=${busy}
            @click=${() => decide("deny")}
          >
            Deny
          </button>
        </div>
      </div>
    </details>
  `;
}

function activeChatProjects(projectsList: ProjectsListResult | null | undefined): ProjectRecord[] {
  return (projectsList?.projects ?? []).filter((project) => project.archived !== true);
}

function resolveCurrentChatProject(props: ChatProps): {
  projectId: string | null;
  project: ProjectRecord | null;
} {
  const activeSession = props.sessions?.sessions?.find((row) => row.key === props.sessionKey);
  const projectId =
    typeof activeSession?.projectId === "string" && activeSession.projectId.trim()
      ? activeSession.projectId.trim()
      : null;
  if (!projectId) {
    return { projectId: null, project: null };
  }
  const project =
    activeChatProjects(props.projectsList).find((entry) => entry.id === projectId) ?? null;
  return { projectId, project };
}

function renderProjectSummaryLabel(props: ChatProps): string {
  const { project, projectId } = resolveCurrentChatProject(props);
  if (project?.name?.trim()) {
    return project.name.trim();
  }
  if (projectId) {
    return "Project attached";
  }
  return "No Project";
}

function renderProjectPickerActions(
  props: ChatProps,
  project: ProjectRecord,
  currentId: string | null,
) {
  const isCurrent = project.id === currentId;
  return html`
    <div class="chat-project-picker__actions">
      ${isCurrent
        ? html`<span class="chat-project-picker__badge">Attached</span>`
        : html`
            <button
              class="btn btn--sm"
              type="button"
              data-chat-project-action="attach"
              aria-label=${`Attach ${project.name} to this chat`}
              ?disabled=${props.projectBusy}
              @click=${() => props.onProjectAttach?.(project.id)}
            >
              Attach
            </button>
          `}
      <button
        class="btn btn--sm btn--subtle"
        type="button"
        data-chat-project-action="new-chat"
        aria-label=${`Start a new chat in ${project.name}`}
        ?disabled=${props.projectBusy}
        @click=${() => props.onNewProjectChat?.(project.id)}
      >
        New chat
      </button>
    </div>
  `;
}

function renderChatProjectPicker(props: ChatProps) {
  const activeProjects = activeChatProjects(props.projectsList);
  const { projectId } = resolveCurrentChatProject(props);
  const summaryLabel = renderProjectSummaryLabel(props);
  const hasError = Boolean(props.projectError);
  const createDisabled = Boolean(props.projectBusy) || !(props.projectCreateName ?? "").trim();
  return html`
    <details
      class="chat-project-picker"
      data-chat-project-picker
      ?open=${Boolean(props.projectPickerOpen)}
      @keydown=${(event: KeyboardEvent) =>
        closeDetailsOnEscape(event, () => props.onProjectPickerToggle?.(false))}
      @toggle=${(event: Event) => {
        const target = event.currentTarget as HTMLDetailsElement;
        props.onProjectPickerToggle?.(target.open);
      }}
    >
      <summary
        class="chat-project-picker__summary"
        role="button"
        aria-label=${`Project: ${summaryLabel}`}
      >
        <span
          class="chat-project-picker__dot ${projectId ? "chat-project-picker__dot--active" : ""}"
          aria-hidden="true"
        ></span>
        <span class="chat-project-picker__kicker">Project</span>
        <strong>${summaryLabel}</strong>
      </summary>
      <div class="chat-project-picker__panel" role="region" aria-label="Chat project">
        <div class="chat-project-picker__header">
          <div>
            <h3>Project</h3>
            <p>Attach this chat to shared project memory.</p>
          </div>
          <button
            class="btn btn--sm btn--subtle"
            type="button"
            aria-label="Refresh projects"
            ?disabled=${props.projectBusy || props.projectsLoading}
            @click=${() => props.onProjectRefresh?.()}
          >
            Refresh
          </button>
        </div>
        ${hasError
          ? html`<div class="chat-project-picker__error" role="alert">
              <strong>Project status unavailable</strong>
              <span>${props.projectError}</span>
            </div>`
          : nothing}
        ${projectId && props.onProjectDetach
          ? html`
              <button
                class="btn btn--sm chat-project-picker__detach"
                type="button"
                data-chat-project-action="detach"
                aria-label="Detach this chat from its project"
                ?disabled=${props.projectBusy}
                @click=${() => props.onProjectDetach?.()}
              >
                Detach from project
              </button>
            `
          : nothing}
        <div class="chat-project-picker__section">
          <h4>Choose a project</h4>
          ${props.projectsLoading
            ? html`<div class="chat-project-picker__empty">Loading projects…</div>`
            : activeProjects.length > 0
              ? html`
                  <div class="chat-project-picker__list" role="list">
                    ${activeProjects.map(
                      (project) => html`
                        <article class="chat-project-picker__item" role="listitem">
                          <div class="chat-project-picker__item-main">
                            <strong>${project.name}</strong>
                            ${project.description
                              ? html`<p>${project.description}</p>`
                              : html`<p>Use this project for the current chat.</p>`}
                          </div>
                          ${renderProjectPickerActions(props, project, projectId)}
                        </article>
                      `,
                    )}
                  </div>
                `
              : html`<div class="chat-project-picker__empty">No projects yet.</div>`}
        </div>
        <div class="chat-project-picker__section chat-project-picker__create">
          <h4>Create a project</h4>
          <label>
            <span>Name</span>
            <input
              type="text"
              placeholder="Project name"
              .value=${props.projectCreateName ?? ""}
              @input=${(event: Event) =>
                props.onProjectCreateFieldChange?.(
                  "name",
                  (event.currentTarget as HTMLInputElement).value,
                )}
            />
          </label>
          <label>
            <span>Description</span>
            <input
              type="text"
              placeholder="Optional description"
              .value=${props.projectCreateDescription ?? ""}
              @input=${(event: Event) =>
                props.onProjectCreateFieldChange?.(
                  "description",
                  (event.currentTarget as HTMLInputElement).value,
                )}
            />
          </label>
          <label>
            <span>Instructions</span>
            <input
              type="text"
              placeholder="Optional project instructions"
              .value=${props.projectCreateInstructions ?? ""}
              @input=${(event: Event) =>
                props.onProjectCreateFieldChange?.(
                  "instructions",
                  (event.currentTarget as HTMLInputElement).value,
                )}
            />
          </label>
          <button
            class="btn"
            type="button"
            data-chat-project-action="create-and-attach"
            aria-label="Create project and attach this chat"
            ?disabled=${createDisabled}
            @click=${() => props.onProjectCreateAndAttach?.()}
          >
            Create and attach
          </button>
        </div>
      </div>
    </details>
  `;
}

function renderPursueGoal(props: ChatProps) {
  const goal = resolveCurrentChatGoal(props.goalFlows);
  const statusLabel = chatGoalStatusLabel(goal);
  const flowId = goal?.flowId ?? goal?.id ?? "";
  const activeTask =
    goal?.tasks?.find((task) => task.status === "running" || task.status === "queued") ??
    goal?.tasks?.[0];
  const detail =
    goal?.blockedSummary ??
    activeTask?.progressSummary ??
    activeTask?.terminalSummary ??
    goal?.currentStep ??
    (goal ? "Goal is saved in this chat." : "Turn a request into durable work.");
  const startText = (props.goalDraft?.trim() || props.draft.trim()).trim();
  const startDisabled =
    !props.connected ||
    props.sending ||
    Boolean(props.goalBusy) ||
    Boolean(props.canAbort) ||
    !startText;
  const continueDisabled =
    !props.connected ||
    props.sending ||
    Boolean(props.goalBusy) ||
    Boolean(props.canAbort) ||
    !goal ||
    !flowId ||
    !isActiveChatGoal(goal.status) ||
    Boolean(goal.cancelRequestedAt);
  const cancelDisabled =
    !props.connected ||
    Boolean(props.goalBusy) ||
    !goal ||
    !flowId ||
    !isActiveChatGoal(goal.status) ||
    Boolean(goal.cancelRequestedAt);
  return html`
    <details
      class="chat-goal"
      data-chat-goal
      ?open=${props.goalPanelOpen}
      @keydown=${(event: KeyboardEvent) =>
        closeDetailsOnEscape(event, () => props.onGoalPanelToggle?.(false))}
      @toggle=${(event: Event) => {
        const target = event.currentTarget as HTMLDetailsElement;
        props.onGoalPanelToggle?.(target.open);
      }}
    >
      <summary class="chat-goal__summary" aria-label=${`Pursue Goal: ${statusLabel}`}>
        <span class="chat-goal__kicker">Pursue Goal</span>
        <span class="chat-goal__title">${goal?.goal ?? "No goal"}</span>
        <span class="chat-goal__status ${goal ? `chat-goal__status--${goal.status}` : ""}">
          ${statusLabel}
        </span>
      </summary>
      ${props.goalPanelOpen
        ? html`<div class="chat-goal__panel">
            <div class="chat-goal__header">
              <div>
                <h3>Pursue Goal</h3>
                <p>
                  ${goal
                    ? detail
                    : "Create durable work from the current request, then continue it with evidence."}
                </p>
              </div>
              <button
                class="btn btn--subtle btn--sm"
                type="button"
                aria-label="Refresh goal status"
                @click=${() => props.onGoalRefresh?.()}
              >
                Refresh
              </button>
            </div>
            ${props.goalError
              ? html`
                  <div class="callout danger" role="alert">
                    <strong>Goal status unavailable</strong>
                    <span>${props.goalError}</span>
                  </div>
                `
              : nothing}
            ${goal
              ? html`
                  <div class="chat-goal__card">
                    <div>
                      <span class="chat-goal__eyebrow">Current goal</span>
                      <strong>${goal.goal}</strong>
                      <p>${detail}</p>
                    </div>
                    ${activeTask
                      ? html`
                          <div class="chat-goal__meta">
                            <span>Task ${activeTask.status ?? "unknown"}</span>
                            ${activeTask.judgeStatus
                              ? html`<span>Judge ${activeTask.judgeStatus}</span>`
                              : nothing}
                          </div>
                        `
                      : nothing}
                  </div>
                `
              : nothing}
            <label class="chat-goal__field">
              <span>Goal</span>
              <textarea
                rows="2"
                placeholder="Describe what OpenClaw should pursue until verified."
                .value=${props.goalDraft ?? ""}
                @input=${(event: Event) =>
                  props.onGoalDraftChange?.((event.currentTarget as HTMLTextAreaElement).value)}
              ></textarea>
            </label>
            <div class="chat-goal__actions">
              <button
                class="btn primary"
                type="button"
                data-chat-goal-action="start"
                aria-label="Start pursue goal"
                ?disabled=${startDisabled}
                @click=${() => props.onGoalStart?.()}
              >
                Start goal
              </button>
              <button
                class="btn"
                type="button"
                data-chat-goal-action="continue"
                aria-label="Continue pursue goal"
                ?disabled=${continueDisabled}
                @click=${() => props.onGoalContinue?.(flowId)}
              >
                Continue
              </button>
              <button
                class="btn btn--subtle"
                type="button"
                data-chat-goal-action="cancel"
                aria-label="Cancel pursue goal"
                ?disabled=${cancelDisabled}
                @click=${() => props.onGoalCancel?.(flowId)}
              >
                Cancel
              </button>
            </div>
            ${props.goalLoading
              ? html`<div class="chat-goal__loading">Loading goal status...</div>`
              : nothing}
          </div>`
        : nothing}
    </details>
  `;
}

function renderSearchBar(requestUpdate: () => void): TemplateResult | typeof nothing {
  if (!vs.searchOpen) {
    return nothing;
  }
  return html`
    <div class="agent-chat__search-bar">
      ${icons.search}
      <input
        type="text"
        placeholder="Search messages..."
        aria-label="Search messages"
        .value=${vs.searchQuery}
        @input=${(e: Event) => {
          vs.searchQuery = (e.target as HTMLInputElement).value;
          requestUpdate();
        }}
      />
      <button
        class="btn btn--ghost"
        aria-label="Close search"
        @click=${() => {
          vs.searchOpen = false;
          vs.searchQuery = "";
          requestUpdate();
        }}
      >
        ${icons.x}
      </button>
    </div>
  `;
}

function renderPinnedSection(
  props: ChatProps,
  pinned: PinnedMessages,
  requestUpdate: () => void,
): TemplateResult | typeof nothing {
  const userRoleLabel = resolveLocalUserName({
    name: props.userName ?? null,
    avatar: props.userAvatar ?? null,
  });
  const messages = Array.isArray(props.messages) ? props.messages : [];
  const entries: Array<{ index: number; text: string; role: string }> = [];
  for (const idx of pinned.indices) {
    const msg = messages[idx] as Record<string, unknown> | undefined;
    if (!msg) {
      continue;
    }
    const text = getPinnedMessageSummary(msg);
    const role = typeof msg.role === "string" ? msg.role : "unknown";
    entries.push({ index: idx, text, role });
  }
  if (entries.length === 0) {
    return nothing;
  }
  return html`
    <div class="agent-chat__pinned">
      <button
        class="agent-chat__pinned-toggle"
        aria-expanded=${vs.pinnedExpanded}
        @click=${() => {
          vs.pinnedExpanded = !vs.pinnedExpanded;
          requestUpdate();
        }}
      >
        ${icons.bookmark} ${entries.length} pinned
        <span class="collapse-chevron ${vs.pinnedExpanded ? "" : "collapse-chevron--collapsed"}"
          >${icons.chevronDown}</span
        >
      </button>
      ${vs.pinnedExpanded
        ? html`
            <div class="agent-chat__pinned-list">
              ${entries.map(
                ({ index, text, role }) => html`
                  <div class="agent-chat__pinned-item">
                    <span class="agent-chat__pinned-role"
                      >${role === "user" ? userRoleLabel : "Assistant"}</span
                    >
                    <span class="agent-chat__pinned-text"
                      >${text.slice(0, 100)}${text.length > 100 ? "..." : ""}</span
                    >
                    <button
                      class="btn btn--ghost"
                      @click=${() => {
                        pinned.unpin(index);
                        requestUpdate();
                      }}
                      title="Unpin"
                    >
                      ${icons.x}
                    </button>
                  </div>
                `,
              )}
            </div>
          `
        : nothing}
    </div>
  `;
}

function renderSlashMenu(
  requestUpdate: () => void,
  props: ChatProps,
  draft: string,
): TemplateResult | typeof nothing {
  if (!vs.slashMenuOpen) {
    return nothing;
  }

  // Arg-picker mode: show options for the selected command
  if (vs.slashMenuMode === "args" && vs.slashMenuCommand && vs.slashMenuArgItems.length > 0) {
    return html`
      <div
        id=${SLASH_MENU_LISTBOX_ID}
        class="slash-menu"
        role="listbox"
        aria-label="Command arguments"
      >
        <div class="slash-menu-group">
          <div class="slash-menu-group__label">
            /${vs.slashMenuCommand.name} ${vs.slashMenuCommand.description}
          </div>
          ${vs.slashMenuArgItems.map(
            (arg, i) => html`
              <div
                id=${getSlashArgOptionId(vs.slashMenuCommand?.name ?? "", arg)}
                class="slash-menu-item ${i === vs.slashMenuIndex ? "slash-menu-item--active" : ""}"
                role="option"
                aria-selected=${i === vs.slashMenuIndex}
                @click=${() => selectSlashArg(arg, props, requestUpdate, true)}
                @mouseenter=${() => {
                  vs.slashMenuIndex = i;
                  requestUpdate();
                }}
              >
                ${vs.slashMenuCommand?.icon
                  ? html`<span class="slash-menu-icon">${icons[vs.slashMenuCommand.icon]}</span>`
                  : nothing}
                <span class="slash-menu-name">${arg}</span>
                <span class="slash-menu-desc">/${vs.slashMenuCommand?.name} ${arg}</span>
              </div>
            `,
          )}
        </div>
        <div class="slash-menu-footer">
          <kbd>↑↓</kbd> navigate <kbd>Tab</kbd> fill <kbd>Enter</kbd> run <kbd>Esc</kbd> close
        </div>
      </div>
    `;
  }

  // Command mode: show grouped commands
  if (vs.slashMenuItems.length === 0) {
    return nothing;
  }

  const grouped = new Map<
    SlashCommandCategory,
    Array<{ cmd: SlashCommandDef; globalIdx: number }>
  >();
  for (let i = 0; i < vs.slashMenuItems.length; i++) {
    const cmd = vs.slashMenuItems[i];
    const cat = cmd.category ?? "session";
    let list = grouped.get(cat);
    if (!list) {
      list = [];
      grouped.set(cat, list);
    }
    list.push({ cmd, globalIdx: i });
  }

  const sections: TemplateResult[] = [];
  for (const [cat, entries] of grouped) {
    sections.push(html`
      <div class="slash-menu-group">
        <div class="slash-menu-group__label">${CATEGORY_LABELS[cat]}</div>
        ${entries.map(
          ({ cmd, globalIdx }) => html`
            <div
              id=${getSlashCommandOptionId(cmd)}
              class="slash-menu-item ${globalIdx === vs.slashMenuIndex
                ? "slash-menu-item--active"
                : ""}"
              role="option"
              aria-selected=${globalIdx === vs.slashMenuIndex}
              @click=${() => selectSlashCommand(cmd, props, requestUpdate)}
              @mouseenter=${() => {
                vs.slashMenuIndex = globalIdx;
                requestUpdate();
              }}
            >
              ${cmd.icon ? html`<span class="slash-menu-icon">${icons[cmd.icon]}</span>` : nothing}
              <span class="slash-menu-name">/${cmd.name}</span>
              ${cmd.args ? html`<span class="slash-menu-args">${cmd.args}</span>` : nothing}
              <span class="slash-menu-desc">${cmd.description}</span>
              ${cmd.argOptions?.length
                ? html`<span class="slash-menu-badge">${cmd.argOptions.length} options</span>`
                : cmd.executeLocal && !cmd.args
                  ? html` <span class="slash-menu-badge">instant</span> `
                  : nothing}
            </div>
          `,
        )}
      </div>
    `);
  }

  const hiddenCount = vs.slashMenuExpanded ? 0 : getHiddenCommandCount();

  return html`
    <div id=${SLASH_MENU_LISTBOX_ID} class="slash-menu" role="listbox" aria-label="Slash commands">
      ${sections}
      ${hiddenCount > 0
        ? html`<button
            class="slash-menu-show-more"
            @click=${(e: Event) => {
              e.preventDefault();
              e.stopPropagation();
              vs.slashMenuExpanded = true;
              updateSlashMenu(draft, requestUpdate, props);
            }}
          >
            Show ${hiddenCount} more command${hiddenCount !== 1 ? "s" : ""}
          </button>`
        : nothing}
      <div class="slash-menu-footer">
        <kbd>↑↓</kbd> navigate <kbd>Tab</kbd> fill <kbd>Enter</kbd> select <kbd>Esc</kbd> close
      </div>
    </div>
  `;
}

export function renderChat(props: ChatProps) {
  const canCompose = props.connected;
  const isBusy = props.sending || props.stream !== null;
  const canAbort = Boolean(props.canAbort && props.onAbort);
  const hasTerminalStatus = hasTerminalRunStatus(props.runStatus);
  const showAbortableUi = canAbort && !hasTerminalStatus;
  const showSubmittedProgressUi = props.queue.some((item) =>
    isCurrentSessionSubmittedProgress(item, props.sessionKey, props.runStatus),
  );
  const composerRunStatus =
    showAbortableUi || showSubmittedProgressUi
      ? { phase: "in-progress" as const }
      : props.runStatus;
  const compactBusy =
    props.compactionStatus?.phase === "active" || props.compactionStatus?.phase === "retrying";
  const activeSession = props.sessions?.sessions?.find((row) => row.key === props.sessionKey);
  const reasoningLevel = activeSession?.reasoningLevel ?? "off";
  const showReasoning = props.showThinking && reasoningLevel !== "off";
  const assistantIdentity = {
    name: props.assistantName,
    avatar: resolveAssistantDisplayAvatar(props),
  };
  const draftMirror = getComposerDraftMirror(props);
  const visibleDraft = draftMirror.value;
  let composerTextarea: HTMLTextAreaElement | null = null;
  const pinned = getPinnedMessages(props.sessionKey);
  const deleted = getDeletedMessages(props.sessionKey);
  const hasAttachments = (props.attachments?.length ?? 0) > 0;
  const tokens = tokenEstimate(visibleDraft);
  const composerControls = props.composerControls;

  const placeholder = props.connected
    ? hasAttachments
      ? t("chat.composer.placeholderWithAttachments")
      : t("chat.composer.placeholder", { name: props.assistantName || "agent" })
    : t("chat.composer.placeholderDisconnected");

  const requestUpdate = props.onRequestUpdate ?? (() => {});
  const splitRatio = props.splitRatio ?? 0.6;
  const sidebarOpen = Boolean(props.sidebarOpen && props.onCloseSidebar);
  const workItems = buildWorkSurfaceSnapshot({
    assistantName: props.assistantName,
    chatRunId: props.canAbort ? (props.currentRunId ?? null) : null,
    chatRunStatus: props.runStatus,
    chatQueue: props.queue,
    currentSessionKey: props.sessionKey,
    sessionsResult: props.sessions,
    tasks: props.workTasks ?? [],
  });
  const workTree = buildAgentWorkTreeSnapshot({
    currentSessionKey: props.sessionKey,
    sessionsResult: props.sessions,
    tasks: props.workTasks ?? [],
  });
  const displayStream = props.stream ?? null;
  const historyRenderLimit = resolveChatHistoryRenderWindow(props);

  const handleCodeBlockCopy = (e: Event) => {
    const btn = (e.target as HTMLElement).closest(".code-block-copy");
    if (!btn) {
      return;
    }
    const code = (btn as HTMLElement).dataset.code ?? "";
    navigator.clipboard.writeText(code).then(
      () => {
        btn.classList.add("copied");
        setTimeout(() => btn.classList.remove("copied"), 1500);
      },
      () => {},
    );
  };
  const handleChatThreadScroll = (event: Event) => {
    maybeExpandChatHistoryRenderWindow(event, requestUpdate);
    props.onChatScroll?.(event);
  };

  const chatItems = buildCachedChatItems({
    sessionKey: props.sessionKey,
    messages: props.messages,
    toolMessages: props.toolMessages,
    streamSegments: props.streamSegments,
    stream: displayStream,
    streamStartedAt: props.streamStartedAt,
    queue: props.queue,
    showToolCalls: props.showToolCalls,
    searchOpen: vs.searchOpen,
    searchQuery: vs.searchQuery,
    historyRenderLimit,
  });
  syncToolCardExpansionState(props.sessionKey, chatItems, Boolean(props.autoExpandToolCalls));
  const expandedToolCards = getExpandedToolCards(props.sessionKey);
  const toggleToolCardExpanded = (toolCardId: string) => {
    expandedToolCards.set(toolCardId, !expandedToolCards.get(toolCardId));
    requestUpdate();
  };
  const hasRealtimeTalkConversation = (props.realtimeTalkConversation?.length ?? 0) > 0;
  const isEmpty = chatItems.length === 0 && !props.loading && !hasRealtimeTalkConversation;
  const showLoadingSkeleton = props.loading && chatItems.length === 0;
  const threadContextWindow =
    activeSession?.contextTokens ?? props.sessions?.defaults?.contextTokens ?? null;

  const thread = html`
    <div
      class="chat-thread"
      role="log"
      aria-live="polite"
      ${ref((element) => {
        const threadElement = element instanceof HTMLElement ? element : null;
        scheduleChatHistoryRenderWindowFill(
          threadElement,
          requestUpdate,
          props.onScrollToBottom ?? (() => {}),
        );
      })}
      @scroll=${handleChatThreadScroll}
      @click=${handleCodeBlockCopy}
    >
      <div class="chat-thread-inner">
        ${showLoadingSkeleton
          ? html`
              <div class="chat-loading-skeleton" aria-label="Loading chat">
                <div class="chat-line assistant">
                  <div class="chat-msg">
                    <div class="chat-bubble">
                      <div
                        class="skeleton skeleton-line skeleton-line--long"
                        style="margin-bottom: 8px"
                      ></div>
                      <div
                        class="skeleton skeleton-line skeleton-line--medium"
                        style="margin-bottom: 8px"
                      ></div>
                      <div class="skeleton skeleton-line skeleton-line--short"></div>
                    </div>
                  </div>
                </div>
                <div class="chat-line user" style="margin-top: 12px">
                  <div class="chat-msg">
                    <div class="chat-bubble">
                      <div class="skeleton skeleton-line skeleton-line--medium"></div>
                    </div>
                  </div>
                </div>
                <div class="chat-line assistant" style="margin-top: 12px">
                  <div class="chat-msg">
                    <div class="chat-bubble">
                      <div
                        class="skeleton skeleton-line skeleton-line--long"
                        style="margin-bottom: 8px"
                      ></div>
                      <div class="skeleton skeleton-line skeleton-line--short"></div>
                    </div>
                  </div>
                </div>
              </div>
            `
          : nothing}
        ${isEmpty && !vs.searchOpen ? renderWelcomeState(props) : nothing}
        ${isEmpty && vs.searchOpen
          ? html` <div class="agent-chat__empty">No matching messages</div> `
          : nothing}
        ${guard(
          [
            chatItems,
            deletedChatItemsSignature(deleted, chatItems),
            stableBooleanMapSignature(expandedToolCards),
            getAssistantAttachmentAvailabilityRenderVersion(),
            props.sessionKey,
            props.fullMessageAgentId,
            showReasoning,
            props.showToolCalls,
            Boolean(props.autoExpandToolCalls),
            props.assistantName,
            assistantIdentity.avatar,
            props.userName,
            props.userAvatar,
            props.basePath,
            (props.localMediaPreviewRoots ?? []).join("\u0000"),
            props.assistantAttachmentAuthToken,
            props.canvasPluginSurfaceUrl,
            props.embedSandboxMode ?? "scripts",
            props.allowExternalEmbedUrls ?? false,
            threadContextWindow,
          ],
          () =>
            repeat(
              chatItems,
              (item) => item.key,
              (item) => {
                if (item.kind === "divider") {
                  return html`
                    <div class="chat-divider" data-ts=${String(item.timestamp)}>
                      <div class="chat-divider__rule" role="separator" aria-label=${item.label}>
                        <span class="chat-divider__line"></span>
                        <span class="chat-divider__label">${item.label}</span>
                        <span class="chat-divider__line"></span>
                      </div>
                      ${item.description || item.action
                        ? html`
                            <div class="chat-divider__details">
                              ${item.description
                                ? html`<span class="chat-divider__description">
                                    ${item.description}
                                  </span>`
                                : nothing}
                              ${item.action?.kind === "session-checkpoints" &&
                              props.onOpenSessionCheckpoints
                                ? html`
                                    <button
                                      type="button"
                                      class="btn btn--subtle btn--sm chat-divider__action"
                                      @click=${() => props.onOpenSessionCheckpoints?.()}
                                    >
                                      ${item.action.label}
                                    </button>
                                  `
                                : nothing}
                            </div>
                          `
                        : nothing}
                    </div>
                  `;
                }
                if (item.kind === "reading-indicator") {
                  return renderReadingIndicatorGroup(
                    assistantIdentity,
                    props.basePath,
                    props.assistantAttachmentAuthToken ?? null,
                  );
                }
                if (item.kind === "stream") {
                  return renderStreamingGroup(
                    item.text,
                    item.startedAt,
                    item.isStreaming,
                    props.onOpenSidebar,
                    assistantIdentity,
                    props.basePath,
                    props.assistantAttachmentAuthToken ?? null,
                  );
                }
                if (item.kind === "group") {
                  if (deleted.has(item.key)) {
                    return nothing;
                  }
                  return renderMessageGroup(item, {
                    onOpenSidebar: props.onOpenSidebar,
                    sessionKey: props.sessionKey,
                    agentId: props.fullMessageAgentId,
                    showReasoning,
                    showToolCalls: props.showToolCalls,
                    autoExpandToolCalls: Boolean(props.autoExpandToolCalls),
                    isToolMessageExpanded: (messageId: string) => expandedToolCards.get(messageId),
                    onToggleToolMessageExpanded: (messageId: string, expanded?: boolean) => {
                      expandedToolCards.set(
                        messageId,
                        !(expanded ?? expandedToolCards.get(messageId) ?? false),
                      );
                      requestUpdate();
                    },
                    isToolExpanded: (toolCardId: string) =>
                      expandedToolCards.get(toolCardId) ?? false,
                    onToggleToolExpanded: toggleToolCardExpanded,
                    onRequestUpdate: requestUpdate,
                    assistantName: props.assistantName,
                    assistantAvatar: assistantIdentity.avatar,
                    userName: props.userName ?? null,
                    userAvatar: props.userAvatar ?? null,
                    basePath: props.basePath,
                    localMediaPreviewRoots: props.localMediaPreviewRoots ?? [],
                    assistantAttachmentAuthToken: props.assistantAttachmentAuthToken ?? null,
                    canvasPluginSurfaceUrl: props.canvasPluginSurfaceUrl,
                    embedSandboxMode: props.embedSandboxMode ?? "scripts",
                    allowExternalEmbedUrls: props.allowExternalEmbedUrls ?? false,
                    proposedPlanDraft: props.draft,
                    onUseProposedPlan: (prompt: string) => {
                      props.onDraftChange(prompt);
                      requestUpdate();
                      requestAnimationFrame(() => {
                        document
                          .querySelector<HTMLTextAreaElement>(
                            ".agent-chat__composer-combobox textarea",
                          )
                          ?.focus();
                      });
                    },
                    contextWindow: threadContextWindow,
                    onDelete: () => {
                      deleted.delete(item.key);
                      requestUpdate();
                    },
                  });
                }
                return nothing;
              },
            ),
        )}
        ${renderRealtimeTalkConversation(props)}
      </div>
    </div>
  `;

  const syncComposerDraftAfterSend = (target: HTMLTextAreaElement | null) => {
    const hostDraft = props.getDraft?.();
    if (typeof hostDraft !== "string") {
      return;
    }
    // Sends can clear the host draft synchronously before Lit rerenders; keep
    // the local mirror aligned so the submitted text does not stay editable.
    draftMirror.hostDraft = hostDraft;
    draftMirror.value = hostDraft;
    if (target && target.value !== hostDraft) {
      target.value = hostDraft;
      adjustTextareaHeight(target);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (vs.composerComposing || e.isComposing || e.keyCode === 229) {
      return;
    }

    // Slash menu navigation — arg mode
    if (vs.slashMenuOpen && vs.slashMenuMode === "args" && vs.slashMenuArgItems.length > 0) {
      const len = vs.slashMenuArgItems.length;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          vs.slashMenuIndex = (vs.slashMenuIndex + 1) % len;
          requestUpdate();
          return;
        case "ArrowUp":
          e.preventDefault();
          vs.slashMenuIndex = (vs.slashMenuIndex - 1 + len) % len;
          requestUpdate();
          return;
        case "Tab":
          e.preventDefault();
          selectSlashArg(vs.slashMenuArgItems[vs.slashMenuIndex], props, requestUpdate, false);
          return;
        case "Enter":
          e.preventDefault();
          selectSlashArg(vs.slashMenuArgItems[vs.slashMenuIndex], props, requestUpdate, true);
          return;
        case "Escape":
          e.preventDefault();
          vs.slashMenuOpen = false;
          resetSlashMenuState();
          requestUpdate();
          return;
      }
    }

    // Slash menu navigation — command mode
    if (vs.slashMenuOpen && vs.slashMenuItems.length > 0) {
      const len = vs.slashMenuItems.length;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          vs.slashMenuIndex = (vs.slashMenuIndex + 1) % len;
          requestUpdate();
          return;
        case "ArrowUp":
          e.preventDefault();
          vs.slashMenuIndex = (vs.slashMenuIndex - 1 + len) % len;
          requestUpdate();
          return;
        case "Tab":
          e.preventDefault();
          tabCompleteSlashCommand(vs.slashMenuItems[vs.slashMenuIndex], props, requestUpdate);
          return;
        case "Enter":
          e.preventDefault();
          selectSlashCommand(vs.slashMenuItems[vs.slashMenuIndex], props, requestUpdate);
          return;
        case "Escape":
          e.preventDefault();
          vs.slashMenuOpen = false;
          resetSlashMenuState();
          requestUpdate();
          return;
      }
    }

    if (e.key === "Escape" && props.sideResult && !vs.searchOpen) {
      e.preventDefault();
      props.onDismissSideResult?.();
      return;
    }

    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && props.onHistoryKeydown) {
      const target = e.target as HTMLTextAreaElement;
      commitComposerDraft(props, target.value);
      const result = props.onHistoryKeydown({
        key: e.key,
        selectionStart: target.selectionStart,
        selectionEnd: target.selectionEnd,
        valueLength: target.value.length,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        isComposing: e.isComposing,
        keyCode: e.keyCode,
      });
      if (result.handled) {
        if (result.preventDefault) {
          e.preventDefault();
        }
        if (result.restoreCaret) {
          restoreHistoryCaret(target, result.restoreCaret);
        }
        return;
      }
    }

    // Cmd+F for search
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "f") {
      e.preventDefault();
      vs.searchOpen = !vs.searchOpen;
      if (!vs.searchOpen) {
        vs.searchQuery = "";
      }
      requestUpdate();
      return;
    }

    // Send on Enter (without shift)
    if (e.key === "Enter" && !e.shiftKey) {
      if (e.isComposing || e.keyCode === 229) {
        return;
      }
      if (!props.connected) {
        return;
      }
      e.preventDefault();
      if (canCompose) {
        const target = e.target as HTMLTextAreaElement;
        commitComposerDraft(props, target.value);
        props.onSend();
        syncComposerDraftAfterSend(target);
      }
    }
  };

  const syncComposerValue = (
    target: HTMLTextAreaElement,
    options: { forceCommit?: boolean } = {},
  ) => {
    adjustTextareaHeight(target);
    draftMirror.value = target.value;
    const hostDraftNeeded = isBusy || showAbortableUi || props.queue.length > 0;
    if (
      options.forceCommit ||
      hostDraftNeeded ||
      target.value.startsWith("/") ||
      hasVisibleSlashMenuState()
    ) {
      commitComposerDraft(props, target.value);
    }
    updateSlashMenu(target.value, requestUpdate, props, {}, () => target.value);
  };
  const handleInput = (e: InputEvent) => {
    const target = e.target as HTMLTextAreaElement;
    if (vs.composerComposing || e.isComposing) {
      draftMirror.value = target.value;
      return;
    }
    syncComposerValue(target);
  };
  const handleCompositionEnd = (e: CompositionEvent) => {
    vs.composerComposing = false;
    syncComposerValue(e.target as HTMLTextAreaElement, { forceCommit: true });
  };
  const handleBlur = (e: FocusEvent) => {
    const target = e.target as HTMLTextAreaElement;
    commitComposerDraft(props, target.value);
  };
  const handleSend = () => {
    commitComposerDraft(props, draftMirror.value);
    props.onSend();
    syncComposerDraftAfterSend(composerTextarea);
  };
  const slashMenuVisible = isSlashMenuVisible();
  const activeSlashMenuOptionId = getActiveSlashMenuOptionId();
  const activeSlashMenuOptionLabel = getActiveSlashMenuOptionLabel();

  return html`
    <section
      class="card chat"
      @drop=${(e: DragEvent) => handleDrop(e, props)}
      @dragover=${(e: DragEvent) => e.preventDefault()}
    >
      ${props.disabledReason ? html`<div class="callout">${props.disabledReason}</div>` : nothing}
      ${props.error
        ? html`
            <div class="callout danger callout--dismissible" role="alert">
              <span class="callout__content">${props.error}</span>
              ${props.onDismissError
                ? html`
                    <button
                      class="callout__dismiss"
                      type="button"
                      @click=${props.onDismissError}
                      aria-label="Dismiss error"
                      title="Dismiss error"
                    >
                      ${icons.x}
                    </button>
                  `
                : nothing}
            </div>
          `
        : nothing}
      ${props.focusMode && props.onToggleFocusMode
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
        : nothing}
      ${renderSearchBar(requestUpdate)} ${renderPinnedSection(props, pinned, requestUpdate)}

      <div
        class="chat-workbench ${props.sessionWorkspace?.collapsed
          ? "chat-workbench--workspace-collapsed"
          : ""}"
      >
        ${renderSessionWorkspaceRail(props.sessionWorkspace)}
        <div class="chat-workbench__main">
          <div class="chat-split-container ${sidebarOpen ? "chat-split-container--open" : ""}">
            <div
              class="chat-main"
              style="flex: ${sidebarOpen ? `0 1 ${splitRatio * 100}%` : "1 1 100%"}"
            >
              ${thread}
            </div>

            ${sidebarOpen
              ? html`
                  <resizable-divider
                    .splitRatio=${splitRatio}
                    .label=${t("nav.resize")}
                    @resize=${(e: CustomEvent) => props.onSplitRatioChange?.(e.detail.splitRatio)}
                  ></resizable-divider>
                  <div class="chat-sidebar" @click=${handleCodeBlockCopy}>
                    ${renderMarkdownSidebar({
                      content: props.sidebarContent ?? null,
                      error: props.sidebarError ?? null,
                      canvasPluginSurfaceUrl: props.canvasPluginSurfaceUrl,
                      embedSandboxMode: props.embedSandboxMode ?? "scripts",
                      allowExternalEmbedUrls: props.allowExternalEmbedUrls ?? false,
                      onClose: props.onCloseSidebar!,
                      onViewRawText: () => {
                        if (!props.onOpenSidebar) {
                          return;
                        }
                        const rawContent = buildRawSidebarContent(props.sidebarContent);
                        if (rawContent) {
                          props.onOpenSidebar(rawContent);
                        }
                      },
                    })}
                  </div>
                `
              : nothing}
          </div>
        </div>
      </div>

      ${renderChatProjectPicker(props)} ${renderChatApprovalCard(props)} ${renderPursueGoal(props)}
      ${renderControlDirectorDiagnosticsCard(activeSession)}
      ${renderWorkingNow(props, workItems, workTree)}
      ${renderChatQueue({
        queue: props.queue,
        canAbort: showAbortableUi,
        onQueueRetry: props.onQueueRetry,
        onQueueSteer: props.onQueueSteer,
        onQueueRemove: props.onQueueRemove,
      })}
      ${renderSideResult(props.sideResult, props.onDismissSideResult)}
      ${props.showNewMessages
        ? html`
            <button class="chat-new-messages" type="button" @click=${props.onScrollToBottom}>
              ${icons.arrowDown} New messages
            </button>
          `
        : nothing}

      <!-- Input bar -->
      <div
        class="agent-chat__input"
        @click=${(event: MouseEvent) => focusComposerFromChrome(event, props.connected)}
      >
        ${renderSlashMenu(requestUpdate, props, visibleDraft)} ${renderAttachmentPreview(props)}
        <div class="agent-chat__composer-status-stack">
          ${renderFallbackIndicator(props.fallbackStatus)}
          ${renderCompactionIndicator(props.compactionStatus)}
          ${renderContextNotice(activeSession, props.sessions?.defaults?.contextTokens ?? null, {
            compactBusy,
            compactDisabled: !props.connected || isBusy || showAbortableUi,
            onCompact: props.onCompact,
          })}
          ${renderChatGoal(activeSession?.goal)}
        </div>

        <input
          type="file"
          accept=${CHAT_ATTACHMENT_ACCEPT}
          multiple
          class="agent-chat__file-input"
          @change=${(e: Event) => handleFileSelect(e, props)}
        />

        ${renderRealtimeTalkOptions(props)}
        ${props.realtimeTalkActive || props.realtimeTalkDetail || props.realtimeTalkTranscript
          ? html`
              <div
                class="agent-chat__stt-interim agent-chat__talk-status"
                role=${props.realtimeTalkStatus === "error" ? "alert" : nothing}
              >
                <span class="agent-chat__talk-status-text">
                  ${props.realtimeTalkDetail ??
                  ((props.realtimeTalkConversation?.length ?? 0) === 0
                    ? props.realtimeTalkTranscript
                    : null) ??
                  (props.realtimeTalkStatus === "thinking"
                    ? "Asking OpenClaw..."
                    : props.realtimeTalkStatus === "connecting"
                      ? "Connecting Talk..."
                      : "Talk live")}
                </span>
                ${props.realtimeTalkStatus === "error" && props.onDismissRealtimeTalkError
                  ? html`
                      <button
                        class="callout__dismiss"
                        type="button"
                        @click=${props.onDismissRealtimeTalkError}
                        aria-label=${t("chat.composer.dismissTalkError")}
                        title=${t("chat.composer.dismissTalkError")}
                      >
                        ${icons.x}
                      </button>
                    `
                  : nothing}
              </div>
            `
          : nothing}

        <div class="agent-chat__composer-combobox">
          <textarea
            ${ref((el) => {
              composerTextarea = el instanceof HTMLTextAreaElement ? el : null;
              if (composerTextarea) {
                adjustTextareaHeight(composerTextarea);
              }
            })}
            .value=${visibleDraft}
            dir=${detectTextDirection(visibleDraft)}
            ?disabled=${!props.connected}
            aria-autocomplete="list"
            aria-controls=${ifDefined(slashMenuVisible ? SLASH_MENU_LISTBOX_ID : undefined)}
            aria-activedescendant=${ifDefined(activeSlashMenuOptionId ?? undefined)}
            aria-describedby=${SLASH_MENU_ACTIVE_ANNOUNCEMENT_ID}
            @keydown=${handleKeyDown}
            @input=${handleInput}
            @compositionstart=${() => {
              vs.composerComposing = true;
            }}
            @compositionend=${handleCompositionEnd}
            @blur=${handleBlur}
            @paste=${(e: ClipboardEvent) => handlePaste(e, props)}
            placeholder=${placeholder}
            rows="1"
          ></textarea>
          <span
            id=${SLASH_MENU_ACTIVE_ANNOUNCEMENT_ID}
            class="agent-chat__sr-only"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            >${activeSlashMenuOptionLabel}</span
          >
        </div>

        <div class="agent-chat__toolbar">
          <div class="agent-chat__toolbar-left">
            <button
              type="button"
              class="agent-chat__input-btn"
              @click=${clickComposerFileInput}
              title=${t("chat.composer.attachFile")}
              aria-label=${t("chat.composer.attachFile")}
              ?disabled=${!props.connected}
            >
              ${icons.paperclip}
              <span class="agent-chat__control-label">${t("chat.composer.attachFile")}</span>
            </button>

            ${props.onToggleRealtimeTalk
              ? html`
                  <button
                    class="agent-chat__input-btn ${props.realtimeTalkActive
                      ? "agent-chat__input-btn--talk"
                      : ""}"
                    @click=${props.onToggleRealtimeTalk}
                    title=${props.realtimeTalkActive
                      ? t("chat.composer.stopTalk")
                      : t("chat.composer.startTalk")}
                    aria-label=${props.realtimeTalkActive
                      ? t("chat.composer.stopTalk")
                      : t("chat.composer.startTalk")}
                    ?disabled=${!props.connected}
                  >
                    ${props.realtimeTalkActive ? icons.volume2 : icons.radio}
                    <span class="agent-chat__control-label"
                      >${props.realtimeTalkActive
                        ? t("chat.composer.stopTalk")
                        : t("chat.composer.startTalk")}</span
                    >
                  </button>
                `
              : nothing}
            ${props.onToggleRealtimeTalkOptions
              ? html`
                  <button
                    class="agent-chat__input-btn ${props.realtimeTalkOptionsOpen
                      ? "agent-chat__input-btn--talk"
                      : ""}"
                    @click=${props.onToggleRealtimeTalkOptions}
                    title="Talk settings"
                    aria-label="Talk settings"
                    aria-expanded=${props.realtimeTalkOptionsOpen ? "true" : "false"}
                    ?disabled=${!props.connected || props.realtimeTalkActive}
                  >
                    ${icons.settings}
                    <span class="agent-chat__control-label">Talk settings</span>
                  </button>
                `
              : nothing}
            ${tokens ? html`<span class="agent-chat__token-count">${tokens}</span>` : nothing}
            ${renderChatRunStatusIndicator(composerRunStatus)}
          </div>

          ${composerControls && composerControls !== nothing
            ? html`<div class="agent-chat__composer-controls">${composerControls}</div>`
            : nothing}
          ${renderChatRunControls({
            canAbort: showAbortableUi,
            connected: props.connected,
            draft: visibleDraft,
            hasMessages: props.messages.length > 0,
            isBusy,
            sending: props.sending,
            onAbort: props.onAbort,
            onExport: () => exportMarkdown(props),
            onNewSession: props.onNewSession,
            onSend: handleSend,
            onStoreDraft: () => {},
            showSecondary: false,
          })}
        </div>
      </div>
    </section>
  `;
}
