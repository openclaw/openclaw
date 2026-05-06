import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { t } from "../../i18n/index.ts";
import type {
  DreamingEntry,
  WikiImportInsights,
  WikiMemoryPalace,
} from "../controllers/dreaming.ts";
import { toSanitizedMarkdownHtml } from "../markdown.ts";
import { viDashboardText as uiText } from "../vi-dashboard-text.ts";

// ── Diary entry parser ─────────────────────────────────────────────────

type DiaryEntry = {
  date: string;
  body: string;
};

type DiaryEntryNav = {
  date: string;
  body: string;
  page: number;
};

const DIARY_START_RE = /<!--\s*openclaw:dreaming:diary:start\s*-->/;
const DIARY_END_RE = /<!--\s*openclaw:dreaming:diary:end\s*-->/;

function parseDiaryEntries(raw: string): DiaryEntry[] {
  // Extract content between diary markers, or use full content.
  let content = raw;
  const startMatch = DIARY_START_RE.exec(raw);
  const endMatch = DIARY_END_RE.exec(raw);
  if (startMatch && endMatch && endMatch.index > startMatch.index) {
    content = raw.slice(startMatch.index + startMatch[0].length, endMatch.index);
  }

  const entries: DiaryEntry[] = [];
  // Split on --- separators.
  const blocks = content.split(/\n---\n/).filter((b) => b.trim().length > 0);

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    let date = "";
    const bodyLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      // Date lines are wrapped in *asterisks* like: *April 5, 2026, 3:00 AM*
      if (!date && trimmed.startsWith("*") && trimmed.endsWith("*") && trimmed.length > 2) {
        date = trimmed.slice(1, -1);
        continue;
      }
      // Skip heading lines and HTML comments.
      if (trimmed.startsWith("#") || trimmed.startsWith("<!--")) {
        continue;
      }
      if (trimmed.length > 0) {
        bodyLines.push(trimmed);
      }
    }

    if (bodyLines.length > 0) {
      entries.push({ date, body: bodyLines.join("\n") });
    }
  }

  return entries;
}

function parseDiaryTimestamp(date: string): number | null {
  const parsed = Date.parse(date);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDiaryChipLabel(date: string): string {
  const parsed = parseDiaryTimestamp(date);
  if (parsed === null) {
    return date;
  }
  const value = new Date(parsed);
  return `${value.getMonth() + 1}/${value.getDate()}`;
}

function buildDiaryNavigation(entries: DiaryEntry[]): DiaryEntryNav[] {
  const reversed = [...entries].toReversed();
  return reversed.map((entry, page) => Object.assign({}, entry, { page }));
}

type DreamingPhaseInfo = {
  enabled: boolean;
  cron: string;
  nextRunAtMs?: number;
};

export type DreamingProps = {
  active: boolean;
  shortTermCount: number;
  groundedSignalCount: number;
  totalSignalCount: number;
  promotedCount: number;
  phases?: {
    light: DreamingPhaseInfo;
    deep: DreamingPhaseInfo;
    rem: DreamingPhaseInfo;
  };
  shortTermEntries: DreamingEntry[];
  promotedEntries: DreamingEntry[];
  dreamingOf: string | null;
  nextCycle: string | null;
  timezone: string | null;
  statusLoading: boolean;
  statusError: string | null;
  modeSaving: boolean;
  dreamDiaryLoading: boolean;
  dreamDiaryActionLoading: boolean;
  dreamDiaryActionMessage: { kind: "success" | "error"; text: string } | null;
  dreamDiaryActionArchivePath: string | null;
  dreamDiaryError: string | null;
  dreamDiaryPath: string | null;
  dreamDiaryContent: string | null;
  memoryWikiEnabled: boolean;
  wikiImportInsightsLoading: boolean;
  wikiImportInsightsError: string | null;
  wikiImportInsights: WikiImportInsights | null;
  wikiMemoryPalaceLoading: boolean;
  wikiMemoryPalaceError: string | null;
  wikiMemoryPalace: WikiMemoryPalace | null;
  onRefresh: () => void;
  onRefreshDiary: () => void;
  onRefreshImports: () => void;
  onRefreshMemoryPalace: () => void;
  onOpenConfig: () => void;
  onOpenWikiPage: (lookup: string) => Promise<{
    title: string;
    path: string;
    content: string;
    totalLines?: number;
    truncated?: boolean;
    updatedAt?: string;
  } | null>;
  onBackfillDiary: () => void;
  onCopyDreamingArchivePath: () => void;
  onDedupeDreamDiary: () => void;
  onResetDiary: () => void;
  onResetGroundedShortTerm: () => void;
  onRepairDreamingArtifacts: () => void;
  onRequestUpdate?: () => void;
};

const DREAM_PHRASE_KEYS = [
  "dreaming.phrases.consolidatingMemories",
  "dreaming.phrases.tidyingKnowledgeGraph",
  "dreaming.phrases.replayingConversations",
  "dreaming.phrases.weavingShortTerm",
  "dreaming.phrases.defragmentingMindPalace",
  "dreaming.phrases.filingLooseThoughts",
  "dreaming.phrases.connectingDots",
  "dreaming.phrases.compostingContext",
  "dreaming.phrases.alphabetizingSubconscious",
  "dreaming.phrases.promotingHunches",
  "dreaming.phrases.forgettingNoise",
  "dreaming.phrases.dreamingEmbeddings",
  "dreaming.phrases.reorganizingAttic",
  "dreaming.phrases.indexingDay",
  "dreaming.phrases.nurturingInsights",
  "dreaming.phrases.simmeringIdeas",
  "dreaming.phrases.whisperingVectorStore",
] as const;

const DREAM_PHASE_LABEL_KEYS = {
  light: "dreaming.phase.light",
  deep: "dreaming.phase.deep",
  rem: "dreaming.phase.rem",
} as const;

let dreamIndex = Math.floor(Math.random() * DREAM_PHRASE_KEYS.length);
let dreamLastSwap = 0;
const DREAM_SWAP_MS = 6_000;

// ── Sub-tab state ─────────────────────────────────────────────────────

type DreamSubTab = "scene" | "diary" | "advanced";
let activeSubTab: DreamSubTab = "scene";
type DreamDiarySubTab = "dreams" | "insights" | "palace";
let activeDiarySubTab: DreamDiarySubTab = "dreams";
type AdvancedWaitingSort = "recent" | "signals";
let advancedWaitingSort: AdvancedWaitingSort = "recent";
const expandedInsightCards = new Set<string>();
const expandedPalaceCards = new Set<string>();
let wikiPreviewOpen = false;
let wikiPreviewLoading = false;
let wikiPreviewTitle = "";
let wikiPreviewPath = "";
let wikiPreviewUpdatedAt: string | null = null;
let wikiPreviewContent = "";
let wikiPreviewTotalLines: number | null = null;
let wikiPreviewTruncated = false;
let wikiPreviewError: string | null = null;

export function setDreamSubTab(tab: DreamSubTab): void {
  activeSubTab = tab;
}

export function setDreamAdvancedWaitingSort(sort: AdvancedWaitingSort): void {
  advancedWaitingSort = sort;
}

export function setDreamDiarySubTab(tab: DreamDiarySubTab): void {
  activeDiarySubTab = tab;
}

// ── Diary pagination state ─────────────────────────────────────────────

let diaryPage = 0;
let diaryEntryCount = 0;

/** Navigate to a specific diary page. Triggers a re-render via Lit's reactive cycle. */
export function setDiaryPage(page: number): void {
  diaryPage = Math.max(0, Math.min(page, Math.max(0, diaryEntryCount - 1)));
}

function currentDreamPhrase(): string {
  const now = Date.now();
  if (now - dreamLastSwap > DREAM_SWAP_MS) {
    dreamLastSwap = now;
    dreamIndex = (dreamIndex + 1) % DREAM_PHRASE_KEYS.length;
  }
  return t(DREAM_PHRASE_KEYS[dreamIndex] ?? DREAM_PHRASE_KEYS[0]);
}

const STARS: {
  top: number;
  left: number;
  size: number;
  delay: number;
  hue: "neutral" | "accent";
}[] = [
  { top: 8, left: 15, size: 3, delay: 0, hue: "neutral" },
  { top: 12, left: 72, size: 2, delay: 1.4, hue: "neutral" },
  { top: 22, left: 35, size: 3, delay: 0.6, hue: "accent" },
  { top: 18, left: 88, size: 2, delay: 2.1, hue: "neutral" },
  { top: 35, left: 8, size: 2, delay: 0.9, hue: "neutral" },
  { top: 45, left: 92, size: 2, delay: 1.7, hue: "neutral" },
  { top: 55, left: 25, size: 3, delay: 2.5, hue: "accent" },
  { top: 65, left: 78, size: 2, delay: 0.3, hue: "neutral" },
  { top: 75, left: 45, size: 2, delay: 1.1, hue: "neutral" },
  { top: 82, left: 60, size: 3, delay: 1.8, hue: "accent" },
  { top: 30, left: 55, size: 2, delay: 0.4, hue: "neutral" },
  { top: 88, left: 18, size: 2, delay: 2.3, hue: "neutral" },
];

const sleepingLobster = html`
  <svg viewBox="0 0 120 120" fill="none">
    <defs>
      <linearGradient id="dream-lob-g" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#ff4d4d" />
        <stop offset="100%" stop-color="#991b1b" />
      </linearGradient>
    </defs>
    <path
      d="M60 10C30 10 15 35 15 55C15 75 30 95 45 100L45 110L55 110L55 100C55 100 60 102 65 100L65 110L75 110L75 100C90 95 105 75 105 55C105 35 90 10 60 10Z"
      fill="url(#dream-lob-g)"
    />
    <path d="M20 45C5 40 0 50 5 60C10 70 20 65 25 55C28 48 25 45 20 45Z" fill="url(#dream-lob-g)" />
    <path
      d="M100 45C115 40 120 50 115 60C110 70 100 65 95 55C92 48 95 45 100 45Z"
      fill="url(#dream-lob-g)"
    />
    <path d="M45 15Q38 8 35 14" stroke="#ff4d4d" stroke-width="3" stroke-linecap="round" />
    <path d="M75 15Q82 8 85 14" stroke="#ff4d4d" stroke-width="3" stroke-linecap="round" />
    <path
      d="M39 36Q45 32 51 36"
      stroke="#050810"
      stroke-width="2.5"
      stroke-linecap="round"
      fill="none"
    />
    <path
      d="M69 36Q75 32 81 36"
      stroke="#050810"
      stroke-width="2.5"
      stroke-linecap="round"
      fill="none"
    />
  </svg>
`;

export function renderDreaming(props: DreamingProps) {
  const idle = !props.active;
  const dreamText = props.dreamingOf ?? currentDreamPhrase();

  return html`
    <div class="dreams-page">
      <!-- ── Sub-tab bar ── -->
      <nav class="dreams__tabs">
        <button
          class="dreams__tab ${activeSubTab === "scene" ? "dreams__tab--active" : ""}"
          @click=${() => {
            activeSubTab = "scene";
            props.onRequestUpdate?.();
          }}
        >
          ${t("dreaming.tabs.scene")}
        </button>
        <button
          class="dreams__tab ${activeSubTab === "diary" ? "dreams__tab--active" : ""}"
          @click=${() => {
            activeSubTab = "diary";
            props.onRequestUpdate?.();
          }}
        >
          ${t("dreaming.tabs.diary")}
        </button>
        <button
          class="dreams__tab ${activeSubTab === "advanced" ? "dreams__tab--active" : ""}"
          @click=${() => {
            activeSubTab = "advanced";
            props.onRequestUpdate?.();
          }}
        >
          ${t("dreaming.tabs.advanced")}
        </button>
      </nav>

      ${activeSubTab === "scene"
        ? renderScene(props, idle, dreamText)
        : activeSubTab === "diary"
          ? renderDiarySection(props)
          : renderAdvancedSection(props)}
    </div>
  `;
}

// ── Scene renderer ────────────────────────────────────────────────────

// Strip source citations like [memory/2026-04-09.md:9] and section headings,
// flatten structured diary entries into plain paragraphs.
function flattenDiaryBody(body: string): string[] {
  return (
    body
      .split("\n")
      .map((line) => line.trim())
      // Remove section headings that leak implementation
      .filter(
        (line) =>
          line.length > 0 &&
          line !== "What Happened" &&
          line !== "Reflections" &&
          line !== "Candidates" &&
          line !== "Possible Lasting Updates",
      )
      // Strip source citations [memory/...]
      .map((line) => line.replace(/\s*\[memory\/[^\]]+\]/g, ""))
      // Strip leading list markers and labels
      .map((line) =>
        line
          .replace(/^(?:\d+\.\s+|-\s+(?:\[[^\]]+\]\s+)?(?:[a-z_]+:\s+)?)/i, "")
          .replace(/^(?:likely_durable|likely_situational|unclear):\s+/i, "")
          .trim(),
      )
      .filter((line) => line.length > 0)
  );
}

function formatPhaseNextRun(nextRunAtMs?: number): string {
  if (!nextRunAtMs) {
    return "—";
  }
  const d = new Date(nextRunAtMs);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function renderScene(props: DreamingProps, idle: boolean, dreamText: string) {
  return html`
    <section class="dreams ${idle ? "dreams--idle" : ""}">
      ${STARS.map(
        (s) => html`
          <div
            class="dreams__star"
            style="
              top: ${s.top}%;
              left: ${s.left}%;
              width: ${s.size}px;
              height: ${s.size}px;
              background: ${s.hue === "accent" ? "var(--accent-muted)" : "var(--text)"};
              animation-delay: ${s.delay}s;
            "
          ></div>
        `,
      )}

      <div class="dreams__moon"></div>

      ${props.active
        ? html`
            <div class="dreams__bubble">
              <span class="dreams__bubble-text">${dreamText}</span>
            </div>
            <div
              class="dreams__bubble-dot"
              style="top: calc(50% - 160px); left: calc(50% - 120px); width: 12px; height: 12px; animation-delay: 0.2s;"
            ></div>
            <div
              class="dreams__bubble-dot"
              style="top: calc(50% - 120px); left: calc(50% - 90px); width: 8px; height: 8px; animation-delay: 0.4s;"
            ></div>
          `
        : nothing}

      <div class="dreams__glow"></div>
      <div class="dreams__lobster">${sleepingLobster}</div>
      <span class="dreams__z">z</span>
      <span class="dreams__z">z</span>
      <span class="dreams__z">Z</span>

      <div class="dreams__status">
        <span class="dreams__status-label"
          >${props.active ? t("dreaming.status.active") : t("dreaming.status.idle")}</span
        >
        <div class="dreams__status-detail">
          <div class="dreams__status-dot"></div>
          <span>
            ${props.promotedCount} ${t("dreaming.status.promotedSuffix")}
            ${props.nextCycle
              ? html`· ${t("dreaming.status.nextSweepPrefix")} ${props.nextCycle}`
              : nothing}
            ${props.timezone ? html`· ${props.timezone}` : nothing}
          </span>
        </div>
      </div>

      <!-- Sleep phases -->
      <div class="dreams__phases">
        ${(Object.keys(DREAM_PHASE_LABEL_KEYS) as (keyof typeof DREAM_PHASE_LABEL_KEYS)[]).map(
          (phaseId) => {
            const phase = props.phases?.[phaseId];
            const hasPhaseStatus = phase !== undefined;
            const enabled = phase?.enabled === true;
            const nextRun = formatPhaseNextRun(phase?.nextRunAtMs);
            const label = t(DREAM_PHASE_LABEL_KEYS[phaseId]);
            const status = !hasPhaseStatus ? "—" : enabled ? nextRun : t("dreaming.phase.off");
            return html`
              <div class="dreams__phase ${hasPhaseStatus && !enabled ? "dreams__phase--off" : ""}">
                <div class="dreams__phase-dot ${enabled ? "dreams__phase-dot--on" : ""}"></div>
                <span class="dreams__phase-name">${label}</span>
                <span class="dreams__phase-next">${status}</span>
              </div>
            `;
          },
        )}
      </div>

      ${props.statusError
        ? html`<div class="dreams__controls-error">${props.statusError}</div>`
        : nothing}
    </section>
  `;
}

function formatRange(path: string, startLine: number, endLine: number): string {
  return startLine === endLine ? `${path}:${startLine}` : `${path}:${startLine}-${endLine}`;
}

function formatCompactDateTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return new Date(parsed).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function basename(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return normalized.split("/").findLast(Boolean) ?? value;
}

function formatKindLabel(kind: "entity" | "concept" | "source" | "synthesis" | "report"): string {
  switch (kind) {
    case "entity":
      return uiText("entity", "thực thể");
    case "concept":
      return uiText("concept", "khái niệm");
    case "source":
      return uiText("source", "nguồn");
    case "synthesis":
      return uiText("synthesis", "tổng hợp");
    case "report":
      return uiText("report", "báo cáo");
  }
  return kind;
}

function formatCount(count: number, singular: string, plural: string, viUnit: string): string {
  return uiText(`${count} ${count === 1 ? singular : plural}`, `${count} ${viUnit}`);
}

function formatImportBadge(item: {
  digestStatus: "available" | "withheld";
  riskLevel: "low" | "medium" | "high" | "unknown";
}): string {
  if (item.digestStatus === "withheld") {
    return uiText("needs review", "cần rà soát");
  }
  switch (item.riskLevel) {
    case "low":
      return uiText("low risk", "rủi ro thấp");
    case "medium":
      return uiText("medium risk", "rủi ro vừa");
    case "high":
      return uiText("high risk", "rủi ro cao");
    case "unknown":
      return uiText("unknown risk", "chưa rõ rủi ro");
  }
  return uiText("unknown risk", "chưa rõ rủi ro");
}

function toggleExpandedCard(bucket: Set<string>, key: string, requestUpdate?: () => void): void {
  if (bucket.has(key)) {
    bucket.delete(key);
  } else {
    bucket.add(key);
  }
  requestUpdate?.();
}

async function openWikiPreview(lookup: string, props: DreamingProps): Promise<void> {
  wikiPreviewOpen = true;
  wikiPreviewLoading = true;
  wikiPreviewTitle = basename(lookup);
  wikiPreviewPath = lookup;
  wikiPreviewUpdatedAt = null;
  wikiPreviewContent = "";
  wikiPreviewTotalLines = null;
  wikiPreviewTruncated = false;
  wikiPreviewError = null;
  props.onRequestUpdate?.();
  try {
    const preview = await props.onOpenWikiPage(lookup);
    if (!preview) {
      wikiPreviewError = uiText(
        `No wiki page found for ${lookup}.`,
        `Không tìm thấy trang wiki cho ${lookup}.`,
      );
      return;
    }
    wikiPreviewTitle = preview.title;
    wikiPreviewPath = preview.path;
    wikiPreviewUpdatedAt = preview.updatedAt ?? null;
    wikiPreviewContent = preview.content;
    wikiPreviewTotalLines = typeof preview.totalLines === "number" ? preview.totalLines : null;
    wikiPreviewTruncated = preview.truncated === true;
  } catch (error) {
    wikiPreviewError = String(error);
  } finally {
    wikiPreviewLoading = false;
    props.onRequestUpdate?.();
  }
}

function closeWikiPreview(requestUpdate?: () => void): void {
  wikiPreviewOpen = false;
  wikiPreviewLoading = false;
  wikiPreviewTitle = "";
  wikiPreviewPath = "";
  wikiPreviewUpdatedAt = null;
  wikiPreviewContent = "";
  wikiPreviewTotalLines = null;
  wikiPreviewTruncated = false;
  wikiPreviewError = null;
  requestUpdate?.();
}

function renderWikiPreviewOverlay(props: DreamingProps) {
  if (!wikiPreviewOpen) {
    return nothing;
  }
  return html`
    <div
      class="dreams-diary__preview-backdrop"
      @click=${() => closeWikiPreview(props.onRequestUpdate)}
    >
      <div class="dreams-diary__preview-panel" @click=${(event: Event) => event.stopPropagation()}>
        <div class="dreams-diary__preview-header">
          <div>
            <div class="dreams-diary__preview-title">
              ${wikiPreviewTitle || uiText("Wiki page", "Trang wiki")}
            </div>
            <div class="dreams-diary__preview-meta">
              ${wikiPreviewPath} ${wikiPreviewUpdatedAt ? ` · ${wikiPreviewUpdatedAt}` : ""}
            </div>
          </div>
          <button
            class="btn btn--subtle btn--sm"
            @click=${() => closeWikiPreview(props.onRequestUpdate)}
          >
            ${uiText("Close", "Đóng")}
          </button>
        </div>
        <div class="dreams-diary__preview-body">
          ${wikiPreviewLoading
            ? html`<div class="dreams-diary__empty-text">
                ${uiText("Loading wiki page…", "Đang tải trang wiki…")}
              </div>`
            : wikiPreviewError
              ? html`<div class="dreams-diary__error">${wikiPreviewError}</div>`
              : html`
                  ${wikiPreviewTruncated
                    ? html`
                        <div class="dreams-diary__preview-hint">
                          ${uiText(
                            "Showing the first chunk of this page",
                            "Đang hiển thị phần đầu của trang này",
                          )}${wikiPreviewTotalLines !== null
                            ? uiText(
                                ` (${wikiPreviewTotalLines} total lines)`,
                                ` (tổng ${wikiPreviewTotalLines} dòng)`,
                              )
                            : ""}.
                        </div>
                      `
                    : nothing}
                  <pre class="dreams-diary__preview-pre">${wikiPreviewContent}</pre>
                `}
        </div>
      </div>
    </div>
  `;
}

function renderDiarySubtabExplainer() {
  switch (activeDiarySubTab) {
    case "dreams":
      return html`
        <p class="dreams-diary__explainer">
          ${uiText(
            "This is the raw dream diary the system writes while replaying and consolidating memory; use it to inspect what the memory system is noticing, and where it still looks noisy or thin.",
            "Đây là nhật ký mơ thô mà hệ thống ghi khi replay và hợp nhất bộ nhớ; dùng mục này để xem hệ thống bộ nhớ đang nhận ra điều gì, phần nào còn nhiễu hoặc còn mỏng.",
          )}
        </p>
      `;
    case "insights":
      return html`
        <p class="dreams-diary__explainer">
          ${uiText(
            "These are imported insights clustered from external history; use them to review what imports surfaced before any of it graduates into durable memory.",
            "Đây là các insight được nhập và gom cụm từ lịch sử bên ngoài; dùng để rà những gì import đã phát hiện trước khi nội dung đó được đưa vào bộ nhớ bền vững.",
          )}
        </p>
      `;
    case "palace":
      return html`
        <p class="dreams-diary__explainer">
          ${uiText(
            "This is the compiled memory wiki surface the system can search and reason over; use it to inspect actual memory pages, claims, open questions, and contradictions rather than raw imported source chats.",
            "Đây là bề mặt Memory Wiki đã biên dịch để hệ thống tìm kiếm và suy luận; dùng để kiểm tra các trang bộ nhớ, luận điểm, câu hỏi mở và mâu thuẫn thay vì xem thô các chat nguồn đã import.",
          )}
        </p>
      `;
  }
  return nothing;
}

function parseSortableTimestamp(value?: string): number {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareWaitingEntryByRecency(a: DreamingEntry, b: DreamingEntry): number {
  const aMs = parseSortableTimestamp(a.lastRecalledAt);
  const bMs = parseSortableTimestamp(b.lastRecalledAt);
  if (bMs !== aMs) {
    return bMs - aMs;
  }
  if (b.totalSignalCount !== a.totalSignalCount) {
    return b.totalSignalCount - a.totalSignalCount;
  }
  return a.path.localeCompare(b.path);
}

function compareWaitingEntryBySignals(a: DreamingEntry, b: DreamingEntry): number {
  if (b.totalSignalCount !== a.totalSignalCount) {
    return b.totalSignalCount - a.totalSignalCount;
  }
  if (b.phaseHitCount !== a.phaseHitCount) {
    return b.phaseHitCount - a.phaseHitCount;
  }
  return compareWaitingEntryByRecency(a, b);
}

function sortWaitingEntries(entries: DreamingEntry[], sort: AdvancedWaitingSort): DreamingEntry[] {
  return sort === "signals"
    ? entries.toSorted(compareWaitingEntryBySignals)
    : entries.toSorted(compareWaitingEntryByRecency);
}

function describeWaitingEntryOrigin(entry: DreamingEntry): string {
  const hasGroundedReplay = entry.groundedCount > 0;
  const hasLiveSupport = entry.recallCount > 0 || entry.dailyCount > 0;
  if (hasGroundedReplay && hasLiveSupport) {
    return t("dreaming.advanced.originMixed");
  }
  if (hasGroundedReplay) {
    return t("dreaming.advanced.originDailyLog");
  }
  return t("dreaming.advanced.originLive");
}

function renderAdvancedEntryList(params: {
  titleKey: string;
  descriptionKey: string;
  emptyKey: string;
  entries: DreamingEntry[];
  meta: (entry: DreamingEntry) => string[];
  badge?: (entry: DreamingEntry) => string | null;
  controls?: ReturnType<typeof html>;
}) {
  return html`
    <section class="dreams-advanced__section">
      <div class="dreams-advanced__section-header">
        <div class="dreams-advanced__section-copy">
          <span class="dreams-advanced__section-title">${t(params.titleKey)}</span>
          <p class="dreams-advanced__section-description">${t(params.descriptionKey)}</p>
        </div>
        <div class="dreams-advanced__section-toolbar">
          ${params.controls ?? nothing}
          <span class="dreams-advanced__section-count">${params.entries.length}</span>
        </div>
      </div>
      ${params.entries.length === 0
        ? html`<div class="dreams-advanced__empty">${t(params.emptyKey)}</div>`
        : html`
            <div class="dreams-advanced__list">
              ${params.entries.map(
                (entry) => html`
                  <article class="dreams-advanced__item" data-entry-key=${entry.key}>
                    ${params.badge
                      ? (() => {
                          const label = params.badge?.(entry);
                          return label
                            ? html`<span class="dreams-advanced__badge">${label}</span>`
                            : nothing;
                        })()
                      : nothing}
                    <div class="dreams-advanced__snippet">${entry.snippet}</div>
                    <div class="dreams-advanced__source">
                      ${formatRange(entry.path, entry.startLine, entry.endLine)}
                    </div>
                    <div class="dreams-advanced__meta">
                      ${params
                        .meta(entry)
                        .filter((part) => part.length > 0)
                        .join(" · ")}
                    </div>
                  </article>
                `,
              )}
            </div>
          `}
    </section>
  `;
}

function renderAdvancedSection(props: DreamingProps) {
  const groundedEntries = props.shortTermEntries.filter((entry) => entry.groundedCount > 0);
  const waitingEntries = sortWaitingEntries(props.shortTermEntries, advancedWaitingSort);
  const description = t("dreaming.advanced.description");
  const summary = [
    `${groundedEntries.length} ${t("dreaming.advanced.summaryFromDailyLog")}`,
    `${props.shortTermCount} ${t("dreaming.advanced.summaryWaiting")}`,
    `${props.promotedCount} ${t("dreaming.advanced.summaryPromotedToday")}`,
  ].join(" · ");

  return html`
    <section class="dreams-advanced">
      <div class="dreams-advanced__header">
        <div class="dreams-advanced__intro">
          <span class="dreams-advanced__eyebrow">${t("dreaming.advanced.eyebrow")}</span>
          <h2 class="dreams-advanced__title">${t("dreaming.advanced.title")}</h2>
          ${description
            ? html`<p class="dreams-advanced__description">${description}</p>`
            : nothing}
          <div class="dreams-advanced__summary">${summary}</div>
        </div>
        <div class="dreams-advanced__actions">
          <button
            class="btn btn--subtle btn--sm"
            ?disabled=${props.modeSaving || props.dreamDiaryActionLoading}
            @click=${() => props.onDedupeDreamDiary()}
          >
            ${t("dreaming.scene.dedupeDiary")}
          </button>
          <button
            class="btn btn--subtle btn--sm"
            ?disabled=${props.modeSaving || props.dreamDiaryActionLoading}
            @click=${() => props.onRepairDreamingArtifacts()}
          >
            ${t("dreaming.scene.repairCache")}
          </button>
          <button
            class="btn btn--subtle btn--sm"
            ?disabled=${props.modeSaving || props.dreamDiaryActionLoading}
            @click=${() => props.onBackfillDiary()}
          >
            ${props.dreamDiaryActionLoading
              ? t("dreaming.scene.working")
              : t("dreaming.scene.backfill")}
          </button>
          <button
            class="btn btn--subtle btn--sm"
            ?disabled=${props.modeSaving || props.dreamDiaryActionLoading}
            @click=${() => props.onResetDiary()}
          >
            ${t("dreaming.scene.reset")}
          </button>
          <button
            class="btn btn--subtle btn--sm"
            ?disabled=${props.modeSaving || props.dreamDiaryActionLoading}
            @click=${() => props.onResetGroundedShortTerm()}
          >
            ${t("dreaming.scene.clearGrounded")}
          </button>
        </div>
      </div>
      ${props.dreamDiaryActionMessage
        ? html`
            <div
              class="callout ${props.dreamDiaryActionMessage.kind === "success"
                ? "success"
                : "danger"}"
              role="status"
            >
              <div class="row wrap items-center gap-2">
                <span>${props.dreamDiaryActionMessage.text}</span>
                ${props.dreamDiaryActionArchivePath
                  ? html`
                      <button
                        class="btn btn--subtle btn--sm"
                        ?disabled=${props.dreamDiaryActionLoading}
                        @click=${() => props.onCopyDreamingArchivePath()}
                      >
                        ${uiText("Copy archive path", "Sao chép đường dẫn archive")}
                      </button>
                    `
                  : nothing}
              </div>
            </div>
          `
        : nothing}

      <div class="dreams-advanced__sections">
        ${renderAdvancedEntryList({
          titleKey: "dreaming.advanced.stagedTitle",
          descriptionKey: "dreaming.advanced.stagedDescription",
          emptyKey: "dreaming.advanced.emptyGrounded",
          entries: groundedEntries,
          controls: html`
            <button
              class="btn btn--subtle btn--sm"
              ?disabled=${props.modeSaving || props.dreamDiaryActionLoading}
              @click=${() => props.onResetGroundedShortTerm()}
            >
              ${t("dreaming.scene.clearGrounded")}
            </button>
          `,
          badge: () => t("dreaming.advanced.originDailyLog"),
          meta: (entry) => [
            entry.groundedCount > 0
              ? `${entry.groundedCount} ${t("dreaming.stats.grounded").toLowerCase()}`
              : "",
            entry.recallCount > 0
              ? formatCount(entry.recallCount, "recall", "recalls", "lần recall")
              : "",
            entry.dailyCount > 0
              ? formatCount(entry.dailyCount, "daily", "daily", "mục hằng ngày")
              : "",
          ],
        })}
        ${renderAdvancedEntryList({
          titleKey: "dreaming.advanced.shortTermTitle",
          descriptionKey: "dreaming.advanced.shortTermDescription",
          emptyKey: "dreaming.advanced.emptyShortTerm",
          entries: waitingEntries,
          controls: html`
            <div class="dreams-advanced__sort">
              <button
                class="dreams-advanced__sort-btn ${advancedWaitingSort === "recent"
                  ? "dreams-advanced__sort-btn--active"
                  : ""}"
                @click=${() => {
                  advancedWaitingSort = "recent";
                  props.onRequestUpdate?.();
                }}
              >
                ${t("dreaming.advanced.sortRecent")}
              </button>
              <button
                class="dreams-advanced__sort-btn ${advancedWaitingSort === "signals"
                  ? "dreams-advanced__sort-btn--active"
                  : ""}"
                @click=${() => {
                  advancedWaitingSort = "signals";
                  props.onRequestUpdate?.();
                }}
              >
                ${t("dreaming.advanced.sortSignals")}
              </button>
            </div>
          `,
          badge: (entry) => describeWaitingEntryOrigin(entry),
          meta: (entry) => [
            `${entry.totalSignalCount} ${t("dreaming.stats.signals").toLowerCase()}`,
            entry.recallCount > 0
              ? formatCount(entry.recallCount, "recall", "recalls", "lần recall")
              : "",
            entry.dailyCount > 0
              ? formatCount(entry.dailyCount, "daily", "daily", "mục hằng ngày")
              : "",
            entry.groundedCount > 0
              ? `${entry.groundedCount} ${t("dreaming.stats.grounded").toLowerCase()}`
              : "",
            entry.phaseHitCount > 0
              ? formatCount(entry.phaseHitCount, "phase hit", "phase hits", "lần khớp phase")
              : "",
          ],
        })}
        ${renderAdvancedEntryList({
          titleKey: "dreaming.advanced.promotedTitle",
          descriptionKey: "dreaming.advanced.promotedDescription",
          emptyKey: "dreaming.advanced.emptyPromoted",
          entries: props.promotedEntries,
          badge: (entry) => describeWaitingEntryOrigin(entry),
          meta: (entry) => [
            entry.promotedAt
              ? `${t("dreaming.advanced.updatedPrefix")} ${formatCompactDateTime(entry.promotedAt)}`
              : "",
            entry.groundedCount > 0
              ? `${entry.groundedCount} ${t("dreaming.stats.grounded").toLowerCase()}`
              : "",
            entry.totalSignalCount > 0
              ? `${entry.totalSignalCount} ${t("dreaming.stats.signals").toLowerCase()}`
              : "",
          ],
        })}
      </div>

      ${props.statusError
        ? html`<div class="dreams__controls-error">${props.statusError}</div>`
        : nothing}
    </section>
  `;
}

function renderDiaryImportsSection(props: DreamingProps) {
  const importInsights = props.wikiImportInsights;
  const clusters = importInsights?.clusters ?? [];

  if (props.wikiImportInsightsLoading && clusters.length === 0) {
    return html`
      <div class="dreams-diary__empty">
        <div class="dreams-diary__empty-text">
          ${uiText("Loading imported insights…", "Đang tải insight đã import…")}
        </div>
      </div>
    `;
  }

  if (clusters.length === 0) {
    return html`
      <div class="dreams-diary__empty">
        <div class="dreams-diary__empty-text">
          ${uiText("No imported insights yet", "Chưa có insight đã import")}
        </div>
        <div class="dreams-diary__empty-hint">
          ${uiText(
            "Run a ChatGPT import with apply to surface clustered imported insights here.",
            "Chạy import ChatGPT với apply để hiện các insight đã gom cụm tại đây.",
          )}
        </div>
      </div>
    `;
  }

  diaryEntryCount = clusters.length;
  const clusterIndex = Math.max(0, Math.min(diaryPage, clusters.length - 1));
  const cluster = clusters[clusterIndex];

  return html`
    <div class="dreams-diary__daychips">
      ${clusters.map(
        (entry, index) => html`
          <button
            class="dreams-diary__day-chip ${index === clusterIndex
              ? "dreams-diary__day-chip--active"
              : ""}"
            @click=${() => {
              setDiaryPage(index);
              props.onRequestUpdate?.();
            }}
          >
            ${entry.label}
          </button>
        `,
      )}
    </div>

    <article class="dreams-diary__entry" key="imports-${cluster.key}">
      <div class="dreams-diary__accent"></div>
      <div class="dreams-diary__date">
        ${cluster.label} · ${formatCount(cluster.itemCount, "chat", "chats", "chat")}
        ${cluster.highRiskCount > 0
          ? html`· ${formatCount(cluster.highRiskCount, "sensitive", "sensitive", "nhạy cảm")}`
          : nothing}
        ${cluster.preferenceSignalCount > 0
          ? html`· ${formatCount(cluster.preferenceSignalCount, "signal", "signals", "tín hiệu")}`
          : nothing}
      </div>
      <div class="dreams-diary__prose">
        <p class="dreams-diary__para">
          ${uiText(
            `Imported chats clustered around ${cluster.label.toLowerCase()}.`,
            `Các chat đã import được gom quanh ${cluster.label.toLowerCase()}.`,
          )}
          ${cluster.withheldCount > 0
            ? uiText(
                ` ${cluster.withheldCount} digest${cluster.withheldCount === 1 ? " was" : "s were"} withheld pending review.`,
                ` ${cluster.withheldCount} bản tóm tắt đang được giữ lại để chờ rà soát.`,
              )
            : ""}
        </p>
      </div>
      <div class="dreams-diary__insights">
        ${cluster.items.map((item) => {
          const expanded = expandedInsightCards.has(item.pagePath);
          return html`
            <article
              class="dreams-diary__insight-card dreams-diary__insight-card--clickable"
              data-import-page=${item.pagePath}
              @click=${() =>
                toggleExpandedCard(expandedInsightCards, item.pagePath, props.onRequestUpdate)}
            >
              <div class="dreams-diary__insight-topline">
                <div class="dreams-diary__insight-title">${item.title}</div>
                <span
                  class="dreams-diary__insight-badge dreams-diary__insight-badge--${item.riskLevel}"
                >
                  ${formatImportBadge(item)}
                </span>
              </div>
              <div class="dreams-diary__insight-meta">
                ${item.updatedAt ? formatCompactDateTime(item.updatedAt) : basename(item.pagePath)}
                ${item.activeBranchMessages > 0
                  ? uiText(
                      ` · ${item.activeBranchMessages} messages`,
                      ` · ${item.activeBranchMessages} tin nhắn`,
                    )
                  : ""}
              </div>
              <p class="dreams-diary__insight-line">${item.summary}</p>
              ${item.candidateSignals.length > 0
                ? html`
                    <div class="dreams-diary__insight-list">
                      <strong
                        >${uiText("Potentially useful signals", "Tín hiệu có thể hữu ích")}</strong
                      >
                      ${item.candidateSignals.map(
                        (signal) => html`<p class="dreams-diary__insight-line">• ${signal}</p>`,
                      )}
                    </div>
                  `
                : nothing}
              ${item.correctionSignals.length > 0
                ? html`
                    <div class="dreams-diary__insight-list">
                      <strong
                        >${uiText("Corrections or revisions", "Điều chỉnh hoặc đính chính")}</strong
                      >
                      ${item.correctionSignals.map(
                        (signal) => html`<p class="dreams-diary__insight-line">• ${signal}</p>`,
                      )}
                    </div>
                  `
                : nothing}
              ${expanded
                ? html`
                    <div class="dreams-diary__insight-list">
                      <strong>${uiText("Import details", "Chi tiết import")}</strong>
                      ${item.firstUserLine
                        ? html`
                            <p class="dreams-diary__insight-line">
                              <strong>${uiText("Started with:", "Bắt đầu bằng:")}</strong>
                              ${item.firstUserLine}
                            </p>
                          `
                        : nothing}
                      ${item.lastUserLine && item.lastUserLine !== item.firstUserLine
                        ? html`
                            <p class="dreams-diary__insight-line">
                              <strong>${uiText("Ended on:", "Kết thúc ở:")}</strong>
                              ${item.lastUserLine}
                            </p>
                          `
                        : nothing}
                      <p class="dreams-diary__insight-line">
                        <strong>${uiText("Messages:", "Tin nhắn:")}</strong>
                        ${formatCount(item.userMessageCount, "user", "user", "người dùng")} ·
                        ${formatCount(
                          item.assistantMessageCount,
                          "assistant",
                          "assistant",
                          "trợ lý",
                        )}
                      </p>
                      ${item.riskReasons.length > 0
                        ? html`
                            <p class="dreams-diary__insight-line">
                              <strong>${uiText("Risk reasons:", "Lý do rủi ro:")}</strong>
                              ${item.riskReasons.join(", ")}
                            </p>
                          `
                        : nothing}
                      ${item.labels.length > 0
                        ? html`
                            <p class="dreams-diary__insight-line">
                              <strong>${uiText("Labels:", "Nhãn:")}</strong>
                              ${item.labels.join(", ")}
                            </p>
                          `
                        : nothing}
                    </div>
                  `
                : nothing}
              ${item.preferenceSignals.length > 0
                ? html`
                    <div class="dreams-diary__insight-signals">
                      ${item.preferenceSignals.map(
                        (signal) =>
                          html`<span class="dreams-diary__insight-signal">${signal}</span>`,
                      )}
                    </div>
                  `
                : nothing}
              <div class="dreams-diary__insight-actions">
                <button
                  class="btn btn--subtle btn--sm"
                  @click=${(event: Event) => {
                    event.stopPropagation();
                    toggleExpandedCard(expandedInsightCards, item.pagePath, props.onRequestUpdate);
                  }}
                >
                  ${expanded
                    ? uiText("Hide details", "Ẩn chi tiết")
                    : uiText("Details", "Chi tiết")}
                </button>
                <button
                  class="btn btn--subtle btn--sm"
                  @click=${(event: Event) => {
                    event.stopPropagation();
                    void openWikiPreview(item.pagePath, props);
                  }}
                >
                  ${uiText("Open source page", "Mở trang nguồn")}
                </button>
              </div>
            </article>
          `;
        })}
      </div>
    </article>
  `;
}

function renderMemoryPalaceSection(props: DreamingProps) {
  const palace = props.wikiMemoryPalace;
  const clusters = palace?.clusters ?? [];

  if (props.wikiMemoryPalaceLoading && clusters.length === 0) {
    return html`
      <div class="dreams-diary__empty">
        <div class="dreams-diary__empty-text">
          ${uiText("Loading memory palace…", "Đang tải Memory Palace…")}
        </div>
      </div>
    `;
  }

  if (clusters.length === 0) {
    return html`
      <div class="dreams-diary__empty">
        <div class="dreams-diary__empty-text">
          ${uiText("Memory palace is not populated yet", "Memory Palace chưa có dữ liệu")}
        </div>
        <div class="dreams-diary__empty-hint">
          ${uiText(
            "Right now the wiki mostly has raw source imports and operational reports. This tab becomes useful once syntheses, entities, or concepts start getting written.",
            "Hiện wiki chủ yếu có import nguồn thô và báo cáo vận hành. Tab này sẽ hữu ích hơn khi các bản tổng hợp, thực thể hoặc khái niệm bắt đầu được ghi.",
          )}
        </div>
      </div>
    `;
  }

  diaryEntryCount = clusters.length;
  const clusterIndex = Math.max(0, Math.min(diaryPage, clusters.length - 1));
  const cluster = clusters[clusterIndex];

  return html`
    <div class="dreams-diary__daychips">
      ${clusters.map(
        (entry, index) => html`
          <button
            class="dreams-diary__day-chip ${index === clusterIndex
              ? "dreams-diary__day-chip--active"
              : ""}"
            @click=${() => {
              setDiaryPage(index);
              props.onRequestUpdate?.();
            }}
          >
            ${entry.label}
          </button>
        `,
      )}
    </div>

    <article class="dreams-diary__entry" key="palace-${cluster.key}">
      <div class="dreams-diary__accent"></div>
      <div class="dreams-diary__date">
        ${cluster.label} · ${formatCount(cluster.itemCount, "page", "pages", "trang")}
        ${cluster.claimCount > 0
          ? html`· ${formatCount(cluster.claimCount, "claim", "claims", "luận điểm")}`
          : nothing}
        ${cluster.questionCount > 0
          ? html`· ${formatCount(cluster.questionCount, "question", "questions", "câu hỏi")}`
          : nothing}
        ${cluster.contradictionCount > 0
          ? html`·
            ${formatCount(
              cluster.contradictionCount,
              "contradiction",
              "contradictions",
              "mâu thuẫn",
            )}`
          : nothing}
      </div>
      <div class="dreams-diary__prose">
        <p class="dreams-diary__para">
          ${uiText(
            `Compiled wiki pages currently grouped under ${cluster.label.toLowerCase()}.`,
            `Các trang wiki đã biên dịch đang được gom dưới ${cluster.label.toLowerCase()}.`,
          )}
          ${cluster.updatedAt
            ? uiText(
                ` Latest update ${formatCompactDateTime(cluster.updatedAt)}.`,
                ` Cập nhật gần nhất ${formatCompactDateTime(cluster.updatedAt)}.`,
              )
            : ""}
        </p>
      </div>
      <div class="dreams-diary__insights">
        ${cluster.items.map((item) => {
          const expanded = expandedPalaceCards.has(item.pagePath);
          return html`
            <article
              class="dreams-diary__insight-card dreams-diary__insight-card--clickable"
              data-palace-page=${item.pagePath}
              @click=${() =>
                toggleExpandedCard(expandedPalaceCards, item.pagePath, props.onRequestUpdate)}
            >
              <div class="dreams-diary__insight-topline">
                <div class="dreams-diary__insight-title">${item.title}</div>
                <span class="dreams-diary__insight-badge dreams-diary__insight-badge--palace">
                  ${formatKindLabel(item.kind)}
                </span>
              </div>
              <div class="dreams-diary__insight-meta">
                ${item.updatedAt ? formatCompactDateTime(item.updatedAt) : basename(item.pagePath)}
                · ${item.pagePath}
              </div>
              ${item.snippet
                ? html`<p class="dreams-diary__insight-line">${item.snippet}</p>`
                : nothing}
              ${item.claims.length > 0
                ? html`
                    <div class="dreams-diary__insight-list">
                      <strong>${uiText("Claims", "Luận điểm")}</strong>
                      ${item.claims.map(
                        (claim) => html`<p class="dreams-diary__insight-line">• ${claim}</p>`,
                      )}
                    </div>
                  `
                : nothing}
              ${item.questions.length > 0
                ? html`
                    <div class="dreams-diary__insight-list">
                      <strong>${uiText("Open questions", "Câu hỏi mở")}</strong>
                      ${item.questions.map(
                        (question) => html`<p class="dreams-diary__insight-line">• ${question}</p>`,
                      )}
                    </div>
                  `
                : nothing}
              ${item.contradictions.length > 0
                ? html`
                    <div class="dreams-diary__insight-list">
                      <strong>${uiText("Contradictions", "Mâu thuẫn")}</strong>
                      ${item.contradictions.map(
                        (entry) => html`<p class="dreams-diary__insight-line">• ${entry}</p>`,
                      )}
                    </div>
                  `
                : nothing}
              ${expanded
                ? html`
                    <div class="dreams-diary__insight-list">
                      <strong>${uiText("Page details", "Chi tiết trang")}</strong>
                      <p class="dreams-diary__insight-line">
                        <strong>${uiText("Wiki page:", "Trang wiki:")}</strong> ${item.pagePath}
                      </p>
                      ${item.id
                        ? html`
                            <p class="dreams-diary__insight-line">
                              <strong>${uiText("Id:", "ID:")}</strong> ${item.id}
                            </p>
                          `
                        : nothing}
                    </div>
                  `
                : nothing}
              <div class="dreams-diary__insight-actions">
                <button
                  class="btn btn--subtle btn--sm"
                  @click=${(event: Event) => {
                    event.stopPropagation();
                    toggleExpandedCard(expandedPalaceCards, item.pagePath, props.onRequestUpdate);
                  }}
                >
                  ${expanded
                    ? uiText("Hide details", "Ẩn chi tiết")
                    : uiText("Details", "Chi tiết")}
                </button>
                <button
                  class="btn btn--subtle btn--sm"
                  @click=${(event: Event) => {
                    event.stopPropagation();
                    void openWikiPreview(item.pagePath, props);
                  }}
                >
                  ${uiText("Open wiki page", "Mở trang wiki")}
                </button>
              </div>
            </article>
          `;
        })}
      </div>
    </article>
  `;
}

function renderDreamDiaryEntries(props: DreamingProps) {
  if (typeof props.dreamDiaryContent !== "string") {
    return html`
      <div class="dreams-diary__empty">
        <div class="dreams-diary__empty-moon">
          <svg viewBox="0 0 32 32" fill="none" width="32" height="32">
            <circle cx="16" cy="16" r="14" stroke="currentColor" stroke-width="0.5" opacity="0.2" />
            <path d="M20 8a10 10 0 0 1 0 16 10 10 0 1 0 0-16z" fill="currentColor" opacity="0.08" />
          </svg>
        </div>
        <div class="dreams-diary__empty-text">${t("dreaming.diary.noDreamsYet")}</div>
        <div class="dreams-diary__empty-hint">${t("dreaming.diary.noDreamsHint")}</div>
      </div>
    `;
  }

  const entries = parseDiaryEntries(props.dreamDiaryContent);
  diaryEntryCount = entries.length;

  if (entries.length === 0) {
    return html`
      <div class="dreams-diary__empty">
        <div class="dreams-diary__empty-text">${t("dreaming.diary.waitingTitle")}</div>
        <div class="dreams-diary__empty-hint">${t("dreaming.diary.waitingHint")}</div>
      </div>
    `;
  }

  const reversed = buildDiaryNavigation(entries);
  const page = Math.max(0, Math.min(diaryPage, reversed.length - 1));
  const entry = reversed[page];

  return html`
    <div class="dreams-diary__daychips">
      ${reversed.map(
        (e) => html`
          <button
            class="dreams-diary__day-chip ${e.page === page
              ? "dreams-diary__day-chip--active"
              : ""}"
            @click=${() => {
              setDiaryPage(e.page);
              props.onRequestUpdate?.();
            }}
          >
            ${formatDiaryChipLabel(e.date)}
          </button>
        `,
      )}
    </div>
    <article class="dreams-diary__entry" key="${page}">
      <div class="dreams-diary__accent"></div>
      ${entry.date ? html`<time class="dreams-diary__date">${entry.date}</time>` : nothing}
      <div class="dreams-diary__prose">
        ${flattenDiaryBody(entry.body).map(
          (para, i) =>
            html`<p class="dreams-diary__para" style="animation-delay: ${0.3 + i * 0.15}s;">
              ${unsafeHTML(toSanitizedMarkdownHtml(para))}
            </p>`,
        )}
      </div>
    </article>
  `;
}

// ── Diary section renderer ────────────────────────────────────────────

function renderDiarySection(props: DreamingProps) {
  const wikiTabSelected = activeDiarySubTab === "insights" || activeDiarySubTab === "palace";
  const memoryWikiUnavailable = wikiTabSelected && !props.memoryWikiEnabled;
  const diaryError =
    activeDiarySubTab === "dreams"
      ? props.dreamDiaryError
      : activeDiarySubTab === "insights"
        ? props.wikiImportInsightsError
        : props.wikiMemoryPalaceError;
  if (diaryError && !memoryWikiUnavailable) {
    return html`
      <section class="dreams-diary">
        <div class="dreams-diary__error">${diaryError}</div>
      </section>
    `;
  }

  return html`
    <section class="dreams-diary">
      <div class="dreams-diary__chrome">
        <div class="dreams-diary__header">
          <span class="dreams-diary__title">${t("dreaming.diary.title")}</span>
          <div class="dreams-diary__subtabs">
            <button
              class="dreams-diary__subtab ${activeDiarySubTab === "dreams"
                ? "dreams-diary__subtab--active"
                : ""}"
              @click=${() => {
                closeWikiPreview();
                activeDiarySubTab = "dreams";
                diaryPage = 0;
                props.onRequestUpdate?.();
              }}
            >
              ${uiText("Dreams", "Giấc mơ")}
            </button>
            <button
              class="dreams-diary__subtab ${activeDiarySubTab === "insights"
                ? "dreams-diary__subtab--active"
                : ""}"
              @click=${() => {
                closeWikiPreview();
                activeDiarySubTab = "insights";
                diaryPage = 0;
                props.onRequestUpdate?.();
              }}
            >
              ${uiText("Imported Insights", "Insight đã import")}
            </button>
            <button
              class="dreams-diary__subtab ${activeDiarySubTab === "palace"
                ? "dreams-diary__subtab--active"
                : ""}"
              @click=${() => {
                closeWikiPreview();
                activeDiarySubTab = "palace";
                diaryPage = 0;
                props.onRequestUpdate?.();
              }}
            >
              ${uiText("Memory Palace", "Memory Palace")}
            </button>
          </div>
          <button
            class="btn btn--subtle btn--sm"
            ?disabled=${memoryWikiUnavailable
              ? false
              : props.modeSaving ||
                (activeDiarySubTab === "dreams"
                  ? props.dreamDiaryLoading
                  : activeDiarySubTab === "insights"
                    ? props.wikiImportInsightsLoading
                    : props.wikiMemoryPalaceLoading)}
            @click=${() => {
              diaryPage = 0;
              if (memoryWikiUnavailable) {
                props.onOpenConfig();
              } else if (activeDiarySubTab === "dreams") {
                props.onRefreshDiary();
              } else if (activeDiarySubTab === "insights") {
                props.onRefreshImports();
              } else {
                props.onRefreshMemoryPalace();
              }
            }}
          >
            ${memoryWikiUnavailable
              ? uiText("How to enable", "Cách bật")
              : activeDiarySubTab === "dreams"
                ? props.dreamDiaryLoading
                  ? t("dreaming.diary.reloading")
                  : t("dreaming.diary.reload")
                : activeDiarySubTab === "insights"
                  ? props.wikiImportInsightsLoading
                    ? uiText("Reloading…", "Đang tải lại…")
                    : uiText("Reload", "Tải lại")
                  : props.wikiMemoryPalaceLoading
                    ? uiText("Reloading…", "Đang tải lại…")
                    : uiText("Reload", "Tải lại")}
          </button>
        </div>
        ${renderDiarySubtabExplainer()}
      </div>

      ${memoryWikiUnavailable
        ? html`
            <div class="dreams-diary__empty">
              <div class="dreams-diary__empty-text">
                ${uiText("Memory Wiki is not enabled", "Memory Wiki chưa được bật")}
              </div>
              <div class="dreams-diary__empty-hint">
                ${uiText(
                  "Imported Insights and Memory Palace are provided by the bundled",
                  "Insight đã import và Memory Palace được cung cấp bởi plugin tích hợp",
                )}
                <code>memory-wiki</code>.
              </div>
              <div class="dreams-diary__empty-hint">
                ${uiText("Enable", "Bật")}
                <code>plugins.entries.memory-wiki.enabled = true</code>,
                ${uiText("then reload this tab.", "rồi tải lại tab này.")}
              </div>
              <div class="dreams-diary__empty-actions">
                <button class="btn btn--subtle btn--sm" @click=${() => props.onOpenConfig()}>
                  ${uiText("Open Config", "Mở Cấu hình")}
                </button>
              </div>
            </div>
          `
        : activeDiarySubTab === "dreams"
          ? renderDreamDiaryEntries(props)
          : activeDiarySubTab === "insights"
            ? renderDiaryImportsSection(props)
            : renderMemoryPalaceSection(props)}
      ${renderWikiPreviewOverlay(props)}
    </section>
  `;
}
