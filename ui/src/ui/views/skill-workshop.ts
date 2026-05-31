import { html, nothing } from "lit";
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

export type SkillWorkshopProps = {
  loading: boolean;
  proposals: SkillWorkshopProposal[];
  selectedKey: string | null;
  statusFilter: SkillWorkshopStatusFilter;
  query: string;
  filePreviewKey: string | null;
  filePreviewQuery: string;
  counts: Record<SkillWorkshopStatusFilter, number>;
  onStatusFilterChange: (status: SkillWorkshopStatusFilter) => void;
  onQueryChange: (query: string) => void;
  onFilePreviewQueryChange: (query: string) => void;
  onSelect: (key: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onApply: (key: string) => void;
  onRevise: (key: string) => void;
  onSetAside: (key: string) => void;
  onReject: (key: string) => void;
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

  return html`
    <section class="skill-workshop">
      ${renderLifecycleTabs(props)}
      <div class="sw-triage">
        ${renderQueue(props, groups, selected)}
        ${selected ? renderDetail(props, selected) : renderEmpty()}
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
  `;
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
          <button title="Previous (k)" @click=${props.onPrev}>↑</button>
          <button title="Next (j)" @click=${props.onNext}>↓</button>
        </div>
      </div>

      <div class="sw-detail__body">
        <div class="sw-body-card">
          <h1>${proposal.slug}</h1>
          ${renderProposalBody(proposal.body)}
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

      ${proposal.status === "pending" ? renderPendingActions(props, proposal) : nothing}
    </div>
  `;
}

function renderPendingActions(props: SkillWorkshopProps, proposal: SkillWorkshopProposal) {
  return html`
    <div class="sw-action-bar">
      <button class="sw-btn sw-btn--primary" @click=${() => props.onApply(proposal.key)}>
        Apply
      </button>
      <button class="sw-btn" @click=${() => props.onRevise(proposal.key)}>Revise</button>
      <button class="sw-btn sw-btn--ghost" @click=${() => props.onSetAside(proposal.key)}>
        Set aside
      </button>
      <button
        class="sw-btn sw-btn--ghost sw-btn--danger"
        @click=${() => props.onReject(proposal.key)}
      >
        Reject
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

let cachedDemoProposals: SkillWorkshopProposal[] | null = null;
export function getDemoSkillWorkshopProposals(): SkillWorkshopProposal[] {
  if (!cachedDemoProposals) {
    cachedDemoProposals = buildDemoSkillWorkshopProposals();
  }
  return cachedDemoProposals;
}

// Demo data so the page actually renders the design before the gateway wires up.
// Drop this once `skills.proposals.list` is wired.
export function buildDemoSkillWorkshopProposals(): SkillWorkshopProposal[] {
  const now = Date.now();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  const morningBody = `## When to use
First thing in the morning when the user wants to start the day with a cleared inbox and a concrete plan. Trigger phrases: \`morning catch up\`, \`clear my inbox\`, \`what should I do today\`.

## Steps
1. **Triage.** Read unread messages across mail, Slack, and Discord. Skip threads where the user is just CC'd unless flagged.
2. **Archive.** Sort newsletters, receipts, and automated alerts into their normal folders.
3. **Surface.** List anything that needs the user's reply today, with a one-line "why" each.
4. **Draft.** For the top three replies, write a short draft in the user's voice. Do not send.
5. **Plan.** Propose a 3-item focus list for the day. Match against calendar gaps.

## Output
\`\`\`
## Needs reply
- Jen (vendor renewal) — wants pricing by Wed
- Marcus (interview confirm) — needs slot

## Today's three
1. Finish Q3 deck draft
2. Approve onboarding copy
3. 30-min focus block on the API doc
\`\`\``;

  return [
    {
      key: "morning-catchup",
      slug: "morning-catchup",
      name: "Morning catch-up",
      oneLine:
        "Summarise overnight emails, Slack DMs, and PR reviews into one digest you can read in two minutes.",
      body: morningBody,
      status: "pending",
      version: 1,
      createdAt: now - 2 * minute,
      recencyGroup: "today",
      ageLabel: "2m",
      isNew: true,
      supportFiles: [
        {
          path: "templates/digest.md",
          size: "2.1 KB",
          contents: `# Morning digest template

Used by morning-catchup when posting the daily summary back to the user. Sections render in this order. Skip any section that has no items.

## Needs reply
Bulleted list. One line each. Format: - {sender} ({why}) — {ask}

Example:
- Jen (vendor renewal) — wants pricing by Wed
- Marcus (interview confirm) — needs slot

## Today's three
A numbered list of three focus items, in priority order. Match against calendar gaps when possible.

1. {top priority — what + why now}
2. {second priority}
3. {third priority — short focus block ok}

## Archived
Optional. One line summary count: Archived 14 items (newsletters, receipts, automated alerts).

## Footer
Always end with the timestamp and how long the catch-up took:

_Catch-up complete · {duration}s · {timestamp}_
`,
        },
        {
          path: "filters/auto-senders.txt",
          size: "418 B",
          contents: `noreply@*
notifications@github.com
no-reply@*
calendar-notifications@*
reply+*@reply.github.com
account-update@*
billing@*
*receipts@*
mailer-daemon@*
postmaster@*
`,
        },
        {
          path: "prompts/group-by-importance.md",
          size: "1.4 KB",
          contents: `# Group by importance

Given a set of unread messages, return three buckets:

1. **Needs reply today** — direct asks, time-sensitive threads, anything the user is the
   sole owner of.
2. **FYI** — useful context, but not actionable today. Mention briefly without surfacing.
3. **Archive** — newsletters, automated alerts, marketing.

For each item in bucket 1, include:
- sender
- one-line "why now"
- suggested next action
`,
        },
      ],
    },
    {
      key: "birthday-reminders",
      slug: "birthday-reminders",
      name: "Birthday reminders",
      oneLine: "Surface contacts with birthdays in the next 7 days from Google Contacts.",
      body: `## When to use
Daily at the start of the day, surface upcoming birthdays so the user can send a quick note.

## Steps
1. Read Google Contacts birthdays for the next 7 days.
2. Group by day and skip duplicates.
3. For each contact, suggest a one-line greeting in the user's voice.
`,
      status: "pending",
      version: 1,
      createdAt: now - 14 * minute,
      recencyGroup: "today",
      ageLabel: "14m",
      isNew: true,
      supportFiles: [],
    },
    {
      key: "invoice-followup",
      slug: "invoice-followup",
      name: "Invoice follow-up",
      oneLine: "Draft a polite nudge for invoices unpaid > 14 days.",
      body: `## When to use
When AR shows invoices past their net-14 due date and no reply has been received.

## Steps
1. Pull invoices older than 14 days from Stripe / QuickBooks.
2. Cross-reference any payment received since the last sync.
3. Draft a polite reminder per overdue invoice. Do not send.
`,
      status: "pending",
      version: 2,
      createdAt: now - 80 * minute,
      updatedAt: now - 60 * minute,
      recencyGroup: "today",
      ageLabel: "1h",
      isNew: true,
      supportFiles: [],
    },
    {
      key: "trip-planning",
      slug: "trip-planning",
      name: "Trip planning",
      oneLine: "Take a city + dates, return flights, hotels, and a day-by-day plan.",
      body: `## When to use
When the user names a destination and travel window.

## Steps
1. Search flights for the given window.
2. Suggest two hotel tiers near the main activity area.
3. Draft a day-by-day plan with one anchor activity per day.
`,
      status: "pending",
      version: 1,
      createdAt: now - 2 * hour,
      recencyGroup: "today",
      ageLabel: "2h",
      isNew: true,
      supportFiles: [],
    },
    {
      key: "screenshot-cleanup",
      slug: "screenshot-cleanup",
      name: "Screenshot cleanup",
      oneLine: "Move screenshots older than 30 days from Desktop to ~/Archive.",
      body: `## When to use
Weekly or on demand when the Desktop is cluttered with screenshots.

## Steps
1. List screenshots on Desktop older than 30 days.
2. Move them into ~/Archive/screenshots/{yyyy-mm}/.
3. Report counts moved and any conflicts skipped.
`,
      status: "applied",
      version: 1,
      createdAt: now - 1 * day,
      recencyGroup: "yesterday",
      ageLabel: "1d",
      isNew: false,
      supportFiles: [],
    },
    {
      key: "standup-notes",
      slug: "standup-notes",
      name: "Standup notes",
      oneLine: "Generate daily standup from yesterday's git commits + calendar.",
      body: `## When to use
Every weekday morning before standup, the user wants a one-screen summary.

## Steps
1. Read yesterday's git commits across pinned repos.
2. Read yesterday's accepted calendar events.
3. Combine into three bullets: yesterday / today / blockers.
`,
      status: "pending",
      version: 1,
      createdAt: now - 1 * day,
      recencyGroup: "yesterday",
      ageLabel: "1d",
      isNew: false,
      supportFiles: [],
    },
    {
      key: "repo-cleanup",
      slug: "repo-cleanup",
      name: "Repo cleanup",
      oneLine: "Identify branches merged > 30 days ago, suggest deletion.",
      body: `## When to use
Monthly hygiene. The user wants a short list of stale branches to delete.

## Steps
1. List branches across pinned repos.
2. Filter to those merged > 30 days ago.
3. Suggest deletion grouped by repo. Do not delete.
`,
      status: "pending",
      version: 1,
      createdAt: now - 4 * day,
      recencyGroup: "earlier",
      ageLabel: "4d",
      isNew: false,
      supportFiles: [],
    },
  ];
}

export function countProposals(
  proposals: SkillWorkshopProposal[],
): Record<SkillWorkshopStatusFilter, number> {
  const counts: Record<SkillWorkshopStatusFilter, number> = {
    all: proposals.length,
    pending: 0,
    applied: 0,
    rejected: 0,
    quarantined: 0,
    stale: 0,
  };
  for (const p of proposals) {
    counts[p.status] += 1;
  }
  return counts;
}
