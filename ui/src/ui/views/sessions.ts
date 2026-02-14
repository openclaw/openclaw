import { html, nothing } from "lit";
import type { GatewaySessionRow, SessionsListResult } from "../types.ts";
import { formatRelativeTimestamp } from "../format.ts";
import { pathForTab } from "../navigation.ts";
import { formatSessionTokens } from "../presenter.ts";
import { icons } from "../icons.ts";
import type { AppMode } from "../navigation.ts";

export type SessionsProps = {
  mode: AppMode;
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

const THINK_LEVELS = ["", "off", "minimal", "low", "medium", "high", "xhigh"] as const;
const BINARY_THINK_LEVELS = ["", "off", "on"] as const;
const VERBOSE_LEVELS = [
  { value: "", label: "inherit" },
  { value: "off", label: "off (explicit)" },
  { value: "on", label: "on" },
  { value: "full", label: "full" },
] as const;
const REASONING_LEVELS = ["", "off", "on", "stream"] as const;

let selectedSessionKey: string | null = null;

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

function withCurrentOption(options: readonly string[], current: string): string[] {
  if (!current) return [...options];
  if (options.includes(current)) return [...options];
  return [...options, current];
}

function withCurrentLabeledOption(
  options: readonly { value: string; label: string }[],
  current: string,
): Array<{ value: string; label: string }> {
  if (!current) return [...options];
  if (options.some((option) => option.value === current)) return [...options];
  return [...options, { value: current, label: `${current} (custom)` }];
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

function renderSessionDetail(row: GatewaySessionRow, props: SessionsProps) {
  const isBinaryThinking = isBinaryThinkingProvider(row.modelProvider);
  const rawThinking = row.thinkingLevel ?? "";
  const thinking = resolveThinkLevelDisplay(rawThinking, isBinaryThinking);
  const thinkLevels = withCurrentOption(resolveThinkLevelOptions(row.modelProvider), thinking);
  const verbose = row.verboseLevel ?? "";
  const verboseLevels = withCurrentLabeledOption(VERBOSE_LEVELS, verbose);
  const reasoning = row.reasoningLevel ?? "";
  const reasoningLevels = withCurrentOption(REASONING_LEVELS, reasoning);
  const canLink = row.kind !== "global";
  const chatUrl = canLink
    ? `${pathForTab("chat", props.basePath)}?session=${encodeURIComponent(row.key)}`
    : null;
  const requestUpdate = () => props.onFiltersChange({
    activeMinutes: props.activeMinutes,
    limit: props.limit,
    includeGlobal: props.includeGlobal,
    includeUnknown: props.includeUnknown,
  });

  return html`
    <div class="log-detail" style="max-height: none;">
      <div class="log-detail-header">
        <div class="card-title" style="font-size: 13px; display: flex; align-items: center; gap: 6px;">
          <span class="icon" style="width: 14px; height: 14px;">${icons.messageSquare}</span>
          Session
        </div>
        <button class="btn btn--sm" @click=${() => { selectedSessionKey = null; requestUpdate(); }}><span class="icon" style="width:12px;height:12px;">${icons.x}</span></button>
      </div>
      <div class="log-detail-fields">
        <div class="log-detail-field">
          <div class="log-detail-label">Key</div>
          <div class="log-detail-value mono" style="font-size: 11px; word-break: break-all;">${row.key}</div>
        </div>
        ${row.displayName ? html`
          <div class="log-detail-field">
            <div class="log-detail-label">Display Name</div>
            <div class="log-detail-value">${row.displayName}</div>
          </div>
        ` : nothing}
        <div class="log-detail-row-inline">
          <div class="log-detail-field" style="flex: 1;">
            <div class="log-detail-label">Kind</div>
            <div class="log-detail-value"><span class="log-level info">${row.kind}</span></div>
          </div>
          <div class="log-detail-field" style="flex: 1;">
            <div class="log-detail-label">Tokens</div>
            <div class="log-detail-value mono">${formatSessionTokens(row)}</div>
          </div>
        </div>
        <div class="log-detail-field">
          <div class="log-detail-label">Updated</div>
          <div class="log-detail-value">${row.updatedAt ? formatRelativeTimestamp(row.updatedAt) : "n/a"}</div>
        </div>
        <div class="log-detail-field">
          <div class="log-detail-label">Label</div>
          <input style="font-size: 12px;"
            .value=${row.label ?? ""}
            ?disabled=${props.loading}
            placeholder="(optional)"
            @change=${(e: Event) => {
              const value = (e.target as HTMLInputElement).value.trim();
              props.onPatch(row.key, { label: value || null });
            }}
          />
        </div>
        <div class="log-detail-row-inline">
          <div class="log-detail-field" style="flex: 1;">
            <div class="log-detail-label">Thinking</div>
            <select style="font-size: 12px;" ?disabled=${props.loading}
              @change=${(e: Event) => {
                const value = (e.target as HTMLSelectElement).value;
                props.onPatch(row.key, { thinkingLevel: resolveThinkLevelPatchValue(value, isBinaryThinking) });
              }}>
              ${thinkLevels.map((level) => html`<option value=${level} ?selected=${thinking === level}>${level || "inherit"}</option>`)}
            </select>
          </div>
          <div class="log-detail-field" style="flex: 1;">
            <div class="log-detail-label">Reasoning</div>
            <select style="font-size: 12px;" ?disabled=${props.loading}
              @change=${(e: Event) => {
                const value = (e.target as HTMLSelectElement).value;
                props.onPatch(row.key, { reasoningLevel: value || null });
              }}>
              ${reasoningLevels.map((level) => html`<option value=${level} ?selected=${reasoning === level}>${level || "inherit"}</option>`)}
            </select>
          </div>
        </div>
        <div class="log-detail-field">
          <div class="log-detail-label">Verbose</div>
          <select style="font-size: 12px;" ?disabled=${props.loading}
            @change=${(e: Event) => {
              const value = (e.target as HTMLSelectElement).value;
              props.onPatch(row.key, { verboseLevel: value || null });
            }}>
            ${verboseLevels.map((level) => html`<option value=${level.value} ?selected=${verbose === level.value}>${level.label}</option>`)}
          </select>
        </div>
        <div class="row" style="gap: 8px; margin-top: 8px;">
          ${chatUrl ? html`<a href=${chatUrl} class="btn btn--sm">Open Chat</a>` : nothing}
          <button class="btn btn--sm danger" ?disabled=${props.loading} @click=${() => props.onDelete(row.key)}>Delete</button>
        </div>
      </div>
    </div>
  `;
}

export function renderSessions(props: SessionsProps) {
  const rows = props.result?.sessions ?? [];
  const isBasic = props.mode === "basic";
  const selectedRow = rows.find((r) => r.key === selectedSessionKey) ?? null;
  if (!selectedRow) selectedSessionKey = null;

  const requestUpdate = () => props.onFiltersChange({
    activeMinutes: props.activeMinutes,
    limit: props.limit,
    includeGlobal: props.includeGlobal,
    includeUnknown: props.includeUnknown,
  });

  return html`
    <section class="card" style="padding: 0;">
      <div class="row" style="justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--border);">
        <div>
          <div class="card-title">Sessions</div>
          <div class="card-sub">${rows.length} active</div>
        </div>
        <div class="row" style="gap: 8px; flex-wrap: wrap;">
          <input type="text" style="width: 80px; font-size: 12px;" placeholder="Minutes"
            .value=${props.activeMinutes}
            @input=${(e: Event) => props.onFiltersChange({
              activeMinutes: (e.target as HTMLInputElement).value,
              limit: props.limit,
              includeGlobal: props.includeGlobal,
              includeUnknown: props.includeUnknown,
            })} />
          <input type="text" style="width: 60px; font-size: 12px;" placeholder="Limit"
            .value=${props.limit}
            @input=${(e: Event) => props.onFiltersChange({
              activeMinutes: props.activeMinutes,
              limit: (e.target as HTMLInputElement).value,
              includeGlobal: props.includeGlobal,
              includeUnknown: props.includeUnknown,
            })} />
          ${!isBasic ? html`
            <label style="display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--muted);">
              <input type="checkbox" .checked=${props.includeGlobal}
                @change=${(e: Event) => props.onFiltersChange({
                  activeMinutes: props.activeMinutes,
                  limit: props.limit,
                  includeGlobal: (e.target as HTMLInputElement).checked,
                  includeUnknown: props.includeUnknown,
                })} /> Global
            </label>
            <label style="display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--muted);">
              <input type="checkbox" .checked=${props.includeUnknown}
                @change=${(e: Event) => props.onFiltersChange({
                  activeMinutes: props.activeMinutes,
                  limit: props.limit,
                  includeGlobal: props.includeGlobal,
                  includeUnknown: (e.target as HTMLInputElement).checked,
                })} /> Unknown
            </label>
          ` : nothing}
          <button class="btn btn--sm" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      ${props.error ? html`<div class="callout danger" style="margin: 12px 14px;">${props.error}</div>` : nothing}

      <div class="logs-split ${selectedRow ? "logs-split--open" : ""}">
        <div style="flex: 1; min-width: 0; overflow: hidden;">
          <div class="log-stream" style="max-height: 600px;">
            <div class="log-header" style="grid-template-columns: minmax(0, 1fr) 100px 70px 100px;">
              <div class="log-header-cell">Key</div>
              <div class="log-header-cell">Updated</div>
              <div class="log-header-cell">Kind</div>
              <div class="log-header-cell">Tokens</div>
            </div>
            ${rows.length === 0
              ? html`<div class="muted" style="padding: 12px 14px;">No sessions found.</div>`
              : rows.map((row) => {
                  const label = row.label?.trim() || row.displayName?.trim() || "";
                  const shortKey = row.key.length > 40 ? `…${row.key.slice(-35)}` : row.key;
                  return html`
                    <div class="log-row ${selectedSessionKey === row.key ? "selected" : ""}"
                      style="grid-template-columns: minmax(0, 1fr) 100px 70px 100px;"
                      @click=${() => { selectedSessionKey = row.key; requestUpdate(); }}>
                      <div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                        <span class="mono" style="font-size: 11px;">${shortKey}</span>
                        ${label ? html`<span class="muted" style="margin-left: 6px; font-size: 11px;">${label}</span>` : nothing}
                      </div>
                      <div class="mono" style="font-size: 11px; color: var(--muted);">${row.updatedAt ? formatRelativeTimestamp(row.updatedAt) : "n/a"}</div>
                      <div><span class="log-level info" style="font-size: 10px;">${row.kind}</span></div>
                      <div class="mono" style="font-size: 11px; color: var(--muted);">${formatSessionTokens(row)}</div>
                    </div>
                  `;
                })
            }
          </div>
        </div>
        ${selectedRow ? renderSessionDetail(selectedRow, props) : nothing}
      </div>
    </section>
  `;
}
