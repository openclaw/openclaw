import { html, nothing } from "lit";
import type {
  PatternLabAssetType,
  PatternLabDashboardSnapshot,
  PatternLabFileInfo,
} from "../controllers/pattern-lab-dashboard.ts";

export type PatternLabDashboardProps = {
  loading: boolean;
  error: string | null;
  snapshot: PatternLabDashboardSnapshot | null;
  lastFetchAt: number | null;
  approvingAssetType: PatternLabAssetType | null;
  basePath: string;
  authToken: string | null;
  onRefresh: () => void;
  onApproveAssetType: (assetType: PatternLabAssetType) => void;
};

const ASSET_LABELS: Array<{ type: PatternLabAssetType; label: string }> = [
  { type: "image", label: "Images" },
  { type: "thumbnail", label: "Thumbnails" },
  { type: "voiceover", label: "Voiceover" },
  { type: "proof_footage", label: "Proof Footage" },
  { type: "video", label: "Long-Form" },
  { type: "short", label: "Shorts" },
];

function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith("/") ? withLeadingSlash.slice(0, -1) : withLeadingSlash;
}

function mediaSrc(file: PatternLabFileInfo, props: PatternLabDashboardProps): string {
  if (!file.exists) {
    return "";
  }
  const base = normalizeBasePath(props.basePath);
  const token = props.authToken ? `&token=${encodeURIComponent(props.authToken)}` : "";
  return `${base}${file.mediaUrl}${token}`;
}

function fmtDuration(seconds: number | null): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return "n/a";
  }
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  return minutes > 0 ? `${minutes}:${String(remaining).padStart(2, "0")}` : `${remaining}s`;
}

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "missing";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatStatus(status: PatternLabDashboardSnapshot["status"] | undefined): string {
  return status === "private-upload-ready" ? "Private Upload Ready" : "Owner Review Required";
}

function renderMetric(label: string, value: string, detail: string) {
  return html`
    <div class="pattern-lab-metric">
      <span>${label}</span>
      <b>${value}</b>
      <small>${detail}</small>
    </div>
  `;
}

function renderApprovalButton(
  props: PatternLabDashboardProps,
  assetType: PatternLabAssetType,
  label: string,
) {
  const summary = props.snapshot?.approvals[assetType];
  const complete = summary?.complete === true;
  const busy = props.approvingAssetType === assetType;
  return html`
    <button
      class=${complete ? "pattern-lab-approval pattern-lab-approval--done" : "pattern-lab-approval"}
      ?disabled=${complete || Boolean(props.approvingAssetType)}
      @click=${() => props.onApproveAssetType(assetType)}
    >
      <span>${label}</span>
      <b
        >${complete
          ? "approved"
          : busy
            ? "saving"
            : `${summary?.approved ?? 0}/${summary?.total ?? 0}`}</b
      >
    </button>
  `;
}

function renderVideoPreview(
  props: PatternLabDashboardProps,
  file: PatternLabFileInfo,
  label: string,
) {
  const src = mediaSrc(file, props);
  return html`
    <article class="pattern-lab-media">
      <div class="pattern-lab-media__head">
        <b>${label}</b>
        <span>${fmtDuration(file.durationSeconds)} / ${fmtBytes(file.sizeBytes)}</span>
      </div>
      ${file.exists
        ? html`<video controls preload="metadata" src=${src}></video>`
        : html`<div class="pattern-lab-empty">Missing media</div>`}
      <code>${file.repoPath}</code>
    </article>
  `;
}

function renderImagePreview(
  props: PatternLabDashboardProps,
  file: PatternLabFileInfo,
  label: string,
) {
  const src = mediaSrc(file, props);
  return html`
    <article class="pattern-lab-media">
      <div class="pattern-lab-media__head">
        <b>${label}</b>
        <span>${fmtBytes(file.sizeBytes)}</span>
      </div>
      ${file.exists
        ? html`<img src=${src} alt=${label} />`
        : html`<div class="pattern-lab-empty">Missing image</div>`}
      <code>${file.repoPath}</code>
    </article>
  `;
}

function renderSkeleton(props: PatternLabDashboardProps) {
  return html`
    <div class="pattern-lab-panel pattern-lab-panel--wide">
      <h2>Pattern Lab</h2>
      <p>${props.loading ? "Loading dashboard state..." : "No Pattern Lab package loaded yet."}</p>
      <button class="pattern-lab-button" @click=${props.onRefresh}>Refresh</button>
    </div>
  `;
}

export function renderPatternLabDashboard(props: PatternLabDashboardProps) {
  const snapshot = props.snapshot;
  const longFormDuration = fmtDuration(snapshot?.media.longForm.durationSeconds ?? null);
  const shortsReady = snapshot?.media.shorts.filter((item) => item.exists).length ?? 0;
  const completeApprovals =
    snapshot == null
      ? 0
      : ASSET_LABELS.filter((item) => snapshot.approvals[item.type]?.complete).length;
  const generated = snapshot?.generatedAt
    ? new Date(snapshot.generatedAt).toLocaleString()
    : "not loaded";
  const loaded = props.lastFetchAt
    ? new Date(props.lastFetchAt).toLocaleTimeString()
    : "not loaded";
  return html`
    <style>
      .pattern-lab-dashboard {
        display: grid;
        gap: 18px;
      }

      .pattern-lab-hero {
        position: relative;
        overflow: hidden;
        display: grid;
        grid-template-columns: minmax(0, 1fr) 320px;
        gap: 18px;
        border: 1px solid rgba(19, 216, 232, 0.38);
        border-radius: 10px;
        padding: 28px;
        color: #f5f7f8;
        background:
          linear-gradient(100deg, rgba(5, 15, 18, 0.98), rgba(4, 30, 34, 0.92)),
          linear-gradient(rgba(19, 216, 232, 0.06) 1px, transparent 1px),
          linear-gradient(90deg, rgba(19, 216, 232, 0.06) 1px, transparent 1px);
        background-size:
          auto,
          48px 48px,
          48px 48px;
        box-shadow: inset 0 0 48px rgba(19, 216, 232, 0.07);
      }

      .pattern-lab-eyebrow {
        color: #13d8e8;
        font:
          700 12px/1 ui-monospace,
          SFMono-Regular,
          Menlo,
          Consolas,
          monospace;
        letter-spacing: 0.11em;
        text-transform: uppercase;
      }

      .pattern-lab-title {
        margin: 12px 0 4px;
        font-size: clamp(38px, 5vw, 72px);
        line-height: 0.95;
        letter-spacing: 0;
      }

      .pattern-lab-tagline {
        margin: 0 0 14px;
        color: #d8e4e7;
        font-size: clamp(18px, 2vw, 26px);
        font-weight: 800;
      }

      .pattern-lab-copy {
        max-width: 780px;
        margin: 0;
        color: #a8bbc1;
        line-height: 1.55;
      }

      .pattern-lab-status-card {
        display: grid;
        gap: 10px;
        align-content: center;
        border: 1px solid rgba(19, 216, 232, 0.32);
        border-radius: 10px;
        padding: 18px;
        background: rgba(2, 9, 11, 0.72);
      }

      .pattern-lab-status-card b {
        display: block;
        color: #13d8e8;
        font-size: 24px;
        line-height: 1.1;
      }

      .pattern-lab-status-card span {
        color: #a8bbc1;
      }

      .pattern-lab-grid {
        display: grid;
        grid-template-columns: repeat(12, minmax(0, 1fr));
        gap: 16px;
      }

      .pattern-lab-panel {
        border: 1px solid rgba(19, 216, 232, 0.24);
        border-radius: 10px;
        padding: 18px;
        background: rgba(5, 18, 21, 0.82);
        box-shadow: inset 0 0 28px rgba(19, 216, 232, 0.04);
      }

      .pattern-lab-panel--wide {
        grid-column: span 12;
      }

      .pattern-lab-panel--two-thirds {
        grid-column: span 8;
      }

      .pattern-lab-panel--third {
        grid-column: span 4;
      }

      .pattern-lab-panel h2,
      .pattern-lab-panel h3 {
        margin: 0 0 12px;
        color: #f5f7f8;
        letter-spacing: 0;
      }

      .pattern-lab-panel p,
      .pattern-lab-panel li {
        color: #a8bbc1;
      }

      .pattern-lab-topline {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .pattern-lab-button {
        min-height: 38px;
        border: 1px solid rgba(19, 216, 232, 0.54);
        border-radius: 8px;
        padding: 0 14px;
        color: #f5f7f8;
        background: rgba(2, 9, 11, 0.72);
        font-weight: 800;
        cursor: pointer;
      }

      .pattern-lab-button:hover {
        border-color: #13d8e8;
      }

      .pattern-lab-metrics {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 10px;
        margin-top: 14px;
      }

      .pattern-lab-metric {
        border: 1px solid rgba(19, 216, 232, 0.22);
        border-radius: 8px;
        padding: 13px;
        background: rgba(2, 9, 11, 0.62);
      }

      .pattern-lab-metric span,
      .pattern-lab-metric small {
        display: block;
        color: #a8bbc1;
      }

      .pattern-lab-metric b {
        display: block;
        margin: 6px 0;
        color: #13d8e8;
        font-size: 28px;
        line-height: 1;
      }

      .pattern-lab-rail,
      .pattern-lab-approvals,
      .pattern-lab-performance {
        display: grid;
        gap: 10px;
      }

      .pattern-lab-rail {
        grid-template-columns: repeat(6, minmax(0, 1fr));
        margin-top: 14px;
      }

      .pattern-lab-step,
      .pattern-lab-performance-card {
        border: 1px solid rgba(19, 216, 232, 0.22);
        border-radius: 8px;
        padding: 12px;
        background: rgba(2, 9, 11, 0.62);
      }

      .pattern-lab-step {
        border-bottom: 3px solid #ff6b61;
      }

      .pattern-lab-step--done {
        border-bottom-color: #38d989;
      }

      .pattern-lab-step b,
      .pattern-lab-performance-card b {
        display: block;
        color: #f5f7f8;
      }

      .pattern-lab-step span,
      .pattern-lab-performance-card span,
      .pattern-lab-performance-card small {
        color: #a8bbc1;
      }

      .pattern-lab-approvals {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }

      .pattern-lab-approval {
        display: grid;
        gap: 4px;
        min-height: 78px;
        border: 1px solid rgba(19, 216, 232, 0.28);
        border-radius: 8px;
        padding: 12px;
        color: #f5f7f8;
        background: rgba(2, 9, 11, 0.7);
        text-align: left;
        cursor: pointer;
      }

      .pattern-lab-approval b {
        color: #f2c84b;
        text-transform: uppercase;
      }

      .pattern-lab-approval--done {
        border-color: rgba(56, 217, 137, 0.66);
      }

      .pattern-lab-approval--done b {
        color: #38d989;
      }

      .pattern-lab-approval:disabled {
        cursor: default;
        opacity: 0.8;
      }

      .pattern-lab-media-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
      }

      .pattern-lab-media {
        display: grid;
        gap: 8px;
      }

      .pattern-lab-media__head {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        color: #a8bbc1;
        font-size: 12px;
      }

      .pattern-lab-media__head b {
        color: #f5f7f8;
      }

      .pattern-lab-media video,
      .pattern-lab-media img,
      .pattern-lab-empty {
        width: 100%;
        min-height: 180px;
        border: 1px solid rgba(19, 216, 232, 0.24);
        border-radius: 8px;
        background: #020607;
      }

      .pattern-lab-media video {
        aspect-ratio: 16 / 9;
      }

      .pattern-lab-media img {
        aspect-ratio: 16 / 9;
        object-fit: cover;
      }

      .pattern-lab-empty {
        display: grid;
        place-items: center;
        color: #a8bbc1;
      }

      .pattern-lab-media code,
      .pattern-lab-path {
        color: #7fdde7;
        font-size: 12px;
        overflow-wrap: anywhere;
      }

      .pattern-lab-performance {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }

      .pattern-lab-performance-card b {
        color: #f2c84b;
        font-size: 22px;
      }

      .pattern-lab-blockers {
        margin: 0;
        padding-left: 18px;
      }

      .pattern-lab-error {
        border: 1px solid rgba(255, 107, 97, 0.5);
        border-radius: 8px;
        padding: 12px;
        color: #ffd5d1;
        background: rgba(255, 107, 97, 0.08);
      }

      @media (max-width: 1100px) {
        .pattern-lab-hero,
        .pattern-lab-metrics,
        .pattern-lab-rail,
        .pattern-lab-approvals,
        .pattern-lab-media-grid,
        .pattern-lab-performance {
          grid-template-columns: 1fr;
        }

        .pattern-lab-panel--two-thirds,
        .pattern-lab-panel--third {
          grid-column: span 12;
        }
      }
    </style>
    <section class="pattern-lab-dashboard">
      <div class="pattern-lab-hero">
        <div>
          <div class="pattern-lab-eyebrow">Native YouTube Dashboard</div>
          <h2 class="pattern-lab-title">Pattern Lab</h2>
          <p class="pattern-lab-tagline">Patterns. Criteria. Proof.</p>
          <p class="pattern-lab-copy">
            Review Video 01, approve original assets, inspect Shorts, and track the learning loop
            before any private upload or public publish decision.
          </p>
        </div>
        <aside class="pattern-lab-status-card">
          <span>Current state</span>
          <b>${formatStatus(snapshot?.status)}</b>
          <span>Generated: ${generated}</span>
          <span>Loaded: ${loaded}</span>
          <span>Public publish: blocked until explicit owner approval</span>
        </aside>
      </div>

      ${props.error ? html`<div class="pattern-lab-error">${props.error}</div>` : nothing}
      ${snapshot == null
        ? renderSkeleton(props)
        : html`
            <div class="pattern-lab-grid">
              <section class="pattern-lab-panel pattern-lab-panel--two-thirds">
                <div class="pattern-lab-topline">
                  <div>
                    <h2>Command Center</h2>
                    <p class="pattern-lab-path">${snapshot.outputRoot}</p>
                  </div>
                  <button class="pattern-lab-button" @click=${props.onRefresh}>
                    ${props.loading ? "Refreshing" : "Refresh"}
                  </button>
                </div>
                <div class="pattern-lab-metrics">
                  ${renderMetric("Long-form", longFormDuration, "draft duration")}
                  ${renderMetric("Shorts", `${shortsReady}/3`, "conversion assets")}
                  ${renderMetric("Blockers", String(snapshot.blockers.length), "before upload")}
                  ${renderMetric(
                    "Approvals",
                    `${completeApprovals}/${ASSET_LABELS.length}`,
                    "asset groups",
                  )}
                </div>
                <div class="pattern-lab-rail">
                  ${snapshot.readinessSteps.map(
                    (step) => html`
                      <div
                        class=${step.complete
                          ? "pattern-lab-step pattern-lab-step--done"
                          : "pattern-lab-step"}
                      >
                        <b>${step.label}</b>
                        <span>${step.detail}</span>
                      </div>
                    `,
                  )}
                </div>
              </section>

              <section class="pattern-lab-panel pattern-lab-panel--third">
                <h2>Approval Gates</h2>
                <div class="pattern-lab-approvals">
                  ${ASSET_LABELS.map((item) => renderApprovalButton(props, item.type, item.label))}
                </div>
              </section>

              <section class="pattern-lab-panel pattern-lab-panel--wide">
                <h2>Video Review</h2>
                ${renderVideoPreview(props, snapshot.media.longForm, "Long-form draft")}
              </section>

              <section class="pattern-lab-panel pattern-lab-panel--wide">
                <h2>Shorts Review</h2>
                <div class="pattern-lab-media-grid">
                  ${snapshot.media.shorts.map((short, index) =>
                    renderVideoPreview(props, short, `Short ${index + 1}`),
                  )}
                </div>
              </section>

              <section class="pattern-lab-panel pattern-lab-panel--wide">
                <h2>Thumbnail Candidates</h2>
                <div class="pattern-lab-media-grid">
                  ${snapshot.media.thumbnails.map((thumbnail, index) =>
                    renderImagePreview(props, thumbnail, `Thumbnail ${index + 1}`),
                  )}
                </div>
              </section>

              <section class="pattern-lab-panel pattern-lab-panel--two-thirds">
                <h2>Learning Metrics</h2>
                <div class="pattern-lab-performance">
                  ${snapshot.performance.cards.map(
                    (card) => html`
                      <div class="pattern-lab-performance-card">
                        <span>${card.label}</span>
                        <b>${card.value}</b>
                        <small>${card.why}</small>
                      </div>
                    `,
                  )}
                </div>
                <p>${snapshot.performance.commentsSignalSummary}</p>
                <p><b>Next decision:</b> ${snapshot.performance.nextAction}</p>
              </section>

              <section class="pattern-lab-panel pattern-lab-panel--third">
                <h2>Blockers</h2>
                ${snapshot.blockers.length > 0
                  ? html`
                      <ul class="pattern-lab-blockers">
                        ${snapshot.blockers.map((blocker) => html`<li>${blocker}</li>`)}
                      </ul>
                    `
                  : html`<p>No blockers remain for private or unlisted upload.</p>`}
              </section>

              <section class="pattern-lab-panel pattern-lab-panel--wide">
                <h2>Next Actions</h2>
                <ul>
                  ${snapshot.nextActions.map((action) => html`<li>${action}</li>`)}
                </ul>
              </section>
            </div>
          `}
    </section>
  `;
}
