import { html, nothing } from "lit";
import type { DreamingMode } from "../controllers/dreaming.ts";

export type DreamingProps = {
  active: boolean;
  mode: DreamingMode;
  shortTermCount: number;
  longTermCount: number;
  promotedCount: number;
  dreamingOf: string | null;
  nextCycle: string | null;
  timezone: string | null;
  modes: Array<{
    id: DreamingMode;
    label: string;
    detail: string;
  }>;
  statusLoading: boolean;
  statusError: string | null;
  modeSaving: boolean;
  onRefresh: () => void;
  onSelectMode: (mode: DreamingMode) => void;
};

const DREAM_PHRASES = [
  "consolidating memories…",
  "tidying the knowledge graph…",
  "replaying today's conversations…",
  "weaving short-term into long-term…",
  "defragmenting the mind palace…",
  "filing away loose thoughts…",
  "connecting distant dots…",
  "composting old context windows…",
  "alphabetizing the subconscious…",
  "promoting promising hunches…",
  "forgetting what doesn't matter…",
  "dreaming in embeddings…",
  "reorganizing the memory attic…",
  "softly indexing the day…",
  "nurturing fledgling insights…",
  "simmering half-formed ideas…",
  "whispering to the vector store…",
];

let _dreamIndex = Math.floor(Math.random() * DREAM_PHRASES.length);
let _dreamLastSwap = 0;
const DREAM_SWAP_MS = 6_000;

function currentDreamPhrase(): string {
  const now = Date.now();
  if (now - _dreamLastSwap > DREAM_SWAP_MS) {
    _dreamLastSwap = now;
    _dreamIndex = (_dreamIndex + 1) % DREAM_PHRASES.length;
  }
  return DREAM_PHRASES[_dreamIndex];
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
              style="top: calc(50% - 100px); left: calc(50% - 80px); width: 12px; height: 12px; animation-delay: 0.2s;"
            ></div>
            <div
              class="dreams__bubble-dot"
              style="top: calc(50% - 70px); left: calc(50% - 50px); width: 8px; height: 8px; animation-delay: 0.4s;"
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
          >${props.active ? "Dreaming Active" : "Dreaming Idle"} · ${props.mode.toUpperCase()}</span
        >
        <div class="dreams__status-detail">
          <div class="dreams__status-dot"></div>
          <span>
            ${props.promotedCount} promoted
            ${props.nextCycle ? html`· next run ${props.nextCycle}` : nothing}
            ${props.timezone ? html`· ${props.timezone}` : nothing}
          </span>
        </div>
      </div>

      <div class="dreams__stats">
        <div class="dreams__stat">
          <span class="dreams__stat-value" style="color: var(--text-strong);"
            >${props.shortTermCount}</span
          >
          <span class="dreams__stat-label">Short-term</span>
        </div>
        <div class="dreams__stat-divider"></div>
        <div class="dreams__stat">
          <span class="dreams__stat-value" style="color: var(--accent);"
            >${props.longTermCount}</span
          >
          <span class="dreams__stat-label">Long-term</span>
        </div>
        <div class="dreams__stat-divider"></div>
        <div class="dreams__stat">
          <span class="dreams__stat-value" style="color: var(--accent-2);"
            >${props.promotedCount}</span
          >
          <span class="dreams__stat-label">Promoted Today</span>
        </div>
      </div>

      <div class="dreams__controls">
        <div class="dreams__controls-head">
          <div>
            <div class="dreams__controls-title">Dreaming Modes</div>
            <div class="dreams__controls-subtitle">
              Pick a cadence and threshold profile for durable promotion.
            </div>
          </div>
          <div class="dreams__controls-actions">
            <button
              class="btn btn--subtle btn--sm"
              ?disabled=${props.modeSaving}
              @click=${props.onRefresh}
            >
              ${props.statusLoading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>
        <div class="dreams__phase-grid">
          ${props.modes.map(
            (mode) => html`
              <article
                class="dreams__phase ${props.mode === mode.id ? "dreams__phase--active" : ""}"
              >
                <div class="dreams__phase-top">
                  <div>
                    <div class="dreams__phase-label">${mode.label}</div>
                    <div class="dreams__phase-detail">${mode.detail}</div>
                  </div>
                  <button
                    class="btn btn--subtle btn--sm"
                    ?disabled=${props.modeSaving || props.mode === mode.id}
                    @click=${() => props.onSelectMode(mode.id)}
                  >
                    ${props.mode === mode.id ? "Active" : "Set"}
                  </button>
                </div>
                <div class="dreams__phase-meta">
                  <span>${props.mode === mode.id ? "selected" : "available"}</span>
                  <span>
                    ${mode.id === "off"
                      ? "no background runs"
                      : mode.id === "core"
                        ? "nightly cadence"
                        : mode.id === "deep"
                          ? "every 12 hours"
                          : "every 6 hours"}
                  </span>
                </div>
              </article>
            `,
          )}
        </div>
        ${props.statusError
          ? html`<div class="dreams__controls-error">${props.statusError}</div>`
          : nothing}
      </div>
    </section>
  `;
}
