import { msg } from "@lit/localize";
import { html, nothing } from "lit";
import type { GatewaySessionRow, SessionsListResult } from "../types.ts";
import { formatAgo } from "../format.ts";
import { pathForTab } from "../navigation.ts";
import { formatSessionTokens } from "../presenter.ts";

export type SessionsProps = {
  loading: boolean;
  result: SessionsListResult | null;
  error: string | null;
  activeMinutes: string;
  limit: string;
  includeGlobal: boolean;
  includeUnknown: boolean;
  basePath: string;
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
};

const THINK_LEVELS = ["", "off", "minimal", "low", "medium", "high"] as const;
const BINARY_THINK_LEVELS = ["", "off", "on"] as const;
const VERBOSE_LEVELS = [
  { value: "", label: "inherit", id: "sessions.verbose.inherit" },
  { value: "off", label: "off (explicit)", id: "sessions.verbose.offExplicit" },
  { value: "on", label: "on", id: "sessions.verbose.on" },
] as const;
const REASONING_LEVELS = ["", "off", "on", "stream"] as const;

function normalizeProviderId(provider?: string | null): string {
  if (!provider) {
    return "";
  }
  const normalized = provider.trim().toLowerCase();
  if (normalized === "z.ai" || normalized === "z-ai") {
    return "zai";
  }
  return normalized;
}

function isBinaryThinkingProvider(provider?: string | null): boolean {
  return normalizeProviderId(provider) === "zai";
}

function resolveThinkLevelOptions(provider?: string | null): readonly string[] {
  return isBinaryThinkingProvider(provider) ? BINARY_THINK_LEVELS : THINK_LEVELS;
}

function resolveThinkLevelDisplay(value: string, isBinary: boolean): string {
  if (!isBinary) {
    return value;
  }
  if (!value || value === "off") {
    return value;
  }
  return "on";
}

function resolveThinkLevelPatchValue(value: string, isBinary: boolean): string | null {
  if (!value) {
    return null;
  }
  if (!isBinary) {
    return value;
  }
  if (value === "on") {
    return "low";
  }
  return value;
}

function formatThinkLevelLabel(level: string) {
  if (!level) {
    return msg("inherit", { id: "sessions.think.inherit" });
  }
  const labels: Record<string, { label: string; id: string }> = {
    off: { label: "off", id: "sessions.think.off" },
    minimal: { label: "minimal", id: "sessions.think.minimal" },
    low: { label: "low", id: "sessions.think.low" },
    medium: { label: "medium", id: "sessions.think.medium" },
    high: { label: "high", id: "sessions.think.high" },
    on: { label: "on", id: "sessions.think.on" },
    stream: { label: "stream", id: "sessions.think.stream" },
  };
  const entry = labels[level];
  return entry ? msg(entry.label, { id: entry.id }) : level;
}

export function renderSessions(props: SessionsProps) {
  const rows = props.result?.sessions ?? [];
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">${msg("Sessions", { id: "sessions.title" })}</div>
          <div class="card-sub">${msg("Active session keys and per-session overrides.", {
            id: "sessions.sub",
          })}</div>
        </div>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? msg("Loading…", { id: "sessions.loading" }) : msg("Refresh", { id: "sessions.refresh" })}
        </button>
      </div>

      <div class="filters" style="margin-top: 14px;">
        <label class="field">
          <span>${msg("Active within (minutes)", { id: "sessions.activeMinutes" })}</span>
          <input
            .value=${props.activeMinutes}
            @input=${(e: Event) =>
              props.onFiltersChange({
                activeMinutes: (e.target as HTMLInputElement).value,
                limit: props.limit,
                includeGlobal: props.includeGlobal,
                includeUnknown: props.includeUnknown,
              })}
          />
        </label>
        <label class="field">
          <span>${msg("Limit", { id: "sessions.limit" })}</span>
          <input
            .value=${props.limit}
            @input=${(e: Event) =>
              props.onFiltersChange({
                activeMinutes: props.activeMinutes,
                limit: (e.target as HTMLInputElement).value,
                includeGlobal: props.includeGlobal,
                includeUnknown: props.includeUnknown,
              })}
          />
        </label>
        <label class="field checkbox">
          <span>${msg("Include global", { id: "sessions.includeGlobal" })}</span>
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
        </label>
        <label class="field checkbox">
          <span>${msg("Include unknown", { id: "sessions.includeUnknown" })}</span>
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
        </label>
      </div>

      ${
        props.error
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
          : nothing
      }

      <div class="muted" style="margin-top: 12px;">
        ${props.result ? msg("Store: ", { id: "sessions.storeLabel" }) + props.result.path : ""}
      </div>

      <div class="table" style="margin-top: 16px;">
        <div class="table-head">
          <div>${msg("Key", { id: "sessions.table.key" })}</div>
          <div>${msg("Label", { id: "sessions.table.label" })}</div>
          <div>${msg("Kind", { id: "sessions.table.kind" })}</div>
          <div>${msg("Updated", { id: "sessions.table.updated" })}</div>
          <div>${msg("Tokens", { id: "sessions.table.tokens" })}</div>
          <div>${msg("Thinking", { id: "sessions.table.thinking" })}</div>
          <div>${msg("Verbose", { id: "sessions.table.verbose" })}</div>
          <div>${msg("Reasoning", { id: "sessions.table.reasoning" })}</div>
          <div>${msg("Actions", { id: "sessions.table.actions" })}</div>
        </div>
        ${
          rows.length === 0
            ? html`
                <div class="muted">${msg("No sessions found.", { id: "sessions.empty" })}</div>
              `
            : rows.map((row) =>
                renderRow(row, props.basePath, props.onPatch, props.onDelete, props.loading),
              )
        }
      </div>
    </section>
  `;
}

function renderRow(
  row: GatewaySessionRow,
  basePath: string,
  onPatch: SessionsProps["onPatch"],
  onDelete: SessionsProps["onDelete"],
  disabled: boolean,
) {
  const updated = row.updatedAt ? formatAgo(row.updatedAt) : msg("n/a", { id: "sessions.na" });
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

  return html`
    <div class="table-row">
      <div class="mono">${
        canLink ? html`<a href=${chatUrl} class="session-link">${displayName}</a>` : displayName
      }</div>
      <div>
        <input
          .value=${row.label ?? ""}
          ?disabled=${disabled}
          placeholder=${msg("(optional)", { id: "sessions.optional" })}
          @change=${(e: Event) => {
            const value = (e.target as HTMLInputElement).value.trim();
            onPatch(row.key, { label: value || null });
          }}
        />
      </div>
      <div>${row.kind}</div>
      <div>${updated}</div>
      <div>${formatSessionTokens(row)}</div>
      <div>
        <select
          .value=${thinking}
          ?disabled=${disabled}
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            onPatch(row.key, {
              thinkingLevel: resolveThinkLevelPatchValue(value, isBinaryThinking),
            });
          }}
        >
          ${thinkLevels.map(
            (level) => html`<option value=${level}>${formatThinkLevelLabel(level)}</option>`,
          )}
        </select>
      </div>
      <div>
        <select
          .value=${verbose}
          ?disabled=${disabled}
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            onPatch(row.key, { verboseLevel: value || null });
          }}
        >
          ${VERBOSE_LEVELS.map(
            (level) =>
              html`<option value=${level.value}>${msg(level.label, { id: level.id })}</option>`,
          )}
        </select>
      </div>
      <div>
        <select
          .value=${reasoning}
          ?disabled=${disabled}
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            onPatch(row.key, { reasoningLevel: value || null });
          }}
        >
          ${REASONING_LEVELS.map(
            (level) => html`<option value=${level}>${formatThinkLevelLabel(level)}</option>`,
          )}
        </select>
      </div>
      <div>
        <button class="btn danger" ?disabled=${disabled} @click=${() => onDelete(row.key)}>
          ${msg("Delete", { id: "sessions.delete" })}
        </button>
      </div>
    </div>
  `;
}
