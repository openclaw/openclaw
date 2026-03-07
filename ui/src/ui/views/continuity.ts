import { html, nothing } from "lit";
import { formatRelativeTimestamp } from "../format.ts";
import type {
  ContinuityExplainResult,
  ContinuityKind,
  ContinuityRecord,
  ContinuityReviewState,
  ContinuitySourceClass,
  ContinuityStatus,
} from "../types.ts";

export type ContinuityProps = {
  loading: boolean;
  error: string | null;
  status: ContinuityStatus | null;
  records: ContinuityRecord[];
  agentId: string;
  stateFilter: ContinuityReviewState | "all";
  kindFilter: ContinuityKind | "all";
  sourceFilter: ContinuitySourceClass | "all";
  limit: string;
  busyId: string | null;
  explainById: Record<string, ContinuityExplainResult | null>;
  onFilterChange: (patch: {
    continuityAgentId?: string;
    continuityStateFilter?: ContinuityProps["stateFilter"];
    continuityKindFilter?: ContinuityProps["kindFilter"];
    continuitySourceFilter?: ContinuityProps["sourceFilter"];
    continuityLimit?: string;
  }) => void;
  onRefresh: () => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onRemove: (id: string) => void;
  onExplain: (id: string) => void;
};

function labelForKind(kind: ContinuityKind): string {
  switch (kind) {
    case "fact":
      return "Fact";
    case "preference":
      return "Preference";
    case "decision":
      return "Decision";
    case "open_loop":
      return "Open loop";
  }
}

function labelForSource(source: ContinuitySourceClass): string {
  switch (source) {
    case "main_direct":
      return "Main direct";
    case "paired_direct":
      return "Paired direct";
    case "group":
      return "Group";
    case "channel":
      return "Channel";
  }
}

function labelForState(state: ContinuityRecord["reviewState"]): string {
  switch (state) {
    case "pending":
      return "Pending";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
  }
}

function formatConfidence(value: number): string {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return `${pct}%`;
}

function groupLabel(state: ContinuityRecord["reviewState"]): string {
  switch (state) {
    case "pending":
      return "Pending queue";
    case "approved":
      return "Approved library";
    case "rejected":
      return "Rejected";
  }
}

export function renderContinuity(props: ContinuityProps) {
  const grouped = new Map<ContinuityRecord["reviewState"], ContinuityRecord[]>();
  for (const record of props.records) {
    const list = grouped.get(record.reviewState) ?? [];
    list.push(record);
    grouped.set(record.reviewState, list);
  }

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: flex-start; gap: 16px;">
        <div>
          <div class="card-title">Continuity</div>
          <div class="card-sub">Review and curate cross-channel continuity before it enters future prompts.</div>
        </div>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <div class="stats-grid" style="margin-top: 16px;">
        <div class="stat-card">
          <div class="stat-label">Plugin</div>
          <div class="stat-value">${props.status?.enabled ? "Loaded" : "Unavailable"}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Context engine slot</div>
          <div class="stat-value">${props.status?.slotSelected ? "continuity" : "legacy / other"}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Pending</div>
          <div class="stat-value">${props.status?.counts.pending ?? 0}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Approved</div>
          <div class="stat-value">${props.status?.counts.approved ?? 0}</div>
        </div>
      </div>

      <div class="filters" style="margin-top: 16px; align-items: end;">
        <label class="field">
          <span>Agent ID</span>
          <input
            .value=${props.agentId}
            placeholder="default"
            @input=${(e: Event) =>
              props.onFilterChange({ continuityAgentId: (e.target as HTMLInputElement).value })}
          />
        </label>
        <label class="field">
          <span>State</span>
          <select
            .value=${props.stateFilter}
            @change=${(e: Event) =>
              props.onFilterChange({
                continuityStateFilter: (e.target as HTMLSelectElement)
                  .value as ContinuityProps["stateFilter"],
              })}
          >
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
        </label>
        <label class="field">
          <span>Kind</span>
          <select
            .value=${props.kindFilter}
            @change=${(e: Event) =>
              props.onFilterChange({
                continuityKindFilter: (e.target as HTMLSelectElement)
                  .value as ContinuityProps["kindFilter"],
              })}
          >
            <option value="all">All</option>
            <option value="fact">Facts</option>
            <option value="preference">Preferences</option>
            <option value="decision">Decisions</option>
            <option value="open_loop">Open loops</option>
          </select>
        </label>
        <label class="field">
          <span>Source</span>
          <select
            .value=${props.sourceFilter}
            @change=${(e: Event) =>
              props.onFilterChange({
                continuitySourceFilter: (e.target as HTMLSelectElement)
                  .value as ContinuityProps["sourceFilter"],
              })}
          >
            <option value="all">All</option>
            <option value="main_direct">Main direct</option>
            <option value="paired_direct">Paired direct</option>
            <option value="group">Group</option>
            <option value="channel">Channel</option>
          </select>
        </label>
        <label class="field">
          <span>Limit</span>
          <input
            .value=${props.limit}
            @input=${(e: Event) =>
              props.onFilterChange({ continuityLimit: (e.target as HTMLInputElement).value })}
          />
        </label>
        <button class="btn primary" ?disabled=${props.loading} @click=${props.onRefresh}>Apply</button>
      </div>

      ${
        props.error
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
          : nothing
      }

      <div class="muted" style="margin-top: 12px;">
        Capture: main ${props.status?.capture.mainDirect ?? "n/a"} · paired ${props.status?.capture.pairedDirect ?? "n/a"} · group ${props.status?.capture.group ?? "n/a"} · channel ${props.status?.capture.channel ?? "n/a"}
      </div>
      <div class="muted" style="margin-top: 4px;">
        Recall: max ${props.status?.recall.maxItems ?? "n/a"} · open loops ${props.status?.recall.includeOpenLoops ? "on" : "off"}
      </div>

      ${
        props.records.length === 0
          ? html`
              <div class="muted" style="margin-top: 16px">No continuity items match the current filters.</div>
            `
          : html`
              <div class="list" style="margin-top: 16px; gap: 14px;">
                ${(["pending", "approved", "rejected"] as const)
                  .filter((state) => (grouped.get(state) ?? []).length > 0)
                  .map((state) => renderGroup(groupLabel(state), grouped.get(state) ?? [], props))}
              </div>
            `
      }
    </section>
  `;
}

function renderGroup(title: string, records: ContinuityRecord[], props: ContinuityProps) {
  return html`
    <div>
      <div class="row" style="justify-content: space-between; margin-bottom: 8px;">
        <div class="card-title" style="font-size: 14px;">${title}</div>
        <div class="muted">${records.length}</div>
      </div>
      <div class="list" style="gap: 10px;">
        ${records.map((record) => renderRecord(record, props))}
      </div>
    </div>
  `;
}

function renderRecord(record: ContinuityRecord, props: ContinuityProps) {
  const explain = props.explainById[record.id];
  const busy = props.busyId === record.id;
  return html`
    <div class="list-item" style="align-items: flex-start; gap: 16px;">
      <div class="list-main">
        <div class="row" style="justify-content: space-between; gap: 12px; flex-wrap: wrap;">
          <div class="list-title">${record.text}</div>
          <div class="row" style="gap: 8px; flex-wrap: wrap;">
            <span class="chip">${labelForKind(record.kind)}</span>
            <span class="chip">${labelForSource(record.sourceClass)}</span>
            <span class="chip">${labelForState(record.reviewState)}</span>
          </div>
        </div>
        <div class="list-sub" style="margin-top: 6px;">
          Confidence ${formatConfidence(record.confidence)} · Updated ${formatRelativeTimestamp(record.updatedAt)}
        </div>
        <div class="muted" style="margin-top: 8px;">
          Source: ${record.source.sessionKey ?? record.source.sessionId ?? "unknown"} · ${record.source.role}
        </div>
        <div class="muted" style="margin-top: 4px; white-space: pre-wrap;">
          Preview: ${record.source.excerpt}
        </div>
        ${
          explain
            ? html`
                <div class="muted" style="margin-top: 8px;">
                  ${explain.markdownPath ? `Markdown: ${explain.markdownPath}` : "Not materialized yet"}
                </div>
              `
            : nothing
        }
      </div>
      <div class="list-meta">
        <div class="row" style="justify-content: flex-end; flex-wrap: wrap; gap: 8px;">
          ${
            record.reviewState !== "approved"
              ? html`
                  <button class="btn primary" ?disabled=${busy} @click=${() => props.onApprove(record.id)}>
                    ${busy ? "Working…" : "Approve"}
                  </button>
                `
              : nothing
          }
          ${
            record.reviewState !== "rejected"
              ? html`
                  <button class="btn" ?disabled=${busy} @click=${() => props.onReject(record.id)}>
                    ${busy ? "Working…" : "Reject"}
                  </button>
                `
              : nothing
          }
          <button class="btn" ?disabled=${busy} @click=${() => props.onExplain(record.id)}>
            ${busy ? "Working…" : "Explain"}
          </button>
          <button class="btn" ?disabled=${busy} @click=${() => props.onRemove(record.id)}>
            ${busy ? "Working…" : "Remove"}
          </button>
        </div>
      </div>
    </div>
  `;
}
