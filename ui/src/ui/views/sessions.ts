import { html, nothing } from "lit";
import { formatRelativeTimestamp } from "../format.ts";
import { pathForTab } from "../navigation.ts";
import { formatSessionTokens } from "../presenter.ts";
import type { GatewaySessionRow, SessionsListResult } from "../types.ts";

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
  onViewSession: (key: string) => void;
  sessionHistoryLoading: boolean;
  sessionHistoryKey: string | null;
  sessionHistoryMessages: unknown[];
  onCloseSessionHistory: () => void;
};

const THINK_LEVELS = ["", "off", "minimal", "low", "medium", "high", "xhigh"] as const;
const BINARY_THINK_LEVELS = ["", "off", "on"] as const;
const VERBOSE_LEVELS = [
  { value: "", label: "inherit" },
  { value: "off", label: "off (explicit)" },
  { value: "on", label: "on" },
  { value: "full", label: "full" },
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

function withCurrentOption(options: readonly string[], current: string): string[] {
  if (!current) {
    return [...options];
  }
  if (options.includes(current)) {
    return [...options];
  }
  return [...options, current];
}

function withCurrentLabeledOption(
  options: readonly { value: string; label: string }[],
  current: string,
): Array<{ value: string; label: string }> {
  if (!current) {
    return [...options];
  }
  if (options.some((option) => option.value === current)) {
    return [...options];
  }
  return [...options, { value: current, label: `${current} (custom)` }];
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

export function renderSessions(props: SessionsProps) {
  const rows = props.result?.sessions ?? [];
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Sessions</div>
          <div class="card-sub">Active session keys and per-session overrides.</div>
        </div>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <div class="filters" style="margin-top: 14px;">
        <label class="field">
          <span>Active within (minutes)</span>
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
          <span>Limit</span>
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
          <span>Include global</span>
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
          <span>Include unknown</span>
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
        ${props.result ? `Store: ${props.result.path}` : ""}
      </div>

      <div class="table" style="margin-top: 16px;">
        <div class="table-head">
          <div>Key</div>
          <div>Label</div>
          <div>Kind</div>
          <div>Updated</div>
          <div>Tokens</div>
          <div>Thinking</div>
          <div>Verbose</div>
          <div>Reasoning</div>
          <div>Actions</div>
        </div>
        ${
          rows.length === 0
            ? html`
                <div class="muted">No sessions found.</div>
              `
            : rows.map((row) =>
                renderRow(
                  row,
                  props.basePath,
                  props.onPatch,
                  props.onDelete,
                  props.onViewSession,
                  props.loading,
                ),
              )
        }
      </div>
    </section>

    ${
      props.sessionHistoryKey
        ? renderSessionHistoryModal({
            sessionKey: props.sessionHistoryKey,
            messages: props.sessionHistoryMessages,
            loading: props.sessionHistoryLoading,
            onClose: props.onCloseSessionHistory,
          })
        : nothing
    }
  `;
}

function renderRow(
  row: GatewaySessionRow,
  basePath: string,
  onPatch: SessionsProps["onPatch"],
  onDelete: SessionsProps["onDelete"],
  onViewSession: SessionsProps["onViewSession"],
  disabled: boolean,
) {
  const updated = row.updatedAt ? formatRelativeTimestamp(row.updatedAt) : "n/a";
  const rawThinking = row.thinkingLevel ?? "";
  const isBinaryThinking = isBinaryThinkingProvider(row.modelProvider);
  const thinking = resolveThinkLevelDisplay(rawThinking, isBinaryThinking);
  const thinkLevels = withCurrentOption(resolveThinkLevelOptions(row.modelProvider), thinking);
  const verbose = row.verboseLevel ?? "";
  const verboseLevels = withCurrentLabeledOption(VERBOSE_LEVELS, verbose);
  const reasoning = row.reasoningLevel ?? "";
  const reasoningLevels = withCurrentOption(REASONING_LEVELS, reasoning);
  const displayName =
    typeof row.displayName === "string" && row.displayName.trim().length > 0
      ? row.displayName.trim()
      : null;
  const label = typeof row.label === "string" ? row.label.trim() : "";
  const showDisplayName = Boolean(displayName && displayName !== row.key && displayName !== label);
  const canLink = row.kind !== "global";
  const chatUrl = canLink
    ? `${pathForTab("chat", basePath)}?session=${encodeURIComponent(row.key)}`
    : null;

  return html`
    <div class="table-row">
      <div class="mono session-key-cell">
        ${canLink ? html`<a href=${chatUrl} class="session-link">${row.key}</a>` : row.key}
        ${showDisplayName ? html`<span class="muted session-key-display-name">${displayName}</span>` : nothing}
      </div>
      <div>
        <input
          .value=${row.label ?? ""}
          ?disabled=${disabled}
          placeholder="(optional)"
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
          ?disabled=${disabled}
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            onPatch(row.key, {
              thinkingLevel: resolveThinkLevelPatchValue(value, isBinaryThinking),
            });
          }}
        >
          ${thinkLevels.map(
            (level) =>
              html`<option value=${level} ?selected=${thinking === level}>
                ${level || "inherit"}
              </option>`,
          )}
        </select>
      </div>
      <div>
        <select
          ?disabled=${disabled}
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            onPatch(row.key, { verboseLevel: value || null });
          }}
        >
          ${verboseLevels.map(
            (level) =>
              html`<option value=${level.value} ?selected=${verbose === level.value}>
                ${level.label}
              </option>`,
          )}
        </select>
      </div>
      <div>
        <select
          ?disabled=${disabled}
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            onPatch(row.key, { reasoningLevel: value || null });
          }}
        >
          ${reasoningLevels.map(
            (level) =>
              html`<option value=${level} ?selected=${reasoning === level}>
                ${level || "inherit"}
              </option>`,
          )}
        </select>
      </div>
      <div style="display:flex;gap:6px;">
        <button class="btn" ?disabled=${disabled} @click=${() => onViewSession(row.key)}>
          View
        </button>
        <button class="btn danger" ?disabled=${disabled} @click=${() => onDelete(row.key)}>
          Delete
        </button>
      </div>
    </div>
  `;
}

type HistoryMessage = { role: string; text: string };

function extractHistoryMessages(raw: unknown[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const msg of raw) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const m = msg as Record<string, unknown>;
    const role = typeof m.role === "string" ? m.role.trim() : "";
    if (!role || role === "tool") {
      continue;
    }
    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = (m.content as unknown[])
        .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
        .filter((c) => c.type === "text")
        .map((c) => (typeof c.text === "string" ? c.text : ""))
        .join("\n");
    }
    if (text.trim()) {
      out.push({ role, text: text.trim() });
    }
  }
  return out;
}

function copyText(text: string): void {
  navigator.clipboard.writeText(text).catch(() => undefined);
}

function renderSessionHistoryModal(props: {
  sessionKey: string;
  messages: unknown[];
  loading: boolean;
  onClose: () => void;
}) {
  const msgs = extractHistoryMessages(props.messages);
  const allText = msgs
    .map((m) => `${m.role === "user" ? "You" : "MaxBot"}: ${m.text}`)
    .join("\n\n");

  const closeOnBackdrop = (e: MouseEvent) => {
    if (e.target === e.currentTarget) {
      props.onClose();
    }
  };

  const closeOnEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      props.onClose();
    }
  };

  return html`
    <div
      class="sh-overlay"
      @click=${closeOnBackdrop}
      @keydown=${closeOnEsc}
      tabindex="-1"
    >
      <div class="sh-panel card">
        <div class="sh-header">
          <span class="sh-title mono">${props.sessionKey}</span>
          <div style="display:flex;gap:8px;align-items:center;">
            ${
              msgs.length > 0
                ? html`<button class="btn" @click=${() => copyText(allText)}>Copy all</button>`
                : nothing
            }
            <button class="btn" @click=${props.onClose}>✕</button>
          </div>
        </div>

        <div class="sh-messages">
          ${
            props.loading
              ? html`
                  <div class="muted" style="padding: 20px">Loading…</div>
                `
              : msgs.length === 0
                ? html`
                    <div class="muted" style="padding: 20px">No messages found for this session.</div>
                  `
                : msgs.map(
                    (m) => html`
                    <div class="sh-msg sh-msg-${m.role}">
                      <div class="sh-msg-header">
                        <span class="sh-msg-role">${m.role === "user" ? "You" : "MaxBot"}</span>
                        <button
                          class="btn sh-msg-copy"
                          title="Copy message"
                          @click=${() => copyText(m.text)}
                        >Copy</button>
                      </div>
                      <pre class="sh-msg-text">${m.text}</pre>
                    </div>
                  `,
                  )
          }
        </div>
      </div>
    </div>
  `;
}
