import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";

// ── Diary entry parser ─────────────────────────────────────────────────

type DiaryEntry = {
  date: string;
  body: string;
};

type DiaryEntryNav = {
  date: string;
  body: string;
  page: number;
  timestamp: number | null;
  signalWeight: number;
};

type StructuredDiaryEntry = {
  whatHappened: string[];
  reflections: string[];
  candidates: string[];
  lastingUpdates: string[];
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

function formatDiaryMonthLabel(date: string): string {
  const parsed = parseDiaryTimestamp(date);
  if (parsed === null) {
    return date;
  }
  return new Date(parsed).toLocaleDateString([], {
    month: "short",
  });
}

function normalizeStructuredDiaryItem(line: string): string {
  return line
    .replace(/^(?:\d+\.\s+|-\s+(?:\[[^\]]+\]\s+)?(?:[a-z_]+:\s+)?|\[[^\]]+\]\s+)/i, "")
    .replace(/^(?:likely_durable|likely_situational|unclear):\s+/i, "")
    .trim();
}

function parseStructuredDiaryEntry(body: string): StructuredDiaryEntry | null {
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return null;
  }
  const sections: StructuredDiaryEntry = {
    whatHappened: [],
    reflections: [],
    candidates: [],
    lastingUpdates: [],
  };
  let current: keyof StructuredDiaryEntry | null = null;
  for (const line of lines) {
    if (line === "What Happened") {
      current = "whatHappened";
      continue;
    }
    if (line === "Reflections") {
      current = "reflections";
      continue;
    }
    if (line === "Candidates") {
      current = "candidates";
      continue;
    }
    if (line === "Possible Lasting Updates") {
      current = "lastingUpdates";
      continue;
    }
    if (!current) {
      continue;
    }
    sections[current].push(normalizeStructuredDiaryItem(line));
  }
  if (
    sections.whatHappened.length === 0 &&
    sections.reflections.length === 0 &&
    sections.candidates.length === 0 &&
    sections.lastingUpdates.length === 0
  ) {
    return null;
  }
  return sections;
}

function scoreStructuredDiaryEntry(entry: StructuredDiaryEntry | null): number {
  if (!entry) {
    return 1;
  }
  return Math.max(
    1,
    entry.whatHappened.length +
      entry.reflections.length +
      entry.candidates.length * 2 +
      entry.lastingUpdates.length * 3,
  );
}

function buildDiaryNavigation(entries: DiaryEntry[]): DiaryEntryNav[] {
  const reversed = [...entries].toReversed();
  return reversed.map((entry, page) => ({
    ...entry,
    page,
    timestamp: parseDiaryTimestamp(entry.date),
    signalWeight: scoreStructuredDiaryEntry(parseStructuredDiaryEntry(entry.body)),
  }));
}

const DIARY_LABEL_INTERVAL = 7;

function shouldShowDiaryLabel(
  entries: DiaryEntryNav[],
  index: number,
  activePage: number,
): boolean {
  if (index === activePage || index === 0 || index % DIARY_LABEL_INTERVAL === 0) {
    return true;
  }
  const previous = entries[index - 1];
  return (
    formatDiaryMonthLabel(previous?.date ?? "") !==
    formatDiaryMonthLabel(entries[index]?.date ?? "")
  );
}

function renderDiaryNavigator(
  entries: DiaryEntryNav[],
  activePage: number,
  requestUpdate?: () => void,
) {
  return html`
    <div class="dreams-diary__timeline" aria-label="Diary day browser">
      <div class="dreams-diary__timeline-months">
        ${entries.map((entry, index) => {
          const previous = entries[index - 1];
          const showLabel =
            index === 0 ||
            formatDiaryMonthLabel(previous?.date ?? "") !== formatDiaryMonthLabel(entry.date);
          return html`
            <span
              class="dreams-diary__timeline-month ${showLabel
                ? ""
                : "dreams-diary__timeline-month--ghost"}"
            >
              ${showLabel ? formatDiaryMonthLabel(entry.date) : ""}
            </span>
          `;
        })}
      </div>
      <div class="dreams-diary__timeline-days">
        ${entries.map(
          (entry, index) => html`
            <button
              class="dreams-diary__day-chip ${entry.page === activePage
                ? "dreams-diary__day-chip--active"
                : ""}"
              @click=${() => {
                setDiaryPage(entry.page);
                requestUpdate?.();
              }}
              title=${entry.date}
            >
              ${shouldShowDiaryLabel(entries, index, activePage)
                ? formatDiaryChipLabel(entry.date)
                : html`<span aria-hidden="true">&nbsp;</span>`}
            </button>
          `,
        )}
      </div>
      <div class="dreams-diary__heatmap" aria-label="Diary activity map">
        ${entries.map((entry) => {
          const intensity = Math.min(4, Math.max(1, entry.signalWeight));
          return html`
            <button
              class="dreams-diary__heatmap-cell ${entry.page === activePage
                ? "dreams-diary__heatmap-cell--active"
                : ""}"
              data-intensity=${String(intensity)}
              @click=${() => {
                setDiaryPage(entry.page);
                requestUpdate?.();
              }}
              title=${`${entry.date} · ${entry.signalWeight} signals`}
            >
              <span class="dreams-diary__heatmap-pill"></span>
            </button>
          `;
        })}
      </div>
    </div>
  `;
}

export type DreamingProps = {
  active: boolean;
  shortTermCount: number;
  totalSignalCount: number;
  promotedCount: number;
  phaseSignalCount: number;
  shortTermEntries: {
    key: string;
    path: string;
    startLine: number;
    endLine: number;
    snippet: string;
    recallCount: number;
    dailyCount: number;
    totalSignalCount: number;
    lightHits: number;
    remHits: number;
    phaseHitCount: number;
    promotedAt?: string;
    lastRecalledAt?: string;
  }[];
  signalEntries: {
    key: string;
    path: string;
    startLine: number;
    endLine: number;
    snippet: string;
    recallCount: number;
    dailyCount: number;
    totalSignalCount: number;
    lightHits: number;
    remHits: number;
    phaseHitCount: number;
    promotedAt?: string;
    lastRecalledAt?: string;
  }[];
  promotedEntries: {
    key: string;
    path: string;
    startLine: number;
    endLine: number;
    snippet: string;
    recallCount: number;
    dailyCount: number;
    totalSignalCount: number;
    lightHits: number;
    remHits: number;
    phaseHitCount: number;
    promotedAt?: string;
    lastRecalledAt?: string;
  }[];
  dreamingOf: string | null;
  nextCycle: string | null;
  timezone: string | null;
  statusLoading: boolean;
  statusError: string | null;
  modeSaving: boolean;
  dreamDiaryLoading: boolean;
  dreamDiaryActionLoading: boolean;
  dreamDiaryError: string | null;
  dreamDiaryPath: string | null;
  dreamDiaryContent: string | null;
  onRefresh: () => void;
  onRefreshDiary: () => void;
  onBackfillDiary: () => void;
  onResetDiary: () => void;
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

      <div class="dreams__actions">
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
            >${props.promotedCount}</span
          >
          <span class="dreams__stat-label">${t("dreaming.stats.promoted")}</span>
        </div>
      </div>

      <div class="dreams__trace">
        ${renderTraceSection("shortTerm", props.shortTermEntries, {
          count: props.shortTermCount,
          emptyKey: "dreaming.trace.emptyShortTerm",
          meta: (entry) =>
            [
              entry.recallCount > 0
                ? `${entry.recallCount} recall${entry.recallCount === 1 ? "" : "s"}`
                : null,
              entry.dailyCount > 0 ? `${entry.dailyCount} daily` : null,
              entry.phaseHitCount > 0
                ? `${entry.phaseHitCount} phase hit${entry.phaseHitCount === 1 ? "" : "s"}`
                : null,
            ]
              .filter(Boolean)
              .join(" · "),
        })}
        ${renderTraceSection("signals", props.signalEntries, {
          count: props.totalSignalCount,
          emptyKey: "dreaming.trace.emptySignals",
          meta: (entry) =>
            [
              `${entry.totalSignalCount} signal${entry.totalSignalCount === 1 ? "" : "s"}`,
              entry.phaseHitCount > 0
                ? `${entry.phaseHitCount} phase hit${entry.phaseHitCount === 1 ? "" : "s"}`
                : null,
            ]
              .filter(Boolean)
              .join(" · "),
        })}
        ${renderTraceSection("promoted", props.promotedEntries, {
          count: props.promotedCount,
          emptyKey: "dreaming.trace.emptyPromoted",
          meta: (entry) =>
            [
              entry.promotedAt ? formatCompactDateTime(entry.promotedAt) : null,
              entry.totalSignalCount > 0
                ? `${entry.totalSignalCount} signal${entry.totalSignalCount === 1 ? "" : "s"} before promote`
                : null,
            ]
              .filter(Boolean)
              .join(" · "),
        })}
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

function renderTraceSection(
  kind: "shortTerm" | "signals" | "promoted",
  entries: DreamingProps["shortTermEntries"],
  options: {
    count: number;
    emptyKey: string;
    meta: (entry: DreamingProps["shortTermEntries"][number]) => string;
  },
) {
  return html`
    <section class="dreams__trace-section">
      <div class="dreams__trace-header">
        <span class="dreams__trace-title">${t(`dreaming.trace.${kind}`)}</span>
        <span class="dreams__trace-count">${options.count}</span>
      </div>
      ${entries.length === 0
        ? html`<div class="dreams__trace-empty">${t(options.emptyKey)}</div>`
        : html`
            <div class="dreams__trace-list">
              ${entries.map(
                (entry) => html`
                  <article class="dreams__trace-item" data-kind=${kind} data-key=${entry.key}>
                    <div class="dreams__trace-snippet">${entry.snippet}</div>
                    <div class="dreams__trace-source">
                      ${formatRange(entry.path, entry.startLine, entry.endLine)}
                    </div>
                    <div class="dreams__trace-meta">${options.meta(entry)}</div>
                  </article>
                `,
              )}
            </div>
          `}
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

  const reversed = buildDiaryNavigation(entries);
  // Clamp page.
  const page = Math.max(0, Math.min(_diaryPage, reversed.length - 1));
  const entry = reversed[page];
  const hasPrev = page > 0;
  const hasNext = page < reversed.length - 1;
  const structured = parseStructuredDiaryEntry(entry.body);

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

      <div class="dreams-diary__navigator">
        <div class="dreams-diary__navigator-content">
          ${renderDiaryNavigator(reversed, page, props.onRequestUpdate)}
        </div>
      </div>

      <article
        class="dreams-diary__entry ${structured ? "dreams-diary__entry--structured" : ""}"
        key="${page}"
      >
        <div class="dreams-diary__accent"></div>
        ${entry.date ? html`<time class="dreams-diary__date">${entry.date}</time>` : nothing}
        ${structured
          ? html`
              <div class="dreams-diary__grid">
                <section class="dreams-diary__panel">
                  <h3 class="dreams-diary__panel-title">What Happened</h3>
                  <div class="dreams-diary__panel-list dreams-diary__panel-list--points">
                    ${structured.whatHappened.map(
                      (item, i) => html`
                        <div
                          class="dreams-diary__point"
                          style="animation-delay: ${0.2 + i * 0.06}s;"
                        >
                          <span class="dreams-diary__point-bullet"></span>
                          <p class="dreams-diary__item">${item}</p>
                        </div>
                      `,
                    )}
                  </div>
                </section>
                <section class="dreams-diary__panel">
                  <h3 class="dreams-diary__panel-title">Reflections</h3>
                  <div class="dreams-diary__panel-list dreams-diary__panel-list--points">
                    ${structured.reflections.map(
                      (item, i) => html`
                        <div
                          class="dreams-diary__point"
                          style="animation-delay: ${0.26 + i * 0.06}s;"
                        >
                          <span class="dreams-diary__point-bullet"></span>
                          <p class="dreams-diary__item dreams-diary__item--reflection">${item}</p>
                        </div>
                      `,
                    )}
                  </div>
                </section>
                <section class="dreams-diary__panel">
                  <h3 class="dreams-diary__panel-title">Candidates + Possible Lasting Updates</h3>
                  ${structured.candidates.length > 0
                    ? html`
                        <div class="dreams-diary__panel-subtitle">Candidates</div>
                        <div class="dreams-diary__panel-list dreams-diary__panel-list--points">
                          ${structured.candidates.map(
                            (item, i) => html`
                              <div
                                class="dreams-diary__point"
                                style="animation-delay: ${0.32 + i * 0.06}s;"
                              >
                                <span class="dreams-diary__point-bullet"></span>
                                <p class="dreams-diary__item">${item}</p>
                              </div>
                            `,
                          )}
                        </div>
                      `
                    : nothing}
                  ${structured.lastingUpdates.length > 0
                    ? html`
                        <div class="dreams-diary__panel-subtitle">Possible Lasting Updates</div>
                        <div class="dreams-diary__panel-list dreams-diary__panel-list--points">
                          ${structured.lastingUpdates.map(
                            (item, i) => html`
                              <div
                                class="dreams-diary__point"
                                style="animation-delay: ${0.38 + i * 0.06}s;"
                              >
                                <span class="dreams-diary__point-bullet"></span>
                                <p class="dreams-diary__item dreams-diary__item--update">${item}</p>
                              </div>
                            `,
                          )}
                        </div>
                      `
                    : nothing}
                </section>
              </div>
            `
          : html`
              <div class="dreams-diary__prose">
                ${entry.body
                  .split("\n")
                  .map(
                    (para, i) =>
                      html`<p
                        class="dreams-diary__para"
                        style="animation-delay: ${0.3 + i * 0.15}s;"
                      >
                        ${para}
                      </p>`,
                  )}
              </div>
            `}
      </article>
    </section>
  `;
}
