import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import type { ClosestUsageWindow } from "../controllers/models-availability.ts";
import type { ModelCatalogRow } from "../controllers/models.ts";
import type { ProjectEntry } from "../controllers/projects.ts";
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
import { loadSessionWorkspace } from "../storage.ts";
import { renderMarkdownSidebar } from "./markdown-sidebar.ts";
import "../components/resizable-divider.ts";

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
  // Model catalog (models.list)
  modelsCatalog?: ModelCatalogRow[];
  modelsLoading?: boolean;
  detectedProviders?: Set<string>;
  unavailableProviders?: Set<string>;
  cooldownModels?: Set<string>;
  closestUsageByProvider?: Record<string, ClosestUsageWindow | null>;
  // System defaults (config.get/config.patch)
  defaultThinkingModelKey?: string | null;
  defaultThinkingAutoPickFromPool?: boolean;
  defaultCodingModelKey?: string | null;
  // Session-level model override (sessions.patch)
  onSessionModelChange?: (modelKey: string | null) => void;
  onSessionThinkingModelChange?: (modelKey: string | null) => void;
  onSessionCodingModelChange?: (modelKey: string | null) => void;
  // Projects catalog (projects.list)
  projects?: ProjectEntry[];
  projectsRootDir?: string | null;
  projectsIncludeHidden?: boolean;
  onSessionProjectChange?: (projectDir: string | null) => void;
  onProjectsBrowseChange?: (dir: string | null) => void;
  onPickWorkspaceDir?: () => void;
  onToggleHiddenProjects?: (next: boolean) => void;
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
const ELITE_CHECKLIST_TEMPLATES = [
  {
    id: "problem",
    label: "Problem Statement",
    marker: "## Problem Statement",
    template: "## Problem Statement\n- Problem:\n- User:\n- Expected change:\n- Success signal:",
  },
  {
    id: "north-star",
    label: "North Star",
    marker: "## North Star",
    template: "## North Star\n- One-line goal (user + outcome + metric + constraints):",
  },
  {
    id: "hypothesis",
    label: "Hypothesis",
    marker: "## Hypothesis",
    template: "## Hypothesis\n- Hypothesis:\n- Risk:\n- Expected evidence:\n- Fast invalidation:",
  },
  {
    id: "decision",
    label: "Decision Record",
    marker: "## Decision Record",
    template:
      "## Decision Record\n- Context:\n- Options considered:\n- Decision:\n- Trade-offs:\n- Review date:",
  },
  {
    id: "learning",
    label: "Learning",
    marker: "## Loop Close-out",
    template: "## Loop Close-out\n- Metric result:\n- Learning:\n- Next action:",
  },
] as const;

function adjustTextareaHeight(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

function closeDetailsForTarget(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  const details = el?.closest("details") as HTMLDetailsElement | null;
  if (details) {
    details.open = false;
  }
}

function resolveFilterInput(event: Event): HTMLInputElement | null {
  if (event.currentTarget instanceof HTMLInputElement) {
    return event.currentTarget;
  }
  if (event.target instanceof HTMLInputElement) {
    return event.target;
  }
  for (const entry of event.composedPath()) {
    if (entry instanceof HTMLInputElement) {
      return entry;
    }
  }
  return null;
}

function filterMenuOptions(event: Event) {
  const input = resolveFilterInput(event);
  const q = (input?.value ?? "").trim().toLowerCase();
  const panel = input?.closest(".compose-dd__panel") as HTMLElement | null;
  if (!panel) {
    return;
  }
  const items = panel.querySelectorAll<HTMLElement>("[data-filter]");
  for (const item of items) {
    const text = (item.dataset.filter ?? "").toLowerCase();
    item.hidden = q ? !text.includes(q) : false;
  }
}

function normalizeModelKey(row: ModelCatalogRow): string | null {
  const provider = typeof row.provider === "string" ? row.provider.trim().toLowerCase() : "";
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!provider || !id) {
    return null;
  }
  return `${provider}/${id}`;
}

function resolveModelLabel(row: ModelCatalogRow): string {
  const name = typeof row.name === "string" ? row.name.trim() : "";
  return name || row.id;
}

function resolveSessionTaskModelLabel(raw?: string | null, autoFallback?: string | null) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    if (autoFallback) {
      // Extract short model name from "provider/model-id"
      const slash = autoFallback.indexOf("/");
      const short = slash >= 0 ? autoFallback.slice(slash + 1) : autoFallback;
      return `Auto · ${short}`;
    }
    return "Auto";
  }
  return trimmed;
}

function appendChecklistTemplateDraft(
  draft: string,
  template: (typeof ELITE_CHECKLIST_TEMPLATES)[number],
) {
  const normalizedDraft = draft.toLowerCase();
  if (normalizedDraft.includes(template.marker.toLowerCase())) {
    return draft;
  }
  const trimmed = draft.trimEnd();
  const prefix = trimmed.length > 0 ? "\n\n" : "";
  return `${trimmed}${prefix}${template.template}\n`;
}

function isModelAvailableForUi(params: {
  key: string;
  row?: ModelCatalogRow;
  detectedProviders?: Set<string>;
  unavailableProviders: Set<string>;
  cooldownModels: Set<string>;
}): boolean {
  const tags = Array.isArray(params.row?.tags) ? params.row.tags : [];
  const normalizedTags = new Set(
    tags
      .filter((tag): tag is string => typeof tag === "string")
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean),
  );
  if (
    normalizedTags.has("missing") ||
    normalizedTags.has("unavailable") ||
    normalizedTags.has("disabled") ||
    normalizedTags.has("cooldown")
  ) {
    return false;
  }
  const normalizedKey = params.key.toLowerCase();
  if (params.cooldownModels.has(normalizedKey)) {
    return false;
  }
  const slash = normalizedKey.indexOf("/");
  const provider = slash === -1 ? "" : normalizedKey.slice(0, slash);
  const detectedProviders = params.detectedProviders;
  if (
    provider &&
    detectedProviders &&
    detectedProviders.size > 0 &&
    !detectedProviders.has(provider)
  ) {
    return false;
  }
  if (provider && params.unavailableProviders.has(provider)) {
    return false;
  }
  return true;
}

type AvailableModelEntry = {
  key: string;
  label: string;
  row: ModelCatalogRow;
};

/**
 * Date-suffix pattern for versioned/snapshot model IDs.
 * Matches IDs ending with `-YYYYMMDD` or `-YYYY-MM-DD`.
 */
const DATE_SUFFIX_RE = /-\d{8}$|-\d{4}-\d{2}-\d{2}$/;

/**
 * Allowlisted dated models that are canonical (not snapshots).
 */
const CANONICAL_DATED_MODELS = new Set(["claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"]);

function isLatestModelForUi(id: string): boolean {
  if (CANONICAL_DATED_MODELS.has(id)) {
    return true;
  }
  return !DATE_SUFFIX_RE.test(id);
}

function collectAvailableModels(params: {
  modelsCatalog: ModelCatalogRow[];
  capability: "thinking" | "coding";
  detectedProviders?: Set<string>;
  unavailableProviders: Set<string>;
  cooldownModels: Set<string>;
}): AvailableModelEntry[] {
  const detectedProviders = params.detectedProviders ?? new Set<string>();
  const result: AvailableModelEntry[] = [];
  for (const row of params.modelsCatalog) {
    const key = normalizeModelKey(row);
    if (!key) {
      continue;
    }
    const caps = row.capabilities ?? {};
    const supports =
      params.capability === "thinking"
        ? Boolean(caps.reasoning ?? row.reasoning)
        : Boolean(caps.coding);
    if (!supports) {
      continue;
    }
    if (
      !isModelAvailableForUi({
        key,
        row,
        detectedProviders,
        unavailableProviders: params.unavailableProviders,
        cooldownModels: params.cooldownModels,
      })
    ) {
      continue;
    }
    // Filter out dated snapshots (e.g. claude-opus-4-5-20251101)
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!isLatestModelForUi(id)) {
      continue;
    }
    result.push({
      key,
      label: resolveModelLabel(row),
      row,
    });
  }
  // Sort: powerful first, then by cost (cheaper first), then alphabetical
  result.sort((a, b) => {
    const perfA = perfTierScore(a.row.capabilities?.performanceTier);
    const perfB = perfTierScore(b.row.capabilities?.performanceTier);
    if (perfB !== perfA) {
      return perfB - perfA;
    }
    const costA = costTierScore(a.row.capabilities?.costTier);
    const costB = costTierScore(b.row.capabilities?.costTier);
    if (costA !== costB) {
      return costA - costB;
    }
    return a.key.localeCompare(b.key);
  });
  return result;
}

function pickBestModelEntry(entries: AvailableModelEntry[]): AvailableModelEntry | null {
  let best: AvailableModelEntry | null = null;
  let bestPerf = -Infinity;
  let bestCost = Infinity;
  for (const entry of entries) {
    const perf = perfTierScore(entry.row.capabilities?.performanceTier);
    const cost = costTierScore(entry.row.capabilities?.costTier);
    if (
      best === null ||
      perf > bestPerf ||
      (perf === bestPerf && cost < bestCost) ||
      (perf === bestPerf && cost === bestCost && entry.key.toLowerCase() < best.key.toLowerCase())
    ) {
      best = entry;
      bestPerf = perf;
      bestCost = cost;
    }
  }
  return best;
}

function renderCompactionIndicator(status: CompactionIndicatorStatus | null | undefined) {
  if (!status) {
    return nothing;
  }

  // Show "compacting..." while active
  if (status.active) {
    return html`
      <div class="callout info compaction-indicator compaction-indicator--active">
        ${icons.loader} Compacting context...
      </div>
    `;
  }

  // Show "compaction complete" briefly after completion
  if (status.completedAt) {
    const elapsed = Date.now() - status.completedAt;
    if (elapsed < COMPACTION_TOAST_DURATION_MS) {
      return html`
        <div class="callout success compaction-indicator compaction-indicator--complete">
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

async function handleFilePick(e: Event, props: ChatProps) {
  if (!props.onAttachmentsChange) {
    return;
  }
  const input = e.target as HTMLInputElement;
  const files = input.files ? Array.from(input.files) : [];
  // Reset input so selecting the same file again works.
  input.value = "";
  if (files.length === 0) {
    return;
  }

  const imageFiles = files.filter((f) => f.type && f.type.startsWith("image/"));
  if (imageFiles.length === 0) {
    return;
  }

  const reads = imageFiles.map(
    (file) =>
      new Promise<ChatAttachment | null>((resolve) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => {
          const dataUrl = typeof reader.result === "string" ? reader.result : "";
          if (!dataUrl) {
            resolve(null);
            return;
          }
          resolve({
            id: generateAttachmentId(),
            dataUrl,
            mimeType: file.type,
          });
        });
        reader.addEventListener("error", () => resolve(null));
        reader.readAsDataURL(file);
      }),
  );

  const next = (await Promise.all(reads)).filter((a): a is ChatAttachment => a !== null);
  if (next.length === 0) {
    return;
  }
  props.onAttachmentsChange([...(props.attachments ?? []), ...next]);
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

function resolveSessionProjectLabel(
  activeSession?: { workspaceDir?: string; projectDir?: string },
  fallbackDir?: string | null,
) {
  const dir =
    activeSession?.workspaceDir?.trim() || activeSession?.projectDir?.trim() || fallbackDir?.trim();
  if (!dir) {
    return "All projects";
  }
  const parts = dir.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "Project";
}

function resolveParentDir(dir: string): string | null {
  const trimmed = dir.trim().replace(/\/+$/, "");
  if (!trimmed || trimmed === "/") {
    return null;
  }
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length <= 1) {
    return "/";
  }
  return "/" + parts.slice(0, -1).join("/");
}

function formatCountdownShort(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) {
    return `${d}d ${h % 24}h`;
  }
  if (h > 0) {
    return `${h}h ${m % 60}m`;
  }
  if (m > 0) {
    return `${m}m`;
  }
  return `${s}s`;
}

function resolveProviderFromModelKey(key: string | null | undefined): string | null {
  if (!key) {
    return null;
  }
  const trimmed = key.trim();
  if (!trimmed) {
    return null;
  }
  const provider = trimmed.split("/")[0]?.trim().toLowerCase();
  return provider || null;
}

function perfTierScore(tier: unknown): number {
  const t = typeof tier === "string" ? tier.toLowerCase() : "";
  if (t === "powerful") {
    return 3;
  }
  if (t === "balanced") {
    return 2;
  }
  if (t === "fast") {
    return 1;
  }
  return 0;
}

function costTierScore(tier: unknown): number {
  const t = typeof tier === "string" ? tier.toLowerCase() : "";
  if (t === "free") {
    return 0;
  }
  if (t === "cheap") {
    return 1;
  }
  if (t === "moderate") {
    return 2;
  }
  if (t === "expensive") {
    return 3;
  }
  return 2;
}

function pickAutoProviderForCapability(args: {
  availableModels: AvailableModelEntry[];
}): string | null {
  let best: { key: string; perf: number; cost: number } | null = null;

  for (const entry of args.availableModels) {
    const { key, row } = entry;
    const perf = perfTierScore(row.capabilities?.performanceTier);
    const cost = costTierScore(row.capabilities?.costTier);
    if (!best) {
      best = { key, perf, cost };
      continue;
    }
    if (perf > best.perf) {
      best = { key, perf, cost };
      continue;
    }
    if (perf === best.perf && cost < best.cost) {
      best = { key, perf, cost };
      continue;
    }
    if (perf === best.perf && cost === best.cost && key.toLowerCase() < best.key.toLowerCase()) {
      best = { key, perf, cost };
    }
  }

  return resolveProviderFromModelKey(best?.key ?? null);
}

function renderClosestUsageBar(window: ClosestUsageWindow | null, providerId: string | null) {
  const pct = Math.min(100, Math.max(0, window?.usedPercent ?? 0));
  const label = window?.label ?? "Quota";
  const resets =
    typeof window?.resetRemainingMs === "number" && window.resetRemainingMs > 0
      ? `; resets in ${formatCountdownShort(window.resetRemainingMs)}`
      : "";
  const title = providerId
    ? `${providerId}: ${label} ${pct.toFixed(1)}%${resets}`
    : `${label} ${pct.toFixed(1)}%${resets}`;

  return html`
    <span class="compose-quota" title=${title} aria-label=${title}>
      <span class="compose-quota__label" aria-hidden="true">${label}</span>
      <span class="compose-quota__bar" aria-hidden="true">
        <span class="compose-quota__fill" style="width: ${pct}%;"></span>
      </span>
    </span>
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
      : "Ask anything"
    : "Connect to the gateway to start chatting…";
  const checklistCompletedCount = ELITE_CHECKLIST_TEMPLATES.filter((item) =>
    props.draft.toLowerCase().includes(item.marker.toLowerCase()),
  ).length;

  let fileInput: HTMLInputElement | null = null;
  const modelsCatalog = Array.isArray(props.modelsCatalog) ? props.modelsCatalog : [];
  const detectedProviders = props.detectedProviders ?? new Set<string>();
  const unavailableProviders = props.unavailableProviders ?? new Set<string>();
  const cooldownModels = props.cooldownModels ?? new Set<string>();
  const thinkingModels = collectAvailableModels({
    modelsCatalog,
    capability: "thinking",
    detectedProviders,
    unavailableProviders,
    cooldownModels,
  });
  const codingModels = collectAvailableModels({
    modelsCatalog,
    capability: "coding",
    detectedProviders,
    unavailableProviders,
    cooldownModels,
  });
  const closestUsageByProvider = props.closestUsageByProvider ?? {};
  const thinkingAutoPickFromPool = Boolean(props.defaultThinkingAutoPickFromPool === true);
  const defaultThinkingModelKey =
    typeof props.defaultThinkingModelKey === "string" ? props.defaultThinkingModelKey : null;
  const defaultCodingModelKey =
    typeof props.defaultCodingModelKey === "string" ? props.defaultCodingModelKey : null;
  const sessionThinkingModelKey =
    typeof activeSession?.thinkingModelOverride === "string" &&
    activeSession.thinkingModelOverride.trim()
      ? activeSession.thinkingModelOverride.trim()
      : null;
  const sessionCodingModelKey =
    typeof activeSession?.codingModelOverride === "string" &&
    activeSession.codingModelOverride.trim()
      ? activeSession.codingModelOverride.trim()
      : null;
  const effectiveThinkingModelKey =
    sessionThinkingModelKey ?? (thinkingAutoPickFromPool ? null : defaultThinkingModelKey);
  const effectiveCodingModelKey = sessionCodingModelKey ?? defaultCodingModelKey;
  const thinkingModelLabel = resolveSessionTaskModelLabel(
    effectiveThinkingModelKey,
    defaultThinkingModelKey,
  );
  const codingModelLabel = resolveSessionTaskModelLabel(
    effectiveCodingModelKey,
    defaultCodingModelKey,
  );
  const projects = Array.isArray(props.projects) ? props.projects : [];
  const projectsRootDir = typeof props.projectsRootDir === "string" ? props.projectsRootDir : null;
  const projectsIncludeHidden = Boolean(props.projectsIncludeHidden);
  const cachedWorkspaceDir = loadSessionWorkspace(props.sessionKey);
  const sessionProjectLabel = resolveSessionProjectLabel(
    activeSession ?? undefined,
    cachedWorkspaceDir,
  );
  let projectPathInput: HTMLInputElement | null = null;

  const sessionModelProvider =
    typeof activeSession?.modelProvider === "string" && activeSession.modelProvider.trim()
      ? activeSession.modelProvider.trim().toLowerCase()
      : null;

  // In Auto mode, base the quota bar on the orchestrator's real provider (session store),
  // falling back to a heuristic only if we don't have a provider yet.
  const thinkingProvider = effectiveThinkingModelKey
    ? resolveProviderFromModelKey(effectiveThinkingModelKey)
    : thinkingAutoPickFromPool
      ? (sessionModelProvider ??
        pickAutoProviderForCapability({
          availableModels: thinkingModels,
        }))
      : resolveProviderFromModelKey(defaultThinkingModelKey);

  const codingProvider = effectiveCodingModelKey
    ? resolveProviderFromModelKey(effectiveCodingModelKey)
    : sessionModelProvider;

  const thinkingUsage = thinkingProvider
    ? (closestUsageByProvider[thinkingProvider] ?? null)
    : null;
  const codingUsage = codingProvider ? (closestUsageByProvider[codingProvider] ?? null) : null;

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
            // Use senderIdentity from group if available (direct announce mode)
            const effectiveName = item.senderIdentity?.name ?? props.assistantName;
            const effectiveAvatar =
              item.senderIdentity?.avatar ?? item.senderIdentity?.emoji ?? assistantIdentity.avatar;
            return renderMessageGroup(item, {
              onOpenSidebar: props.onOpenSidebar,
              showReasoning,
              assistantName: effectiveName,
              assistantAvatar: effectiveAvatar,
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

      ${renderCompactionIndicator(props.compactionStatus)}

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

      ${
        props.showNewMessages
          ? html`
            <button
              class="chat-new-messages"
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
        <div class="chat-compose__bar">
          <details class="compose-framework" role="group" aria-label="Execution checklist">
            <summary class="compose-framework__head">
              <span class="compose-framework__title">${icons.fileText} Execution checklist</span>
              <span class="compose-framework__progress muted"
                >${checklistCompletedCount}/${ELITE_CHECKLIST_TEMPLATES.length}</span
              >
            </summary>
            <div class="compose-framework__items">
              ${ELITE_CHECKLIST_TEMPLATES.map((item) => {
                const done = props.draft.toLowerCase().includes(item.marker.toLowerCase());
                return html`
                  <button
                    class="compose-framework__item ${done ? "is-done" : ""}"
                    type="button"
                    title=${done ? `${item.label} already in draft` : `Insert ${item.label}`}
                    @click=${() => props.onDraftChange(appendChecklistTemplateDraft(props.draft, item))}
                  >
                    ${done ? icons.check : nothing}
                    <span>${item.label}</span>
                  </button>
                `;
              })}
            </div>
          </details>
          <textarea
            class="chat-compose__input"
            ${ref((el) => el && adjustTextareaHeight(el as HTMLTextAreaElement))}
            .value=${props.draft}
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
            aria-label="Chat message"
          ></textarea>

          <div class="chat-compose__controls">
            <div class="chat-compose__controls-left">
              <details class="compose-dd">
                <summary class="compose-pill" aria-label="Mode">
                  ${icons.messageSquare} Ask ${icons.chevronDown}
                </summary>
                <div class="compose-dd__panel" role="menu">
                  <button
                    class="compose-dd__item"
                    type="button"
                    role="menuitem"
                    @click=${(e: Event) => {
                      // If user was in "command mode", drop a leading "/" to get back to Ask.
                      const trimmed = props.draft.trimStart();
                      if (trimmed.startsWith("/")) {
                        props.onDraftChange(trimmed.replace(/^\/\s*/, ""));
                      }
                      closeDetailsForTarget(e.currentTarget);
                    }}
                  >
                    Ask
                  </button>
                  <button
                    class="compose-dd__item"
                    type="button"
                    role="menuitem"
                    @click=${(e: Event) => {
                      // Help users discover slash commands while keeping everything functional.
                      const trimmed = props.draft.trimStart();
                      if (!trimmed.startsWith("/")) {
                        props.onDraftChange("/" + (props.draft ? " " : "") + props.draft);
                      }
                      closeDetailsForTarget(e.currentTarget);
                    }}
                  >
                    Command
                  </button>
                </div>
              </details>

              <details class="compose-dd">
                <summary class="compose-pill" aria-label="Session">
                  ${icons.monitor} All sessions ${icons.chevronDown}
                </summary>
                <div class="compose-dd__panel compose-dd__panel--wide" role="menu">
                  <div class="compose-dd__search">
                    ${icons.search}
                    <input
                      type="text"
                      placeholder="Search"
                      @input=${(e: Event) => filterMenuOptions(e)}
                    />
                  </div>
                  <div class="compose-dd__list">
                    ${(props.sessions?.sessions ?? []).map((s) => {
                      const label = s.displayName || s.label || s.key;
                      const selected = s.key === props.sessionKey;
                      return html`
                        <button
                          class="compose-dd__item ${selected ? "is-selected" : ""}"
                          type="button"
                          role="menuitem"
                          data-filter=${`${label} ${s.key}`}
                          @click=${(e: Event) => {
                            props.onSessionKeyChange(s.key);
                            closeDetailsForTarget(e.currentTarget);
                          }}
                        >
                          <span class="compose-dd__item-title">${label}</span>
                          <span class="compose-dd__item-sub mono">${s.key}</span>
                        </button>
                      `;
                    })}
                  </div>
                </div>
              </details>

              <details class="compose-dd">
                <summary class="compose-pill" aria-label="Project">
                  ${icons.folder} ${sessionProjectLabel} ${icons.chevronDown}
                </summary>
                <div class="compose-dd__panel compose-dd__panel--wide" role="menu">
                  <div style="display: flex; gap: 8px; align-items: center; padding: 10px 10px 0 10px;">
                    <button
                      class="compose-pill"
                      type="button"
                      style="height: 30px; padding: 0 10px;"
                      ?disabled=${!props.connected || !props.onPickWorkspaceDir}
                      @click=${(e: Event) => {
                        props.onPickWorkspaceDir?.();
                        closeDetailsForTarget(e.currentTarget);
                      }}
                    >
                      Choose folder…
                    </button>
                    <label class="muted" style="display:flex; gap:6px; align-items:center; font-size: 12px;">
                      <input
                        type="checkbox"
                        ?checked=${projectsIncludeHidden}
                        ?disabled=${!props.connected || !props.onToggleHiddenProjects}
                        @change=${(e: Event) => {
                          const el = e.currentTarget as HTMLInputElement | null;
                          props.onToggleHiddenProjects?.(Boolean(el?.checked));
                        }}
                      />
                      Show hidden
                    </label>
                  </div>
                  <div class="compose-dd__search">
                    ${icons.search}
                    <input
                      type="text"
                      placeholder="Search projects"
                      @input=${(e: Event) => filterMenuOptions(e)}
                    />
                  </div>
                  <div class="compose-dd__search">
                    ${icons.folder}
                    <input
                      ${ref((el) => {
                        projectPathInput = (el as HTMLInputElement) ?? null;
                      })}
                      type="text"
                      placeholder="Set workspace dir (e.g. /Users/... or ~/...)"
                      @keydown=${(e: KeyboardEvent) => {
                        if (e.key !== "Enter") {
                          return;
                        }
                        const value = projectPathInput?.value?.trim() ?? "";
                        if (!value) {
                          return;
                        }
                        props.onSessionProjectChange?.(value);
                        closeDetailsForTarget(e.currentTarget);
                      }}
                    />
                    <button
                      class="compose-pill"
                      type="button"
                      style="height: 30px; padding: 0 10px;"
                      ?disabled=${!props.connected || !props.onSessionProjectChange}
                      @click=${(e: Event) => {
                        const value = projectPathInput?.value?.trim() ?? "";
                        if (!value) {
                          return;
                        }
                        props.onSessionProjectChange?.(value);
                        closeDetailsForTarget(e.currentTarget);
                      }}
                    >
                      Set
                    </button>
                  </div>
                  <div class="compose-dd__list">
                    <button
                      class="compose-dd__item"
                      type="button"
                      role="menuitem"
                      ?disabled=${!props.connected || !props.onSessionProjectChange}
                      data-filter="all projects"
                      @click=${(e: Event) => {
                        props.onSessionProjectChange?.(null);
                        props.onProjectsBrowseChange?.(null);
                        closeDetailsForTarget(e.currentTarget);
                      }}
                    >
                      <span class="compose-dd__item-title">All projects</span>
                      <span class="compose-dd__item-sub mono">Use default workspace</span>
                    </button>
                    ${
                      projectsRootDir && props.onProjectsBrowseChange
                        ? (() => {
                            const parent = resolveParentDir(projectsRootDir);
                            if (!parent) {
                              return nothing;
                            }
                            return html`
                              <button
                                class="compose-dd__item"
                                type="button"
                                role="menuitem"
                                data-filter="up parent"
                                ?disabled=${!props.connected}
                                @click=${(e: Event) => {
                                  props.onProjectsBrowseChange?.(parent);
                                  closeDetailsForTarget(e.currentTarget);
                                }}
                              >
                                <span class="compose-dd__item-title">Up one level</span>
                                <span class="compose-dd__item-sub mono">${parent}</span>
                              </button>
                              <button
                                class="compose-dd__item"
                                type="button"
                                role="menuitem"
                                data-filter="use this folder"
                                ?disabled=${!props.connected || !props.onSessionProjectChange}
                                @click=${(e: Event) => {
                                  props.onSessionProjectChange?.(projectsRootDir);
                                  closeDetailsForTarget(e.currentTarget);
                                }}
                              >
                                <span class="compose-dd__item-title">Use this folder</span>
                                <span class="compose-dd__item-sub mono">${projectsRootDir}</span>
                              </button>
                            `;
                          })()
                        : nothing
                    }
                    ${
                      projects.length === 0
                        ? html`
                            <div class="compose-dd__empty muted">No projects found.</div>
                          `
                        : projects.map((p) => {
                            const activeDir =
                              activeSession?.workspaceDir?.trim() ||
                              activeSession?.projectDir?.trim();
                            const selected =
                              Boolean(activeDir) &&
                              activeDir!.toLowerCase() === p.path.toLowerCase();
                            return html`
                              <button
                                class="compose-dd__item ${selected ? "is-selected" : ""}"
                                type="button"
                                role="menuitem"
                                data-filter=${`${p.name} ${p.path}`}
                                ?disabled=${!props.connected || !props.onSessionProjectChange}
                                @click=${(e: Event) => {
                                  props.onSessionProjectChange?.(p.path);
                                  props.onProjectsBrowseChange?.(p.path);
                                  closeDetailsForTarget(e.currentTarget);
                                }}
                              >
                                <span class="compose-dd__item-title">${p.name}</span>
                                <span class="compose-dd__item-sub mono"
                                  >${p.isGitRepo ? "git" : "folder"} · ${p.path}</span
                                >
                              </button>
                            `;
                          })
                    }
                  </div>
                </div>
              </details>

              <button
                class="compose-pill compose-pill--icon"
                type="button"
                aria-label="Add images"
                title="Add images"
                ?disabled=${!props.connected || !props.onAttachmentsChange}
                @click=${() => fileInput?.click()}
              >
                +
              </button>
              <input
                ${ref((el) => {
                  fileInput = (el as HTMLInputElement) ?? null;
                })}
                class="chat-compose__file"
                type="file"
                accept="image/*"
                multiple
                @change=${(e: Event) => void handleFilePick(e, props)}
              />
            </div>

            <div class="chat-compose__controls-right">
              <details class="compose-dd compose-dd--right">
                <summary class="compose-pill compose-pill--model" aria-label="Thinking model">
                  <span class="compose-pill__icon" aria-hidden="true">${icons.brain}</span>
                  <span class="compose-pill__label">${thinkingModelLabel}</span>
                  <span class="compose-pill__tail" aria-hidden="true">
                    ${renderClosestUsageBar(thinkingUsage, thinkingProvider)}
                    ${icons.chevronDown}
                  </span>
                </summary>
                <div class="compose-dd__panel compose-dd__panel--models" role="menu">
                  <div class="compose-dd__search">
                    ${icons.search}
                    <input
                      type="text"
                      placeholder="Search thinking models"
                      ?disabled=${isBusy}
                      @input=${(e: Event) => filterMenuOptions(e)}
                    />
                  </div>
                  <div class="compose-dd__list">
                    <button
                      class="compose-dd__item ${!effectiveThinkingModelKey ? "is-selected" : ""}"
                      type="button"
                      role="menuitem"
                      ?disabled=${isBusy || !props.connected || !props.onSessionThinkingModelChange}
                      data-filter="auto"
                      @click=${(e: Event) => {
                        props.onSessionThinkingModelChange?.(null);
                        closeDetailsForTarget(e.currentTarget);
                      }}
                    >
                      <span class="compose-dd__item-title">Auto</span>
                      <span class="compose-dd__item-sub mono">Use config default for thinking</span>
                    </button>
                  ${
                    modelsCatalog.length === 0
                      ? html`
                          <div class="compose-dd__empty muted">No model catalog loaded.</div>
                        `
                      : thinkingModels.length === 0
                        ? html`
                            <div class="compose-dd__empty muted">No thinking models available.</div>
                          `
                        : thinkingModels.map((entry) => {
                            const key = entry.key;
                            const activeKey = effectiveThinkingModelKey?.trim() || null;
                            const selected =
                              Boolean(activeKey) && key.toLowerCase() === activeKey!.toLowerCase();
                            return html`
                              <button
                                class="compose-dd__item ${selected ? "is-selected" : ""}"
                                type="button"
                                role="menuitem"
                                data-filter=${`${entry.label} ${key}`}
                                ?disabled=${isBusy || !props.connected || !props.onSessionThinkingModelChange}
                                @click=${(e: Event) => {
                                  props.onSessionThinkingModelChange?.(key);
                                  closeDetailsForTarget(e.currentTarget);
                                }}
                              >
                                <span class="compose-dd__item-title">${entry.label}</span>
                                <span class="compose-dd__item-sub mono">${key}</span>
                              </button>
                            `;
                          })
                  }
                  </div>
                </div>
              </details>

              <details class="compose-dd compose-dd--right">
                <summary class="compose-pill compose-pill--model" aria-label="Coding model">
                  <span class="compose-pill__icon" aria-hidden="true">${icons.code}</span>
                  <span class="compose-pill__label">${codingModelLabel}</span>
                  <span class="compose-pill__tail" aria-hidden="true">
                    ${renderClosestUsageBar(codingUsage, codingProvider)}
                    ${icons.chevronDown}
                  </span>
                </summary>
                <div class="compose-dd__panel compose-dd__panel--models" role="menu">
                  <div class="compose-dd__search">
                    ${icons.search}
                    <input
                      type="text"
                      placeholder="Search coding models"
                      ?disabled=${isBusy}
                      @input=${(e: Event) => filterMenuOptions(e)}
                    />
                  </div>
                  <div class="compose-dd__list">
                    <button
                      class="compose-dd__item ${!effectiveCodingModelKey ? "is-selected" : ""}"
                      type="button"
                      role="menuitem"
                      ?disabled=${isBusy || !props.connected || !props.onSessionCodingModelChange}
                      data-filter="auto"
                      @click=${(e: Event) => {
                        props.onSessionCodingModelChange?.(null);
                        closeDetailsForTarget(e.currentTarget);
                      }}
                    >
                      <span class="compose-dd__item-title">Auto</span>
                      <span class="compose-dd__item-sub mono">Use config default for coding</span>
                    </button>
                  ${
                    modelsCatalog.length === 0
                      ? html`
                          <div class="compose-dd__empty muted">No model catalog loaded.</div>
                        `
                      : codingModels.length === 0
                        ? html`
                            <div class="compose-dd__empty muted">No coding models available.</div>
                          `
                        : codingModels.map((entry) => {
                            const key = entry.key;
                            const activeKey = effectiveCodingModelKey?.trim() || null;
                            const selected =
                              Boolean(activeKey) && key.toLowerCase() === activeKey!.toLowerCase();
                            return html`
                              <button
                                class="compose-dd__item ${selected ? "is-selected" : ""}"
                                type="button"
                                role="menuitem"
                                data-filter=${`${entry.label} ${key}`}
                                ?disabled=${isBusy || !props.connected || !props.onSessionCodingModelChange}
                                @click=${(e: Event) => {
                                  props.onSessionCodingModelChange?.(key);
                                  closeDetailsForTarget(e.currentTarget);
                                }}
                              >
                                <span class="compose-dd__item-title">${entry.label}</span>
                                <span class="compose-dd__item-sub mono">${key}</span>
                              </button>
                            `;
                          })
                  }
                  </div>
                </div>
              </details>

              <button
                class="compose-pill"
                type="button"
                ?disabled=${!props.connected || (!canAbort && props.sending)}
                @click=${canAbort ? props.onAbort : props.onNewSession}
                aria-label=${canAbort ? "Stop" : "New session"}
                title=${canAbort ? "Stop" : "New session"}
              >
                ${canAbort ? "Stop" : "New"}
              </button>

              <button
                class="compose-send"
                type="button"
                ?disabled=${!props.connected}
                @click=${props.onSend}
                aria-label=${isBusy ? "Queue" : "Send"}
                title=${isBusy ? "Queue" : "Send"}
              >
                ${icons.send}
                <span class="compose-send__kbd" aria-hidden="true">↵</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
}

const CHAT_HISTORY_RENDER_LIMIT = 200;

function extractSenderIdentity(
  message: unknown,
): { agentId?: string; name?: string; emoji?: string; avatar?: string } | undefined {
  const m = message as Record<string, unknown>;
  const identity = m.senderIdentity as Record<string, unknown> | undefined;
  if (!identity) {
    return undefined;
  }
  return {
    agentId: typeof identity.agentId === "string" ? identity.agentId : undefined,
    name: typeof identity.name === "string" ? identity.name : undefined,
    emoji: typeof identity.emoji === "string" ? identity.emoji : undefined,
    avatar: typeof identity.avatar === "string" ? identity.avatar : undefined,
  };
}

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
    const senderIdentity = extractSenderIdentity(item.message);
    // Create a grouping key that includes sender identity for subagent messages
    const senderKey = senderIdentity?.agentId ?? "";

    // Start new group if role or sender changed
    const shouldStartNewGroup =
      !currentGroup ||
      currentGroup.role !== role ||
      (currentGroup.senderIdentity?.agentId ?? "") !== senderKey;

    if (shouldStartNewGroup) {
      if (currentGroup) {
        result.push(currentGroup);
      }
      currentGroup = {
        kind: "group",
        key: `group:${role}:${senderKey}:${timestamp}`,
        role,
        messages: [{ message: item.message, key: item.key }],
        timestamp,
        isStreaming: false,
        senderIdentity,
      };
    } else {
      currentGroup!.messages.push({ message: item.message, key: item.key });
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
    // Use a stable key per session — avoid changing key when streamStartedAt transitions from null to a timestamp.
    const key = `stream:${props.sessionKey}:active`;
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
  // Use content hash for stability instead of index (index shifts when history reloads).
  const timestamp = typeof m.timestamp === "number" ? m.timestamp : 0;
  const role = typeof m.role === "string" ? m.role : "unknown";
  const content = typeof m.content === "string" ? m.content : "";
  const contentHash =
    content.length > 0 ? content.length.toString(36) + content.charCodeAt(0).toString(36) : "e";
  return `msg:${role}:${timestamp}:${contentHash}`;
}
