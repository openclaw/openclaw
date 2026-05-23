import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { MemoryAuditSuggestion, MemoryAuditSuggestions } from "../controllers/memory-audit.ts";
import { icons } from "../icons.ts";

export type MemoryAuditProps = {
  loading: boolean;
  error: string | null;
  actionId: string | null;
  actionMessage: { kind: "success" | "error"; text: string } | null;
  suggestions: MemoryAuditSuggestions | null;
  onRefresh: () => void;
  onApply: (suggestion: MemoryAuditSuggestion) => void;
  onReject: (suggestion: MemoryAuditSuggestion) => void;
};

function formatPercent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function formatAction(action: MemoryAuditSuggestion["action"]): string {
  return t(`memoryAudit.action.${action}`);
}

function formatStatus(status: MemoryAuditSuggestion["status"]): string {
  return t(`memoryAudit.status.${status}`);
}

function formatKind(kind: MemoryAuditSuggestion["target"]["kind"]): string {
  return t(`memoryAudit.kind.${kind}`);
}

function sourceLabel(suggestion: MemoryAuditSuggestion): string | null {
  const source = suggestion.source;
  if (!source) {
    return null;
  }
  return `${source.path}:${source.startLine}-${source.endLine}`;
}

function renderMetric(label: string, value: number, tone: string) {
  return html`
    <div class="memory-audit__metric memory-audit__metric--${tone}">
      <span class="memory-audit__metric-value">${value}</span>
      <span class="memory-audit__metric-label">${label}</span>
    </div>
  `;
}

function renderSummary(summary: MemoryAuditSuggestions | null) {
  const total = summary?.total ?? 0;
  return html`
    <div class="memory-audit__summary" aria-label=${t("memoryAudit.summary.label")}>
      ${renderMetric(t("memoryAudit.summary.total"), total, "total")}
      ${renderMetric(t("memoryAudit.summary.pending"), summary?.pending ?? 0, "pending")}
      ${renderMetric(t("memoryAudit.summary.applied"), summary?.applied ?? 0, "applied")}
      ${renderMetric(t("memoryAudit.summary.rejected"), summary?.rejected ?? 0, "rejected")}
      ${renderMetric(t("memoryAudit.summary.conflict"), summary?.conflict ?? 0, "conflict")}
    </div>
  `;
}

function renderSuggestion(props: MemoryAuditProps, suggestion: MemoryAuditSuggestion) {
  const pending = suggestion.status === "pending";
  const busy = props.actionId === suggestion.id;
  const disabled = props.loading || !pending || props.actionId !== null;
  const source = sourceLabel(suggestion);
  return html`
    <article class="memory-audit-item" data-suggestion-id=${suggestion.id}>
      <header class="memory-audit-item__header">
        <div class="memory-audit-item__title">
          <span class="memory-audit-item__action">${formatAction(suggestion.action)}</span>
          <span class="memory-audit-item__path">${suggestion.target.path}</span>
        </div>
        <div class="memory-audit-item__badges">
          <span class="memory-audit-badge memory-audit-badge--${suggestion.status}">
            ${formatStatus(suggestion.status)}
          </span>
          <span class="memory-audit-badge">${formatPercent(suggestion.confidence)}</span>
        </div>
      </header>

      <div class="memory-audit-item__meta">
        <span>${formatKind(suggestion.target.kind)}</span>
        ${suggestion.target.agentId ? html`<span>${suggestion.target.agentId}</span>` : nothing}
        ${source ? html`<span>${source}</span>` : nothing}
      </div>

      <p class="memory-audit-item__rationale">${suggestion.rationale}</p>
      <pre class="memory-audit-item__text">${suggestion.text}</pre>
      ${suggestion.conflict
        ? html`<div class="memory-audit-item__conflict" role="alert">${suggestion.conflict}</div>`
        : nothing}

      <footer class="memory-audit-item__actions">
        <button
          class="btn btn--sm btn--primary"
          ?disabled=${disabled}
          @click=${() => props.onApply(suggestion)}
        >
          ${icons.check}<span
            >${busy ? t("memoryAudit.actions.working") : t("memoryAudit.actions.apply")}</span
          >
        </button>
        <button
          class="btn btn--sm btn--subtle"
          ?disabled=${disabled}
          @click=${() => props.onReject(suggestion)}
        >
          ${icons.x}<span>${t("memoryAudit.actions.reject")}</span>
        </button>
      </footer>
    </article>
  `;
}

export function renderMemoryAudit(props: MemoryAuditProps) {
  const suggestions = props.suggestions?.suggestions ?? [];
  return html`
    <section class="memory-audit-page">
      <div class="memory-audit-toolbar">
        <div class="memory-audit-toolbar__copy">
          <div class="memory-audit-toolbar__title">${t("memoryAudit.review.title")}</div>
          <div class="memory-audit-toolbar__subtitle">${t("memoryAudit.review.subtitle")}</div>
        </div>
        <button
          class="btn btn--sm btn--subtle"
          ?disabled=${props.loading}
          @click=${props.onRefresh}
        >
          ${icons.refresh}<span
            >${props.loading ? t("common.refreshing") : t("common.refresh")}</span
          >
        </button>
      </div>

      ${renderSummary(props.suggestions)}
      ${props.actionMessage
        ? html`<div
            class="callout ${props.actionMessage.kind === "error" ? "danger" : "success"}"
            role="status"
          >
            ${props.actionMessage.text}
          </div>`
        : nothing}
      ${props.error ? html`<div class="callout danger" role="alert">${props.error}</div>` : nothing}
      ${props.loading && suggestions.length === 0
        ? html`<div class="memory-audit-empty">${t("memoryAudit.review.loading")}</div>`
        : suggestions.length === 0
          ? html`<div class="memory-audit-empty">
              <div class="memory-audit-empty__title">${t("memoryAudit.review.emptyTitle")}</div>
              <div class="memory-audit-empty__body">${t("memoryAudit.review.emptyBody")}</div>
            </div>`
          : html`<div class="memory-audit-list">
              ${suggestions.map((suggestion) => renderSuggestion(props, suggestion))}
            </div>`}
    </section>
  `;
}
