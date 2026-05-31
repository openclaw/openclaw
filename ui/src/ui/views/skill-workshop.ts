import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { styleMap } from "lit/directives/style-map.js";
import "../components/file-preview-modal.ts";

export type SkillWorkshopProposalStatus =
  | "pending"
  | "applied"
  | "rejected"
  | "quarantined"
  | "stale";

export type SkillWorkshopFile = {
  path: string;
  size: string;
  contents: string;
};

export type SkillWorkshopProposal = {
  key: string;
  slug: string;
  name: string;
  oneLine: string;
  body: string;
  status: SkillWorkshopProposalStatus;
  version: number;
  createdAt: number;
  updatedAt?: number;
  recencyGroup: "today" | "yesterday" | "earlier";
  ageLabel: string;
  supportFiles: SkillWorkshopFile[];
  isNew: boolean;
};

export type SkillWorkshopStatusFilter = "all" | SkillWorkshopProposalStatus;
export type SkillWorkshopAction = "apply" | "revise" | "reject";
export type SkillWorkshopMode = "board" | "today";

export type SkillWorkshopActionBusy = {
  key: string;
  action: SkillWorkshopAction;
};

export type SkillWorkshopActionNotice = {
  key: string;
  label: string;
  slug: string;
};

export type SkillWorkshopProps = {
  loading: boolean;
  error: string | null;
  inspectingKey: string | null;
  proposals: SkillWorkshopProposal[];
  selectedKey: string | null;
  statusFilter: SkillWorkshopStatusFilter;
  query: string;
  filePreviewKey: string | null;
  filePreviewQuery: string;
  queueWidth: number;
  mode: SkillWorkshopMode;
  actionBusy: SkillWorkshopActionBusy | null;
  actionNotice: SkillWorkshopActionNotice | null;
  revisionKey: string | null;
  revisionDraft: string;
  counts: Record<SkillWorkshopStatusFilter, number>;
  onStatusFilterChange: (status: SkillWorkshopStatusFilter) => void;
  onQueryChange: (query: string) => void;
  onFilePreviewQueryChange: (query: string) => void;
  onQueueWidthChange: (width: number) => void;
  onQueueWidthCommit: (width: number) => void;
  onModeChange: (mode: SkillWorkshopMode) => void;
  onSelect: (key: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onApply: (key: string) => void;
  onRevise: (key: string) => void;
  onReject: (key: string) => void;
  onRevisionDraftChange: (draft: string) => void;
  onRevisionCancel: () => void;
  onRevisionSubmit: (key: string) => void;
  onPreviewFile: (key: string, path: string) => void;
  onClosePreview: () => void;
};

const STATUS_TABS: SkillWorkshopStatusFilter[] = [
  "all",
  "pending",
  "applied",
  "rejected",
  "quarantined",
  "stale",
];

const STATUS_LABEL: Record<SkillWorkshopStatusFilter, string> = {
  all: "All",
  pending: "Pending",
  applied: "Applied",
  rejected: "Rejected",
  quarantined: "Quarantined",
  stale: "Stale",
};

const GROUP_LABEL: Record<SkillWorkshopProposal["recencyGroup"], string> = {
  today: "Today",
  yesterday: "Yesterday",
  earlier: "Earlier this week",
};

export function renderSkillWorkshop(props: SkillWorkshopProps) {
  const filtered = filterProposals(props.proposals, props.statusFilter, props.query);
  const selected = filtered.find((p) => p.key === props.selectedKey) ?? filtered[0];
  const groups = groupByRecency(filtered);
  const preview =
    selected && props.filePreviewKey
      ? selected.supportFiles.find((f) => f.path === props.filePreviewKey)
      : null;
  const revisionProposal = props.revisionKey
    ? props.proposals.find((p) => p.key === props.revisionKey)
    : null;
  const allPending = props.proposals.filter((p) => p.status === "pending");
  const todayHero = selected ?? allPending[0] ?? props.proposals[0];

  const body =
    props.mode === "today"
      ? renderToday(props, todayHero, allPending)
      : renderBoard(props, filtered, groups, selected);

  return html`
    <section class="skill-workshop sw-mode-${props.mode}">
      ${props.error ? html`<div class="sw-error" role="status">${props.error}</div>` : nothing}
      <div class="sw-view" data-mode=${props.mode}>
        ${keyed(props.mode, html`<div class="sw-view__pane">${body}</div>`)}
      </div>
    </section>
    ${preview && selected
      ? html`
          <openclaw-file-preview-modal
            .files=${selected.supportFiles}
            .activePath=${preview.path}
            .query=${props.filePreviewQuery}
            .contextLabel=${`in ${selected.slug}`}
            @file-preview-query-change=${(event: CustomEvent<string>) =>
              props.onFilePreviewQueryChange(event.detail)}
            @file-preview-select=${(event: CustomEvent<string>) =>
              props.onPreviewFile(selected.key, event.detail)}
            @file-preview-close=${props.onClosePreview}
          ></openclaw-file-preview-modal>
        `
      : nothing}
    ${revisionProposal ? renderRevisionDialog(props, revisionProposal) : nothing}
  `;
}

function renderRevisionDialog(props: SkillWorkshopProps, proposal: SkillWorkshopProposal) {
  const busy = props.actionBusy?.key === proposal.key && props.actionBusy.action === "revise";
  const canSubmit = props.revisionDraft.trim().length > 0 && !props.actionBusy;
  const verb = props.mode === "board" ? "Revise" : "Tweak";

  return html`
    <div class="sw-revision-backdrop" role="presentation" @click=${props.onRevisionCancel}>
      <section
        class="sw-revision-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sw-revision-title"
        @click=${(event: MouseEvent) => event.stopPropagation()}
      >
        <div class="sw-revision-dialog__head">
          <div>
            <div class="sw-revision-dialog__eyebrow">${verb} proposal</div>
            <h2 id="sw-revision-title">${proposal.slug}</h2>
          </div>
          <button
            class="sw-revision-dialog__close"
            title="Close"
            aria-label="Close"
            ?disabled=${Boolean(props.actionBusy)}
            @click=${props.onRevisionCancel}
          >
            ×
          </button>
        </div>
        <p class="sw-revision-dialog__copy">
          Tell the agent what should change. The proposal stays pending and the workshop will create
          a revised version.
        </p>
        <textarea
          class="sw-revision-dialog__input"
          autofocus
          placeholder="Example: Make this use Gmail labels instead of unread search, and add a safer dry-run step."
          .value=${props.revisionDraft}
          ?disabled=${Boolean(props.actionBusy)}
          @input=${(event: Event) =>
            props.onRevisionDraftChange((event.target as HTMLTextAreaElement).value ?? "")}
        ></textarea>
        <div class="sw-revision-dialog__actions">
          <button
            class="sw-btn sw-btn--ghost"
            ?disabled=${Boolean(props.actionBusy)}
            @click=${props.onRevisionCancel}
          >
            Cancel
          </button>
          <button
            class="sw-btn sw-btn--primary ${busy ? "is-busy" : ""}"
            ?disabled=${!canSubmit}
            @click=${() => props.onRevisionSubmit(proposal.key)}
          >
            ${busy ? "Sending…" : "Send revision"}
          </button>
        </div>
      </section>
    </div>
  `;
}

function renderBoard(
  props: SkillWorkshopProps,
  filtered: SkillWorkshopProposal[],
  groups: Array<{ label: string; items: SkillWorkshopProposal[] }>,
  selected: SkillWorkshopProposal | undefined,
) {
  void filtered;
  return html`
    ${renderLifecycleTabs(props)}
    <div class="sw-triage" style=${styleMap({ "--sw-queue-width": `${props.queueWidth}px` })}>
      ${renderQueue(props, groups, selected)} ${renderQueueResizer(props)}
      ${selected ? renderDetail(props, selected) : renderEmpty()}
    </div>
  `;
}

function renderQueueResizer(props: SkillWorkshopProps) {
  return html`
    <div
      class="sw-queue-resizer"
      role="separator"
      aria-label="Resize proposal list"
      aria-orientation="vertical"
      tabindex="0"
      @pointerdown=${(event: PointerEvent) => startQueueResize(event, props)}
      @keydown=${(event: KeyboardEvent) => resizeQueueWithKeyboard(event, props)}
    ></div>
  `;
}

function startQueueResize(event: PointerEvent, props: SkillWorkshopProps): void {
  event.preventDefault();
  event.stopPropagation();

  const startX = event.clientX;
  const startWidth = props.queueWidth;
  let currentWidth = startWidth;
  const body = document.body;
  const previousCursor = body.style.cursor;
  const previousUserSelect = body.style.userSelect;
  body.style.cursor = "col-resize";
  body.style.userSelect = "none";

  const cleanup = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    body.style.cursor = previousCursor;
    body.style.userSelect = previousUserSelect;
  };

  const onMove = (moveEvent: PointerEvent) => {
    currentWidth = startWidth + moveEvent.clientX - startX;
    props.onQueueWidthChange(currentWidth);
  };

  const onUp = () => {
    cleanup();
    props.onQueueWidthCommit(currentWidth);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

function resizeQueueWithKeyboard(event: KeyboardEvent, props: SkillWorkshopProps): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
    return;
  }
  event.preventDefault();
  const delta = event.key === "ArrowLeft" ? -24 : 24;
  props.onQueueWidthCommit(props.queueWidth + delta);
}

function renderLifecycleTabs(props: SkillWorkshopProps) {
  return html`
    <div class="sw-lifecycle-tabs">
      ${STATUS_TABS.map((status) => {
        const isActive = props.statusFilter === status;
        const count = props.counts[status] ?? 0;
        return html`
          <button
            class="sw-lifecycle-tab ${isActive ? "is-active" : ""}"
            @click=${() => props.onStatusFilterChange(status)}
          >
            ${STATUS_LABEL[status]} <span class="sw-lifecycle-tab__count">${count}</span>
          </button>
        `;
      })}
    </div>
  `;
}

function renderQueue(
  props: SkillWorkshopProps,
  groups: Array<{ label: string; items: SkillWorkshopProposal[] }>,
  selected: SkillWorkshopProposal | undefined,
) {
  const total = groups.reduce((sum, g) => sum + g.items.length, 0);

  return html`
    <aside class="sw-queue">
      <div class="sw-queue__search">
        <input
          placeholder="Search proposals… (/)"
          .value=${props.query}
          @input=${(event: Event) =>
            props.onQueryChange((event.target as HTMLInputElement).value ?? "")}
        />
      </div>
      <div class="sw-queue__body">
        ${total === 0
          ? html`<div class="sw-queue__empty">${queueEmptyText(props)}</div>`
          : groups.map(
              (group) => html`
                <div class="sw-queue__group">
                  ${group.label} <span class="sw-queue__group-pill">${group.items.length}</span>
                </div>
                ${group.items.map((proposal) => renderRow(props, proposal, selected))}
              `,
            )}
      </div>
    </aside>
  `;
}

function renderRow(
  props: SkillWorkshopProps,
  proposal: SkillWorkshopProposal,
  selected: SkillWorkshopProposal | undefined,
) {
  const isSelected = selected?.key === proposal.key;
  const noveltyClass = proposal.isNew ? "is-new" : "is-seen";
  return html`
    <button
      class="sw-row ${noveltyClass} ${isSelected ? "is-selected" : ""}"
      @click=${() => props.onSelect(proposal.key)}
    >
      <span class="sw-row__dot"></span>
      <span>
        <span class="sw-row__title">${proposal.name}</span>
        <span class="sw-row__desc">${proposal.oneLine}</span>
      </span>
      <span class="sw-row__meta">${proposal.ageLabel}</span>
    </button>
  `;
}

function renderDetail(props: SkillWorkshopProps, proposal: SkillWorkshopProposal) {
  const createdLabel = proposal.updatedAt
    ? `Edited ${formatRelative(proposal.updatedAt)}`
    : `Created ${formatRelative(proposal.createdAt)}`;
  const detailLoading = props.inspectingKey === proposal.key && !proposal.body;

  return html`
    <div class="sw-detail">
      <div class="sw-detail__head">
        <div class="sw-detail__head-left">
          <h1 class="sw-detail__title">${proposal.name}</h1>
          <div class="sw-detail__one-line">${proposal.oneLine}</div>
          <div class="sw-detail__meta">
            <span>${createdLabel}</span>
            <span>·</span>
            <span>v${proposal.version}</span>
            <span>·</span>
            ${proposal.supportFiles.length > 0
              ? html`<button
                  class="sw-detail__meta-link"
                  @click=${() => props.onPreviewFile(proposal.key, proposal.supportFiles[0].path)}
                >
                  ${proposal.supportFiles.length} support files
                </button>`
              : html`<span>0 support files</span>`}
          </div>
        </div>
        <div class="sw-detail__nav">
          <button title="Previous" @click=${props.onPrev}>↑</button>
          <button title="Next" @click=${props.onNext}>↓</button>
        </div>
      </div>

      <div class="sw-detail__body">
        <div class="sw-body-card">
          <h1>${proposal.slug}</h1>
          ${detailLoading
            ? html`<p class="sw-muted">Loading proposal…</p>`
            : renderProposalBody(proposal.body)}
        </div>

        ${proposal.supportFiles.length > 0
          ? html`
              <div class="sw-section" style="margin-top: 18px;">
                <h3 class="sw-section__label">Support files</h3>
                <div class="sw-files">
                  ${proposal.supportFiles.map(
                    (file) => html`
                      <button
                        class="sw-file"
                        @click=${() => props.onPreviewFile(proposal.key, file.path)}
                      >
                        <span>📄</span>
                        <span class="sw-file__name">${file.path}</span>
                        <span class="sw-file__size"
                          >${file.size} <span class="sw-file__hint">· click to preview</span></span
                        >
                      </button>
                    `,
                  )}
                </div>
              </div>
            `
          : nothing}
      </div>

      ${props.actionNotice?.key === proposal.key ? renderActionNotice(props.actionNotice) : nothing}
      ${proposal.status === "pending" ? renderPendingActions(props, proposal) : nothing}
    </div>
  `;
}

function renderActionNotice(notice: SkillWorkshopActionNotice) {
  return html`
    <div class="sw-action-toast" role="status" aria-live="polite">
      <span>${notice.label}</span>
      <strong>${notice.slug}</strong>
      <span>·</span>
    </div>
  `;
}

function renderPendingActions(props: SkillWorkshopProps, proposal: SkillWorkshopProposal) {
  const busy = props.actionBusy?.key === proposal.key ? props.actionBusy.action : null;
  const disabled = Boolean(props.actionBusy);
  return html`
    <div class="sw-action-bar" aria-busy=${busy ? "true" : "false"}>
      <button
        class="sw-btn sw-btn--primary ${busy === "apply" ? "is-busy" : ""}"
        ?disabled=${disabled}
        @click=${() => props.onApply(proposal.key)}
      >
        ${busy === "apply" ? "Applying…" : "Apply"}
      </button>
      <button
        class="sw-btn ${busy === "revise" ? "is-busy" : ""}"
        ?disabled=${disabled}
        @click=${() => props.onRevise(proposal.key)}
      >
        ${busy === "revise" ? "Opening…" : "Revise"}
      </button>
      <button
        class="sw-btn sw-btn--ghost sw-btn--danger ${busy === "reject" ? "is-busy" : ""}"
        ?disabled=${disabled}
        @click=${() => props.onReject(proposal.key)}
      >
        ${busy === "reject" ? "Rejecting…" : "Reject"}
      </button>
    </div>
  `;
}

function renderEmpty() {
  return html`
    <div class="sw-detail sw-detail--empty">
      <p class="sw-empty__title">No proposals match</p>
      <p class="sw-empty__sub">
        Try a different lifecycle tab or clear the search to see everything.
      </p>
    </div>
  `;
}

function renderToday(
  props: SkillWorkshopProps,
  hero: SkillWorkshopProposal | undefined,
  pending: SkillWorkshopProposal[],
) {
  if (!hero) {
    return html`
      <div class="sw-today sw-today--empty">
        <p class="sw-empty__title">Nothing waiting today</p>
        <p class="sw-empty__sub">
          Your agent hasn't drafted anything new. Switch to Board to browse history.
        </p>
      </div>
    `;
  }

  const heroIndex = Math.max(
    0,
    pending.findIndex((p) => p.key === hero.key),
  );
  const total = Math.max(pending.length, 1);
  const upNext = pending.filter((p) => p.key !== hero.key).slice(0, 3);
  const applied = props.proposals.filter((p) => p.status === "applied").slice(0, 3);
  const heroLabel = hero.isNew ? "NEW" : hero.status === "pending" ? "WAITING" : "REVIEWED";
  const ageLabel = hero.ageLabel;
  const dateLine = formatTodayDate(Date.now());
  const isPending = hero.status === "pending";
  const busy = props.actionBusy?.key === hero.key ? props.actionBusy.action : null;
  const disabled = Boolean(props.actionBusy);

  return html`
    <div class="sw-today">
      <div class="sw-today__head">
        <div class="sw-today__date">${dateLine}</div>
        <h1 class="sw-today__h1">${pending.length} proposals waiting</h1>
        ${pending.length === 0
          ? html`<div class="sw-today__sub">Browse what's already applied.</div>`
          : nothing}
        ${pending.length > 0
          ? html`
              <div class="sw-today__progress">
                <span>${heroIndex + 1} of ${total}</span>
                <div class="sw-today__dots">
                  ${pending.map(
                    (_, i) => html`
                      <span
                        class="sw-today__dot ${i < heroIndex
                          ? "is-done"
                          : i === heroIndex
                            ? "is-now"
                            : ""}"
                      ></span>
                    `,
                  )}
                </div>
              </div>
            `
          : nothing}
      </div>

      <article class="sw-today__hero">
        <div class="sw-today__label">
          <span class="sw-today__ping"></span>
          ${heroLabel} · ${ageLabel}
        </div>
        <h2 class="sw-today__name">${hero.slug}</h2>
        <p class="sw-today__one-liner">${hero.oneLine}</p>

        ${renderTodayDoesBlock(hero)}

        <div class="sw-today__author">
          <span class="sw-today__avatar">v${hero.version}</span>
          <span>
            Drafted by your <strong>agent</strong> · ${ageLabel}.
            ${hero.supportFiles.length > 0
              ? html`
                  <button
                    class="sw-today__files-link"
                    @click=${() => props.onPreviewFile(hero.key, hero.supportFiles[0].path)}
                  >
                    ${hero.supportFiles.length}
                    ${hero.supportFiles.length === 1 ? "support file" : "support files"}
                  </button>
                  come with it.
                `
              : nothing}
          </span>
        </div>

        ${isPending
          ? html`
              <div class="sw-today__actions" aria-busy=${busy ? "true" : "false"}>
                <button
                  class="sw-today__big sw-today__big--primary ${busy === "apply" ? "is-busy" : ""}"
                  ?disabled=${disabled}
                  @click=${() => props.onApply(hero.key)}
                >
                  ${busy === "apply" ? "Applying…" : "Use it"}
                  <span class="sw-today__big-sub">Add to your skills</span>
                </button>
                <button
                  class="sw-today__big sw-today__big--tweak ${busy === "revise" ? "is-busy" : ""}"
                  ?disabled=${disabled}
                  @click=${() => props.onRevise(hero.key)}
                >
                  ${busy === "revise" ? "Opening…" : "Tweak it"}
                  <span class="sw-today__big-sub">Ask the agent to change something</span>
                </button>
                <button
                  class="sw-today__big sw-today__big--skip ${busy === "reject" ? "is-busy" : ""}"
                  ?disabled=${disabled}
                  @click=${() => props.onReject(hero.key)}
                >
                  ${busy === "reject" ? "Skipping…" : "Skip"}
                  <span class="sw-today__big-sub">Not for me</span>
                </button>
              </div>
            `
          : nothing}
        ${props.actionNotice?.key === hero.key ? renderActionNotice(props.actionNotice) : nothing}
      </article>

      ${upNext.length > 0
        ? html`
            <section class="sw-today__section">
              <header class="sw-today__section-head">
                <h3>Up next · ${pending.length - 1} more waiting</h3>
                <button class="sw-today__link" @click=${() => props.onModeChange("board")}>
                  See all proposals →
                </button>
              </header>
              <div class="sw-today__upnext">
                ${upNext.map(
                  (p) => html`
                    <button class="sw-today__mini" @click=${() => props.onSelect(p.key)}>
                      <div class="sw-today__mini-name">${p.slug}</div>
                      <div class="sw-today__mini-desc">${p.oneLine}</div>
                      <div class="sw-today__mini-meta">${p.ageLabel}</div>
                    </button>
                  `,
                )}
              </div>
            </section>
          `
        : nothing}
      ${applied.length > 0
        ? html`
            <section class="sw-today__section">
              <header class="sw-today__section-head">
                <h3>Your collection · ${props.counts.applied} in use</h3>
                <button
                  class="sw-today__link sw-today__link--muted"
                  @click=${() => props.onModeChange("board")}
                >
                  Manage →
                </button>
              </header>
              <div class="sw-today__applied">
                ${applied.map(
                  (p) => html`
                    <button
                      class="sw-today__applied-row"
                      @click=${() => {
                        props.onSelect(p.key);
                        props.onModeChange("board");
                      }}
                    >
                      <span class="sw-today__check">✓</span>
                      <span class="sw-today__applied-name">
                        <strong>${p.slug}</strong> — ${p.oneLine}
                      </span>
                      <span class="sw-today__applied-when">${p.ageLabel}</span>
                    </button>
                  `,
                )}
              </div>
            </section>
          `
        : nothing}
    </div>
  `;
}

function renderTodayDoesBlock(hero: SkillWorkshopProposal) {
  const bullets = extractDoesBullets(hero.body);
  if (bullets.length === 0) {
    return nothing;
  }
  return html`
    <div class="sw-today__does">
      <div class="sw-today__does-h">What it'll do when you trigger it</div>
      <ul>
        ${bullets.slice(0, 5).map((b) => html`<li>${renderInline(b)}</li>`)}
      </ul>
    </div>
  `;
}

function extractDoesBullets(body: string): string[] {
  const lines = body.split("\n");
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const m = /^(?:[-*]|\d+\.)\s+(.+)/.exec(line);
    if (m) {
      out.push(m[1].replace(/^\*\*[^*]+\*\*\s*/, ""));
    }
  }
  return out;
}

function formatTodayDate(ms: number): string {
  const d = new Date(ms);
  const day = d.toLocaleDateString(undefined, { weekday: "long" });
  const month = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day} · ${month}`;
}

function renderProposalBody(body: string) {
  const lines = body.split("\n");
  const out: unknown[] = [];
  let para: string[] = [];
  let list: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push(html`<p>${renderInline(para.join(" "))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      const items = list;
      out.push(html`
        <ol>
          ${items.map((line) => html`<li>${renderInline(line)}</li>`)}
        </ol>
      `);
      list = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith("```")) {
      flushPara();
      flushList();
      if (inCode) {
        out.push(html`<pre>${codeBuf.join("\n")}</pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(raw);
      continue;
    }
    if (line === "") {
      flushPara();
      flushList();
      continue;
    }
    if (line.startsWith("## ")) {
      flushPara();
      flushList();
      out.push(html`<h3>${line.slice(3)}</h3>`);
      continue;
    }
    if (line.startsWith("# ")) {
      flushPara();
      flushList();
      out.push(html`<h3>${line.slice(2)}</h3>`);
      continue;
    }
    const olMatch = /^\d+\.\s+(.+)/.exec(line);
    if (olMatch) {
      flushPara();
      list.push(olMatch[1]);
      continue;
    }
    para.push(line);
  }
  flushPara();
  flushList();
  if (inCode && codeBuf.length) {
    out.push(html`<pre>${codeBuf.join("\n")}</pre>`);
  }
  return out;
}

// Inline render: handles `code` and **bold** in text segments.
function renderInline(text: string): unknown {
  const parts: unknown[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (match.index > last) {
      parts.push(text.slice(last, match.index));
    }
    const token = match[0];
    if (token.startsWith("`")) {
      parts.push(html`<code>${token.slice(1, -1)}</code>`);
    } else {
      parts.push(html`<strong>${token.slice(2, -2)}</strong>`);
    }
    last = match.index + token.length;
  }
  if (last < text.length) {
    parts.push(text.slice(last));
  }
  return parts;
}

function filterProposals(
  proposals: SkillWorkshopProposal[],
  statusFilter: SkillWorkshopStatusFilter,
  query: string,
): SkillWorkshopProposal[] {
  const q = query.trim().toLowerCase();
  return proposals.filter((p) => {
    if (statusFilter !== "all" && p.status !== statusFilter) {
      return false;
    }
    if (q) {
      const hay = `${p.name} ${p.oneLine} ${p.slug}`.toLowerCase();
      if (!hay.includes(q)) {
        return false;
      }
    }
    return true;
  });
}

function groupByRecency(
  proposals: SkillWorkshopProposal[],
): Array<{ label: string; items: SkillWorkshopProposal[] }> {
  const buckets = new Map<SkillWorkshopProposal["recencyGroup"], SkillWorkshopProposal[]>();
  for (const proposal of proposals) {
    const list = buckets.get(proposal.recencyGroup) ?? [];
    list.push(proposal);
    buckets.set(proposal.recencyGroup, list);
  }
  const order: Array<SkillWorkshopProposal["recencyGroup"]> = ["today", "yesterday", "earlier"];
  return order
    .filter((key) => buckets.has(key))
    .map((key) => ({ label: GROUP_LABEL[key], items: buckets.get(key) ?? [] }));
}

function queueEmptyText(props: SkillWorkshopProps): string {
  if (props.error) {
    return "Could not load proposals.";
  }
  if (props.loading) {
    return "Loading proposals…";
  }
  if (props.statusFilter !== "all") {
    return `No ${STATUS_LABEL[props.statusFilter].toLowerCase()} proposals.`;
  }
  return "No proposals match the current filter.";
}

function formatRelative(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) {
    return `${sec}s ago`;
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `${min} minutes ago`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    return `${hr}h ago`;
  }
  const day = Math.floor(hr / 24);
  if (day < 7) {
    return `${day}d ago`;
  }
  return new Date(ms).toLocaleDateString();
}
