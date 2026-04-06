import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";

// ── Diary entry parser ─────────────────────────────────────────────────

type DiaryEntry = {
  date: string;
  body: string;
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

export type DreamingProps = {
  active: boolean;
  shortTermCount: number;
  totalSignalCount: number;
  phaseSignalCount: number;
  promotedCount: number;
  dreamingOf: string | null;
  nextCycle: string | null;
  timezone: string | null;
  statusLoading: boolean;
  statusError: string | null;
  modeSaving: boolean;
  dreamDiaryLoading: boolean;
  dreamDiaryError: string | null;
  dreamDiaryPath: string | null;
  dreamDiaryContent: string | null;
  onRefresh: () => void;
  onRefreshDiary: () => void;
  onToggleEnabled: (enabled: boolean) => void;
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

let _dreamIndex = Math.floor(Math.random() * DREAM_PHRASE_KEYS.length);
let _dreamLastSwap = 0;
const DREAM_SWAP_MS = 6_000;

// ── Sub-tab state ─────────────────────────────────────────────────────

type DreamSubTab = "scene" | "diary";
let _subTab: DreamSubTab = "scene";

export function setDreamSubTab(tab: DreamSubTab): void {
  _subTab = tab;
}

// ── Diary pagination state ─────────────────────────────────────────────

let _diaryPage = 0;
let _diaryEntryCount = 0;

/** Navigate to a specific diary page. Triggers a re-render via Lit's reactive cycle. */
export function setDiaryPage(page: number): void {
  _diaryPage = Math.max(0, Math.min(page, Math.max(0, _diaryEntryCount - 1)));
}

function currentDreamPhrase(): string {
  const now = Date.now();
  if (now - _dreamLastSwap > DREAM_SWAP_MS) {
    _dreamLastSwap = now;
    _dreamIndex = (_dreamIndex + 1) % DREAM_PHRASE_KEYS.length;
  }
  return t(DREAM_PHRASE_KEYS[_dreamIndex] ?? DREAM_PHRASE_KEYS[0]);
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
          class="dreams__tab ${_subTab === "scene" ? "dreams__tab--active" : ""}"
          @click=${() => {
            _subTab = "scene";
            props.onRequestUpdate?.();
          }}
        >
          ${t("dreaming.tabs.scene")}
        </button>
        <button
          class="dreams__tab ${_subTab === "diary" ? "dreams__tab--active" : ""}"
          @click=${() => {
            _subTab = "diary";
            props.onRequestUpdate?.();
          }}
        >
          ${t("dreaming.tabs.diary")}
        </button>
      </nav>

      ${_subTab === "scene" ? renderScene(props, idle, dreamText) : renderDiarySection(props)}
    </div>
  `;
}

// ── Scene renderer ────────────────────────────────────────────────────

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

      <div class="dreams__stats">
        <div class="dreams__stat">
          <span class="dreams__stat-value" style="color: var(--text-strong);"
            >${props.shortTermCount}</span
          >
          <span class="dreams__stat-label">${t("dreaming.stats.shortTerm")}</span>
        </div>
        <div class="dreams__stat-divider"></div>
        <div class="dreams__stat">
          <span class="dreams__stat-value" style="color: var(--accent);"
            >${props.totalSignalCount}</span
          >
          <span class="dreams__stat-label">${t("dreaming.stats.signals")}</span>
        </div>
        <div class="dreams__stat-divider"></div>
        <div class="dreams__stat">
          <span class="dreams__stat-value" style="color: var(--accent-2);"
            >${props.phaseSignalCount}</span
          >
          <span class="dreams__stat-label">${t("dreaming.stats.phaseHits")}</span>
        </div>
      </div>

      ${props.statusError
        ? html`<div class="dreams__controls-error">${props.statusError}</div>`
        : nothing}
    </section>
  `;
}

// ── Diary section renderer ────────────────────────────────────────────

function renderDiarySection(props: DreamingProps) {
  if (props.dreamDiaryError) {
    return html`
      <section class="dreams-diary">
        <div class="dreams-diary__error">${props.dreamDiaryError}</div>
      </section>
    `;
  }

  if (typeof props.dreamDiaryContent !== "string") {
    return html`
      <section class="dreams-diary">
        <div class="dreams-diary__empty">
          <div class="dreams-diary__empty-moon">
            <svg viewBox="0 0 32 32" fill="none" width="32" height="32">
              <circle
                cx="16"
                cy="16"
                r="14"
                stroke="currentColor"
                stroke-width="0.5"
                opacity="0.2"
              />
              <path
                d="M20 8a10 10 0 0 1 0 16 10 10 0 1 0 0-16z"
                fill="currentColor"
                opacity="0.08"
              />
            </svg>
          </div>
          <div class="dreams-diary__empty-text">${t("dreaming.diary.noDreamsYet")}</div>
          <div class="dreams-diary__empty-hint">${t("dreaming.diary.noDreamsHint")}</div>
        </div>
      </section>
    `;
  }

  const entries = parseDiaryEntries(props.dreamDiaryContent);
  _diaryEntryCount = entries.length;

  if (entries.length === 0) {
    return html`
      <section class="dreams-diary">
        <div class="dreams-diary__empty">
          <div class="dreams-diary__empty-text">${t("dreaming.diary.waitingTitle")}</div>
          <div class="dreams-diary__empty-hint">${t("dreaming.diary.waitingHint")}</div>
        </div>
      </section>
    `;
  }

  // Show most recent entries first (reverse chronological).
  const reversed = [...entries].toReversed();
  // Clamp page.
  const page = Math.max(0, Math.min(_diaryPage, reversed.length - 1));
  const entry = reversed[page];
  const hasPrev = page > 0;
  const hasNext = page < reversed.length - 1;

  return html`
    <section class="dreams-diary">
      <div class="dreams-diary__header">
        <span class="dreams-diary__title">${t("dreaming.diary.title")}</span>
        <div class="dreams-diary__nav">
          <button
            class="dreams-diary__nav-btn"
            ?disabled=${!hasNext}
            @click=${() => {
              setDiaryPage(page + 1);
              props.onRequestUpdate?.();
            }}
            title=${t("dreaming.diary.older")}
          >
            ‹
          </button>
          <span class="dreams-diary__page">${page + 1} / ${reversed.length}</span>
          <button
            class="dreams-diary__nav-btn"
            ?disabled=${!hasPrev}
            @click=${() => {
              setDiaryPage(page - 1);
              props.onRequestUpdate?.();
            }}
            title=${t("dreaming.diary.newer")}
          >
            ›
          </button>
        </div>
        <button
          class="btn btn--subtle btn--sm"
          ?disabled=${props.modeSaving || props.dreamDiaryLoading}
          @click=${() => {
            _diaryPage = 0;
            props.onRefreshDiary();
          }}
        >
          ${props.dreamDiaryLoading ? t("dreaming.diary.reloading") : t("dreaming.diary.reload")}
        </button>
      </div>

      <article class="dreams-diary__entry" key="${page}">
        <div class="dreams-diary__accent"></div>
        ${entry.date ? html`<time class="dreams-diary__date">${entry.date}</time>` : nothing}
        <div class="dreams-diary__prose">
          ${entry.body
            .split("\n")
            .map(
              (para, i) =>
                html`<p class="dreams-diary__para" style="animation-delay: ${0.3 + i * 0.15}s;">
                  ${para}
                </p>`,
            )}
        </div>
      </article>
    </section>
  `;
}
