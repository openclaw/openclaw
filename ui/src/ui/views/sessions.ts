import { html, nothing } from "lit";

import { toast } from "../components/toast";
import { skeleton } from "../components/design-utils";
import { formatAgo } from "../format";
import { formatSessionTokens } from "../presenter";
import { pathForTab } from "../navigation";
import { icon } from "../icons";
import type { AgentsListResult, GatewayAgentRow, GatewaySessionRow, SessionsListResult } from "../types";

export type SessionsProps = {
  loading: boolean;
  result: SessionsListResult | null;
  error: string | null;
  activeMinutes: string;
  limit: string;
  includeGlobal: boolean;
  includeUnknown: boolean;
  basePath: string;
  agents: AgentsListResult | null;
  onSessionOpen?: (key: string) => void;
  onFiltersChange: (next: {
    activeMinutes: string;
    limit: string;
    includeGlobal: boolean;
    includeUnknown: boolean;
  }) => void;
  onRefresh: () => void;
  onPatch: (
    key: string,
    patch: {
      label?: string | null;
      thinkingLevel?: string | null;
      verboseLevel?: string | null;
      reasoningLevel?: string | null;
    },
  ) => void;
  onDelete: (key: string) => void;
  onAgentSessionOpen: (agentId: string) => void;
};

const THINK_LEVELS = ["", "off", "minimal", "low", "medium", "high"] as const;
const BINARY_THINK_LEVELS = ["", "off", "on"] as const;
const VERBOSE_LEVELS = [
  { value: "", label: "inherit" },
  { value: "off", label: "off (explicit)" },
  { value: "on", label: "on" },
] as const;
const REASONING_LEVELS = ["", "off", "on", "stream"] as const;

function normalizeProviderId(provider?: string | null): string {
  if (!provider) return "";
  const normalized = provider.trim().toLowerCase();
  if (normalized === "z.ai" || normalized === "z-ai") return "zai";
  return normalized;
}

function isBinaryThinkingProvider(provider?: string | null): boolean {
  return normalizeProviderId(provider) === "zai";
}

function resolveThinkLevelOptions(provider?: string | null): readonly string[] {
  return isBinaryThinkingProvider(provider) ? BINARY_THINK_LEVELS : THINK_LEVELS;
}

function resolveThinkLevelDisplay(value: string, isBinary: boolean): string {
  if (!isBinary) return value;
  if (!value || value === "off") return value;
  return "on";
}

function resolveThinkLevelPatchValue(value: string, isBinary: boolean): string | null {
  if (!value) return null;
  if (!isBinary) return value;
  if (value === "on") return "low";
  return value;
}

function truncateKey(key: string, maxLen = 28): string {
  if (key.length <= maxLen) return key;
  return key.slice(0, maxLen - 3) + "...";
}

function renderSessionsSkeleton() {
  return html`
    ${[1, 2, 3, 4, 5].map(
      (i) => html`
        <div class="data-table__row" style="animation: view-fade-in 0.2s ease-out; animation-delay: ${i * 50}ms; animation-fill-mode: backwards;">
          <div class="data-table__cell">${skeleton({ width: "140px", height: "20px" })}</div>
          <div class="data-table__cell">${skeleton({ width: "80px", height: "20px" })}</div>
          <div class="data-table__cell">${skeleton({ width: "60px", height: "20px" })}</div>
          <div class="data-table__cell">${skeleton({ width: "70px", height: "20px" })}</div>
          <div class="data-table__cell">${skeleton({ width: "50px", height: "20px" })}</div>
          <div class="data-table__cell">${skeleton({ width: "70px", height: "28px" })}</div>
          <div class="data-table__cell">${skeleton({ width: "70px", height: "28px" })}</div>
          <div class="data-table__cell">${skeleton({ width: "70px", height: "28px" })}</div>
          <div class="data-table__cell">${skeleton({ width: "60px", height: "28px" })}</div>
        </div>
      `,
    )}
  `;
}

function copyToClipboard(text: string): void {
  navigator.clipboard
    .writeText(text)
    .then(() => {
      toast.success("Session key copied");
    })
    .catch(() => {
      // Fallback for older browsers
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      toast.success("Session key copied");
    });
}

export function renderSessions(props: SessionsProps) {
  const rows = props.result?.sessions ?? [];
  const agents = props.agents?.agents ?? [];
  return html`
    ${renderAgentsSection(props, agents)}
    <section class="card">
      <!-- Modern Table Header Card -->
      <div class="table-header-card">
        <div class="table-header-card__left">
          <div class="table-header-card__icon">
            ${icon("file-text", { size: 22 })}
          </div>
          <div class="table-header-card__info">
            <div class="table-header-card__title">Sessions</div>
            <div class="table-header-card__subtitle">${rows.length} active session${rows.length !== 1 ? "s" : ""}</div>
          </div>
        </div>
        <div class="table-header-card__right">
          <button class="btn btn--secondary" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${icon("refresh-cw", { size: 14 })}
            <span>${props.loading ? "Loading..." : "Refresh"}</span>
          </button>
        </div>
      </div>

      <!-- Modern Filter Bar -->
      <div class="table-filters--modern">
        <div class="field--modern table-filters__search" style="position: relative;">
          <label class="field__label">Active within</label>
          <div class="field__input-wrapper">
            <span class="field__icon">${icon("clock", { size: 14 })}</span>
            <input
              class="field__input"
              type="text"
              placeholder="Minutes"
              .value=${props.activeMinutes}
              @input=${(e: Event) =>
                props.onFiltersChange({
                  activeMinutes: (e.target as HTMLInputElement).value,
                  limit: props.limit,
                  includeGlobal: props.includeGlobal,
                  includeUnknown: props.includeUnknown,
                })}
            />
          </div>
        </div>
        <div class="field--modern" style="min-width: 100px;">
          <label class="field__label">Limit</label>
          <input
            class="field__input"
            type="text"
            placeholder="100"
            .value=${props.limit}
            @input=${(e: Event) =>
              props.onFiltersChange({
                activeMinutes: props.activeMinutes,
                limit: (e.target as HTMLInputElement).value,
                includeGlobal: props.includeGlobal,
                includeUnknown: props.includeUnknown,
              })}
          />
        </div>
        <label class="table-filters__toggle ${props.includeGlobal ? "table-filters__toggle--active" : ""}">
          <input
            type="checkbox"
            .checked=${props.includeGlobal}
            @change=${(e: Event) =>
              props.onFiltersChange({
                activeMinutes: props.activeMinutes,
                limit: props.limit,
                includeGlobal: (e.target as HTMLInputElement).checked,
                includeUnknown: props.includeUnknown,
              })}
          />
          <span>Global</span>
        </label>
        <label class="table-filters__toggle ${props.includeUnknown ? "table-filters__toggle--active" : ""}">
          <input
            type="checkbox"
            .checked=${props.includeUnknown}
            @change=${(e: Event) =>
              props.onFiltersChange({
                activeMinutes: props.activeMinutes,
                limit: props.limit,
                includeGlobal: props.includeGlobal,
                includeUnknown: (e.target as HTMLInputElement).checked,
              })}
          />
          <span>Unknown</span>
        </label>
      </div>

      ${props.error
        ? html`
          <div class="callout--danger" style="margin-top: 12px;">
            <div class="callout__icon">${icon("alert-circle", { size: 18 })}</div>
            <div class="callout__content">${props.error}</div>
          </div>
        `
        : nothing}

      ${props.result
        ? html`<div class="muted" style="font-size: 11px; margin-top: 4px;">Store: ${props.result.path}</div>`
        : nothing}

      <div class="data-table data-table--modern sessions-table">
        <div class="data-table__header">
          <div class="data-table__header-cell data-table__header-cell--sortable">Key</div>
          <div class="data-table__header-cell">Label</div>
          <div class="data-table__header-cell">Kind</div>
          <div class="data-table__header-cell data-table__header-cell--sortable">Updated</div>
          <div class="data-table__header-cell">Tokens</div>
          <div class="data-table__header-cell">Thinking</div>
          <div class="data-table__header-cell">Verbose</div>
          <div class="data-table__header-cell">Reasoning</div>
          <div class="data-table__header-cell data-table__header-cell--actions">Actions</div>
        </div>
        <div class="data-table__body" aria-busy=${props.loading && !props.result}>
          ${props.loading && !props.result
            ? renderSessionsSkeleton()
            : rows.length === 0
              ? html`
                <div class="data-table__empty">
                  <div class="data-table__empty-icon">${icon("file-text", { size: 32 })}</div>
                  <div class="data-table__empty-title">No sessions found</div>
                  <div class="data-table__empty-desc">Sessions will appear here when users start conversations</div>
                </div>
              `
              : rows.map((row) =>
                  renderRow(
                    row,
                    props.basePath,
                    props.onPatch,
                    props.onDelete,
                    props.onSessionOpen,
                    props.loading,
                  ),
                )}
        </div>
      </div>
    </section>
  `;
}

function renderAgentsSection(props: SessionsProps, agents: GatewayAgentRow[]) {
  if (agents.length === 0) return nothing;
  return html`
    <section class="card" style="margin-bottom: 20px;">
      <div class="card-header">
        <div class="card-header__icon">
          ${icon("user", { size: 20 })}
        </div>
        <div>
          <div class="card-title">Agents</div>
          <div class="card-sub">Start or navigate to an agent session</div>
        </div>
      </div>
      <div class="agent-cards" style="margin-top: 16px;">
        ${agents.map((agent) => renderAgentCard(agent, props))}
      </div>
    </section>
  `;
}

function renderAgentCard(agent: GatewayAgentRow, props: SessionsProps) {
  const name = agent.identity?.name ?? agent.name ?? agent.id;
  const emoji = agent.identity?.emoji ?? "";
  const avatar = agent.identity?.avatarUrl ?? agent.identity?.avatar ?? null;
  const hasExistingSession = findExistingAgentSession(props.result, agent.id);
  const buttonLabel = hasExistingSession ? "Open" : "Start";

  return html`
    <div class="agent-card">
      ${avatar
        ? html`<img class="agent-card__avatar" src=${avatar} alt="" />`
        : html`<div class="agent-card__emoji">${emoji || "🤖"}</div>`}
      <div class="agent-card__info">
        <div class="agent-card__name">${name}</div>
        <div class="agent-card__id">${agent.id}</div>
      </div>
      <button
        class="btn btn--primary btn--sm"
        ?disabled=${props.loading}
        @click=${() => props.onAgentSessionOpen(agent.id)}
      >
        ${icon(hasExistingSession ? "message-square" : "play", { size: 12 })}
        <span>${buttonLabel}</span>
      </button>
    </div>
  `;
}

function findExistingAgentSession(
  sessions: SessionsListResult | null,
  agentId: string,
): boolean {
  if (!sessions?.sessions) return false;
  const prefix = `agent:${agentId.toLowerCase()}:`;
  return sessions.sessions.some((s) => s.key.toLowerCase().startsWith(prefix));
}

function renderRow(
  row: GatewaySessionRow,
  basePath: string,
  onPatch: SessionsProps["onPatch"],
  onDelete: SessionsProps["onDelete"],
  onSessionOpen: SessionsProps["onSessionOpen"],
  disabled: boolean,
) {
  const updated = row.updatedAt ? formatAgo(row.updatedAt) : "n/a";
  const rawThinking = row.thinkingLevel ?? "";
  const isBinaryThinking = isBinaryThinkingProvider(row.modelProvider);
  const thinking = resolveThinkLevelDisplay(rawThinking, isBinaryThinking);
  const thinkLevels = resolveThinkLevelOptions(row.modelProvider);
  const verbose = row.verboseLevel ?? "";
  const reasoning = row.reasoningLevel ?? "";
  const displayName = row.displayName ?? row.key;
  const canLink = row.kind !== "global";
  const chatUrl = canLink
    ? `${pathForTab("chat", basePath)}?session=${encodeURIComponent(row.key)}`
    : null;

  const kindBadgeClass = row.kind === "global"
    ? "badge--muted"
    : row.kind === "direct"
      ? "badge--accent badge--animated"
      : "badge--info badge--animated";

  return html`
    <div class="data-table__row">
      <div class="data-table__cell" data-label="Key">
        <div class="session-key">
          ${canLink
            ? html`<a
                href=${chatUrl}
                class="session-key__text"
                title=${row.key}
                @click=${(event: MouseEvent) => {
                  if (!onSessionOpen) return;
                  if (
                    event.defaultPrevented ||
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  ) {
                    return;
                  }
                  event.preventDefault();
                  onSessionOpen(row.key);
                }}
              >${truncateKey(displayName)}</a>`
            : html`<span class="session-key__text" style="color: var(--muted);" title=${row.key}>${truncateKey(displayName)}</span>`}
          <button
            class="session-key__copy"
            title="Copy session key"
            aria-label="Copy session key"
            @click=${(e: Event) => {
              e.stopPropagation();
              copyToClipboard(row.key);
            }}
          >
            ${icon("copy", { size: 12 })}
          </button>
        </div>
      </div>
      <div class="data-table__cell" data-label="Label">
        <input
          class="field__input"
          style="padding: 6px 10px; font-size: 12px; border-radius: 8px;"
          .value=${row.label ?? ""}
          ?disabled=${disabled}
          placeholder="Label"
          @change=${(e: Event) => {
            const value = (e.target as HTMLInputElement).value.trim();
            onPatch(row.key, { label: value || null });
          }}
        />
      </div>
      <div class="data-table__cell" data-label="Kind">
        <span class="badge ${kindBadgeClass}">${row.kind}</span>
      </div>
      <div class="data-table__cell" data-label="Updated" style="font-size: 12px; color: var(--muted);">${updated}</div>
      <div class="data-table__cell" data-label="Tokens">
        <span class="badge badge--muted">${formatSessionTokens(row)}</span>
      </div>
      <div class="data-table__cell" data-label="Thinking">
        <select
          class="field__input"
          style="padding: 6px 28px 6px 10px; font-size: 11px; border-radius: 8px;"
          .value=${thinking}
          ?disabled=${disabled}
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            onPatch(row.key, {
              thinkingLevel: resolveThinkLevelPatchValue(value, isBinaryThinking),
            });
          }}
        >
          ${thinkLevels.map((level) =>
            html`<option value=${level}>${level || "inherit"}</option>`,
          )}
        </select>
      </div>
      <div class="data-table__cell" data-label="Verbose">
        <select
          class="field__input"
          style="padding: 6px 28px 6px 10px; font-size: 11px; border-radius: 8px;"
          .value=${verbose}
          ?disabled=${disabled}
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            onPatch(row.key, { verboseLevel: value || null });
          }}
        >
          ${VERBOSE_LEVELS.map(
            (level) => html`<option value=${level.value}>${level.label}</option>`,
          )}
        </select>
      </div>
      <div class="data-table__cell" data-label="Reasoning">
        <select
          class="field__input"
          style="padding: 6px 28px 6px 10px; font-size: 11px; border-radius: 8px;"
          .value=${reasoning}
          ?disabled=${disabled}
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            onPatch(row.key, { reasoningLevel: value || null });
          }}
        >
          ${REASONING_LEVELS.map((level) =>
            html`<option value=${level}>${level || "inherit"}</option>`,
          )}
        </select>
      </div>
      <div class="data-table__cell data-table__cell--actions" data-label="">
        <div class="row-actions row-actions--modern">
          ${canLink
            ? html`
              <button
                class="row-actions__btn"
                title="Open chat"
                aria-label="Open chat"
                ?disabled=${disabled}
                @click=${() => onSessionOpen?.(row.key)}
              >
                ${icon("message-square", { size: 14 })}
              </button>
            `
            : nothing}
          <button
            class="row-actions__btn row-actions__btn--danger"
            title="Delete session"
            aria-label="Delete session"
            ?disabled=${disabled}
            @click=${() => onDelete(row.key)}
          >
            ${icon("trash", { size: 14 })}
          </button>
        </div>
      </div>
    </div>
  `;
}
