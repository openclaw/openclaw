import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../format.ts";
import { icons } from "../icons.ts";
import { pathForTab } from "../navigation.ts";
import { formatSessionTokens } from "../presenter.ts";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "../string-coerce.ts";
import type {
  GatewaySessionRow,
  SessionCompactionCheckpoint,
  SessionsListResult,
} from "../types.ts";

export type SessionsProps = {
  loading: boolean;
  result: SessionsListResult | null;
  error: string | null;
  activeMinutes: string;
  limit: string;
  includeGlobal: boolean;
  includeUnknown: boolean;
  basePath: string;
  searchQuery: string;
  sortColumn: "key" | "kind" | "updated" | "tokens";
  sortDir: "asc" | "desc";
  page: number;
  pageSize: number;
  selectedKeys: Set<string>;
  expandedCheckpointKey: string | null;
  checkpointItemsByKey: Record<string, SessionCompactionCheckpoint[]>;
  checkpointLoadingKey: string | null;
  checkpointBusyKey: string | null;
  checkpointErrorByKey: Record<string, string>;
  onFiltersChange: (next: {
    activeMinutes: string;
    limit: string;
    includeGlobal: boolean;
    includeUnknown: boolean;
  }) => void;
  onSearchChange: (query: string) => void;
  onSortChange: (column: "key" | "kind" | "updated" | "tokens", dir: "asc" | "desc") => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onRefresh: () => void;
  onPatch: (
    key: string,
    patch: {
      label?: string | null;
      thinkingLevel?: string | null;
      fastMode?: boolean | null;
      verboseLevel?: string | null;
      reasoningLevel?: string | null;
    },
  ) => void;
  onToggleSelect: (key: string) => void;
  onSelectPage: (keys: string[]) => void;
  onDeselectPage: (keys: string[]) => void;
  onDeselectAll: () => void;
  onDeleteSelected: () => void;
  onNavigateToChat?: (sessionKey: string) => void;
  onToggleCheckpointDetails: (sessionKey: string) => void;
  onBranchFromCheckpoint: (sessionKey: string, checkpointId: string) => void | Promise<void>;
  onRestoreCheckpoint: (sessionKey: string, checkpointId: string) => void | Promise<void>;
};

const THINK_LEVELS = ["", "off", "minimal", "low", "medium", "high", "xhigh"] as const;
const BINARY_THINK_LEVELS = ["", "off", "on"] as const;
const VERBOSE_LEVELS = ["", "off", "on", "full"] as const;
const FAST_LEVELS = ["", "on", "off"] as const;
const REASONING_LEVELS = ["", "off", "on", "stream"] as const;
const PAGE_SIZES = [10, 25, 50, 100] as const;

function normalizeProviderId(provider?: string | null): string {
  if (!provider) {
    return "";
  }
  const normalized = normalizeLowercaseStringOrEmpty(provider);
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

function formatSessionOptionLabel(
  value: string,
  context: "thinking" | "fast" | "verbose" | "reasoning",
): string {
  if (!value) {
    return t("dashboard.sessions.options.inherit");
  }
  switch (value) {
    case "off":
      return context === "verbose"
        ? t("dashboard.sessions.options.offExplicit")
        : t("dashboard.sessions.options.off");
    case "on":
      return t("dashboard.sessions.options.on");
    case "full":
      return t("dashboard.sessions.options.full");
    case "stream":
      return t("dashboard.sessions.options.stream");
    case "minimal":
      return t("dashboard.sessions.options.minimal");
    case "low":
      return t("dashboard.sessions.options.low");
    case "medium":
      return t("dashboard.sessions.options.medium");
    case "high":
      return t("dashboard.sessions.options.high");
    case "xhigh":
      return t("dashboard.sessions.options.xhigh");
    default:
      return t("dashboard.sessions.options.custom", { value });
  }
}

function formatSessionKind(kind: string): string {
  switch (kind) {
    case "direct":
      return t("dashboard.sessions.kind.direct");
    case "group":
      return t("dashboard.sessions.kind.group");
    case "global":
      return t("dashboard.sessions.kind.global");
    case "unknown":
      return t("dashboard.sessions.kind.unknown");
    default:
      return kind;
  }
}

function formatCheckpointCount(count: number): string {
  if (count <= 0) {
    return t("dashboard.sessions.checkpoints.none");
  }
  return count === 1
    ? t("dashboard.sessions.checkpoints.single", { count: "1" })
    : t("dashboard.sessions.checkpoints.plural", { count: String(count) });
}

function formatRowCount(count: number): string {
  return count === 1
    ? t("dashboard.sessions.pagination.row", { count: String(count) })
    : t("dashboard.sessions.pagination.rows", { count: String(count) });
}

function filterRows(rows: GatewaySessionRow[], query: string): GatewaySessionRow[] {
  const q = normalizeLowercaseStringOrEmpty(query);
  if (!q) {
    return rows;
  }
  return rows.filter((row) => {
    const key = normalizeLowercaseStringOrEmpty(row.key);
    const label = normalizeLowercaseStringOrEmpty(row.label);
    const kind = normalizeLowercaseStringOrEmpty(row.kind);
    const displayName = normalizeLowercaseStringOrEmpty(row.displayName);
    return key.includes(q) || label.includes(q) || kind.includes(q) || displayName.includes(q);
  });
}

function sortRows(
  rows: GatewaySessionRow[],
  column: "key" | "kind" | "updated" | "tokens",
  dir: "asc" | "desc",
): GatewaySessionRow[] {
  const cmp = dir === "asc" ? 1 : -1;
  return [...rows].toSorted((a, b) => {
    let diff = 0;
    switch (column) {
      case "key":
        diff = (a.key ?? "").localeCompare(b.key ?? "");
        break;
      case "kind":
        diff = (a.kind ?? "").localeCompare(b.kind ?? "");
        break;
      case "updated": {
        const au = a.updatedAt ?? 0;
        const bu = b.updatedAt ?? 0;
        diff = au - bu;
        break;
      }
      case "tokens": {
        const at = a.totalTokens ?? a.inputTokens ?? a.outputTokens ?? 0;
        const bt = b.totalTokens ?? b.inputTokens ?? b.outputTokens ?? 0;
        diff = at - bt;
        break;
      }
    }
    return diff * cmp;
  });
}

function paginateRows<T>(rows: T[], page: number, pageSize: number): T[] {
  const start = page * pageSize;
  return rows.slice(start, start + pageSize);
}

function formatCheckpointReason(reason: SessionCompactionCheckpoint["reason"]): string {
  switch (reason) {
    case "manual":
      return t("dashboard.sessions.reasons.manual");
    case "auto-threshold":
      return t("dashboard.sessions.reasons.autoThreshold");
    case "overflow-retry":
      return t("dashboard.sessions.reasons.overflowRetry");
    case "timeout-retry":
      return t("dashboard.sessions.reasons.timeoutRetry");
    default:
      return reason;
  }
}

function formatCheckpointDelta(checkpoint: SessionCompactionCheckpoint): string {
  if (
    typeof checkpoint.tokensBefore === "number" &&
    typeof checkpoint.tokensAfter === "number" &&
    Number.isFinite(checkpoint.tokensBefore) &&
    Number.isFinite(checkpoint.tokensAfter)
  ) {
    return t("dashboard.sessions.checkpoints.delta", {
      before: checkpoint.tokensBefore.toLocaleString(),
      after: checkpoint.tokensAfter.toLocaleString(),
    });
  }
  if (typeof checkpoint.tokensBefore === "number" && Number.isFinite(checkpoint.tokensBefore)) {
    return t("dashboard.sessions.checkpoints.beforeOnly", {
      count: checkpoint.tokensBefore.toLocaleString(),
    });
  }
  return t("dashboard.sessions.checkpoints.deltaUnavailable");
}

export function renderSessions(props: SessionsProps) {
  const rawRows = props.result?.sessions ?? [];
  const filtered = filterRows(rawRows, props.searchQuery);
  const sorted = sortRows(filtered, props.sortColumn, props.sortDir);
  const totalRows = sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / props.pageSize));
  const page = Math.min(props.page, totalPages - 1);
  const paginated = paginateRows(sorted, page, props.pageSize);

  const sortHeader = (
    col: "key" | "kind" | "updated" | "tokens",
    label: string,
    extraClass = "",
  ) => {
    const isActive = props.sortColumn === col;
    const nextDir = isActive && props.sortDir === "asc" ? ("desc" as const) : ("asc" as const);
    return html`
      <th
        class=${extraClass}
        data-sortable
        data-sort-dir=${isActive ? props.sortDir : ""}
        @click=${() => props.onSortChange(col, isActive ? nextDir : "desc")}
      >
        ${label}
        <span class="data-table-sort-icon">${icons.arrowUpDown}</span>
      </th>
    `;
  };

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; margin-bottom: 12px;">
        <div>
          <div class="card-title">${t("dashboard.sessions.title")}</div>
          <div class="card-sub">
            ${props.result
              ? t("dashboard.sessions.store", { path: props.result.path })
              : t("dashboard.sessions.subtitle")}
          </div>
        </div>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? t("common.loading") : t("common.refresh")}
        </button>
      </div>

      <div class="filters" style="margin-bottom: 12px;">
        <label class="field-inline">
          <span>${t("dashboard.sessions.filters.active")}</span>
          <input
            style="width: 72px;"
            placeholder=${t("dashboard.sessions.filters.activePlaceholder")}
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
        <label class="field-inline">
          <span>${t("dashboard.sessions.filters.limit")}</span>
          <input
            style="width: 64px;"
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
        <label class="field-inline checkbox">
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
          <span>${t("dashboard.sessions.filters.global")}</span>
        </label>
        <label class="field-inline checkbox">
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
          <span>${t("dashboard.sessions.filters.unknown")}</span>
        </label>
      </div>

      ${props.error
        ? html`<div class="callout danger" style="margin-bottom: 12px;">${props.error}</div>`
        : nothing}

      <div class="data-table-wrapper">
        <div class="data-table-toolbar">
          <div class="data-table-search">
            <input
              type="text"
              placeholder=${t("dashboard.sessions.searchPlaceholder")}
              .value=${props.searchQuery}
              @input=${(e: Event) => props.onSearchChange((e.target as HTMLInputElement).value)}
            />
          </div>
        </div>

        ${props.selectedKeys.size > 0
          ? html`
              <div class="data-table-bulk-bar">
                <span>
                  ${t("dashboard.sessions.selectedCount", {
                    count: String(props.selectedKeys.size),
                  })}
                </span>
                <button class="btn btn--sm" @click=${props.onDeselectAll}>
                  ${t("common.unselect")}
                </button>
                <button
                  class="btn btn--sm danger"
                  ?disabled=${props.loading}
                  @click=${props.onDeleteSelected}
                >
                  ${icons.trash} ${t("dashboard.sessions.delete")}
                </button>
              </div>
            `
          : nothing}

        <div class="data-table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th class="data-table-checkbox-col">
                  ${paginated.length > 0
                    ? html`<input
                        type="checkbox"
                        .checked=${paginated.length > 0 &&
                        paginated.every((r) => props.selectedKeys.has(r.key))}
                        .indeterminate=${paginated.some((r) => props.selectedKeys.has(r.key)) &&
                        !paginated.every((r) => props.selectedKeys.has(r.key))}
                        @change=${() => {
                          const allSelected = paginated.every((r) => props.selectedKeys.has(r.key));
                          if (allSelected) {
                            props.onDeselectPage(paginated.map((r) => r.key));
                          } else {
                            props.onSelectPage(paginated.map((r) => r.key));
                          }
                        }}
                        aria-label=${t("dashboard.sessions.selectAllOnPage")}
                      />`
                    : nothing}
                </th>
                ${sortHeader("key", t("dashboard.sessions.columns.key"), "data-table-key-col")}
                <th>${t("dashboard.sessions.columns.label")}</th>
                ${sortHeader("kind", t("dashboard.sessions.columns.kind"))}
                ${sortHeader("updated", t("dashboard.sessions.columns.updated"))}
                ${sortHeader("tokens", t("dashboard.sessions.columns.tokens"))}
                <th>${t("dashboard.sessions.columns.compaction")}</th>
                <th>${t("dashboard.sessions.columns.thinking")}</th>
                <th>${t("dashboard.sessions.columns.fast")}</th>
                <th>${t("dashboard.sessions.columns.verbose")}</th>
                <th>${t("dashboard.sessions.columns.reasoning")}</th>
              </tr>
            </thead>
            <tbody>
              ${paginated.length === 0
                ? html`
                    <tr>
                      <td
                        colspan="11"
                        style="text-align: center; padding: 48px 16px; color: var(--muted)"
                      >
                        ${t("dashboard.sessions.empty")}
                      </td>
                    </tr>
                  `
                : paginated.flatMap((row) => renderRows(row, props))}
            </tbody>
          </table>
        </div>

        ${totalRows > 0
          ? html`
              <div class="data-table-pagination">
                <div class="data-table-pagination__info">
                  ${page * props.pageSize + 1}-${Math.min((page + 1) * props.pageSize, totalRows)}
                  ${t("dashboard.sessions.pagination.of")} ${formatRowCount(totalRows)}
                </div>
                <div class="data-table-pagination__controls">
                  <select
                    style="height: 32px; padding: 0 8px; font-size: 13px; border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--card);"
                    .value=${String(props.pageSize)}
                    @change=${(e: Event) =>
                      props.onPageSizeChange(Number((e.target as HTMLSelectElement).value))}
                  >
                    ${PAGE_SIZES.map(
                      (s) =>
                        html`<option value=${s}>
                          ${t("dashboard.sessions.pagination.perPage", { count: String(s) })}
                        </option>`,
                    )}
                  </select>
                  <button ?disabled=${page <= 0} @click=${() => props.onPageChange(page - 1)}>
                    ${t("dashboard.sessions.pagination.previous")}
                  </button>
                  <button
                    ?disabled=${page >= totalPages - 1}
                    @click=${() => props.onPageChange(page + 1)}
                  >
                    ${t("dashboard.sessions.pagination.next")}
                  </button>
                </div>
              </div>
            `
          : nothing}
      </div>
    </section>
  `;
}

function renderRows(row: GatewaySessionRow, props: SessionsProps) {
  const updated = row.updatedAt ? formatRelativeTimestamp(row.updatedAt) : t("common.na");
  const rawThinking = row.thinkingLevel ?? "";
  const isBinaryThinking = isBinaryThinkingProvider(row.modelProvider);
  const thinking = resolveThinkLevelDisplay(rawThinking, isBinaryThinking);
  const thinkLevels = withCurrentOption(resolveThinkLevelOptions(row.modelProvider), thinking);
  const fastMode = row.fastMode === true ? "on" : row.fastMode === false ? "off" : "";
  const fastLevels = withCurrentOption(FAST_LEVELS, fastMode);
  const verbose = row.verboseLevel ?? "";
  const verboseLevels = withCurrentOption(VERBOSE_LEVELS, verbose);
  const reasoning = row.reasoningLevel ?? "";
  const reasoningLevels = withCurrentOption(REASONING_LEVELS, reasoning);
  const latestCheckpoint = row.latestCompactionCheckpoint;
  const checkpointCount = row.compactionCheckpointCount ?? 0;
  const isExpanded = props.expandedCheckpointKey === row.key;
  const checkpointItems = props.checkpointItemsByKey[row.key] ?? [];
  const checkpointError = props.checkpointErrorByKey[row.key];
  const displayName = normalizeOptionalString(row.displayName) ?? null;
  const trimmedLabel = normalizeOptionalString(row.label) ?? "";
  const showDisplayName = Boolean(
    displayName && displayName !== row.key && displayName !== trimmedLabel,
  );
  const canLink = row.kind !== "global";
  const chatUrl = canLink
    ? `${pathForTab("chat", props.basePath)}?session=${encodeURIComponent(row.key)}`
    : null;
  const badgeClass =
    row.kind === "direct"
      ? "data-table-badge--direct"
      : row.kind === "group"
        ? "data-table-badge--group"
        : row.kind === "global"
          ? "data-table-badge--global"
          : "data-table-badge--unknown";

  return [
    html`<tr>
      <td class="data-table-checkbox-col">
        <input
          type="checkbox"
          .checked=${props.selectedKeys.has(row.key)}
          @change=${() => props.onToggleSelect(row.key)}
          aria-label=${t("dashboard.sessions.selectSession")}
        />
      </td>
      <td class="data-table-key-col">
        <div class="mono session-key-cell">
          ${canLink
            ? html`<a
                href=${chatUrl}
                class="session-link"
                @click=${(e: MouseEvent) => {
                  if (
                    e.defaultPrevented ||
                    e.button !== 0 ||
                    e.metaKey ||
                    e.ctrlKey ||
                    e.shiftKey ||
                    e.altKey
                  ) {
                    return;
                  }
                  if (props.onNavigateToChat) {
                    e.preventDefault();
                    props.onNavigateToChat(row.key);
                  }
                }}
                >${row.key}</a
              >`
            : row.key}
          ${showDisplayName
            ? html`<span class="muted session-key-display-name">${displayName}</span>`
            : nothing}
        </div>
      </td>
      <td>
        <input
          .value=${row.label ?? ""}
          ?disabled=${props.loading}
          placeholder=${t("dashboard.sessions.labelPlaceholder")}
          style="width: 100%; max-width: 140px; padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm);"
          @change=${(e: Event) => {
            const value = normalizeOptionalString((e.target as HTMLInputElement).value) ?? null;
            props.onPatch(row.key, { label: value });
          }}
        />
      </td>
      <td>
        <span class="data-table-badge ${badgeClass}">${formatSessionKind(row.kind)}</span>
      </td>
      <td>${updated}</td>
      <td>${formatSessionTokens(row)}</td>
      <td>
        <div style="display: grid; gap: 6px;">
          <span class="muted" style="font-size: 12px;">
            ${formatCheckpointCount(checkpointCount)}
          </span>
          ${latestCheckpoint
            ? html`
                <span style="font-size: 12px;">
                  ${formatCheckpointReason(latestCheckpoint.reason)} ·
                  ${formatRelativeTimestamp(latestCheckpoint.createdAt)}
                </span>
              `
            : nothing}
          <button
            class="btn btn--sm"
            ?disabled=${props.checkpointLoadingKey === row.key}
            @click=${() => props.onToggleCheckpointDetails(row.key)}
          >
            ${isExpanded
              ? t("dashboard.sessions.checkpoints.hide")
              : t("dashboard.sessions.checkpoints.show")}
          </button>
        </div>
      </td>
      <td>
        <select
          ?disabled=${props.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            props.onPatch(row.key, {
              thinkingLevel: resolveThinkLevelPatchValue(value, isBinaryThinking),
            });
          }}
        >
          ${thinkLevels.map(
            (level) =>
              html`<option value=${level} ?selected=${thinking === level}>
                ${formatSessionOptionLabel(level, "thinking")}
              </option>`,
          )}
        </select>
      </td>
      <td>
        <select
          ?disabled=${props.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            props.onPatch(row.key, { fastMode: value === "" ? null : value === "on" });
          }}
        >
          ${fastLevels.map(
            (level) =>
              html`<option value=${level} ?selected=${fastMode === level}>
                ${formatSessionOptionLabel(level, "fast")}
              </option>`,
          )}
        </select>
      </td>
      <td>
        <select
          ?disabled=${props.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            props.onPatch(row.key, { verboseLevel: value || null });
          }}
        >
          ${verboseLevels.map(
            (level) =>
              html`<option value=${level} ?selected=${verbose === level}>
                ${formatSessionOptionLabel(level, "verbose")}
              </option>`,
          )}
        </select>
      </td>
      <td>
        <select
          ?disabled=${props.loading}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            props.onPatch(row.key, { reasoningLevel: value || null });
          }}
        >
          ${reasoningLevels.map(
            (level) =>
              html`<option value=${level} ?selected=${reasoning === level}>
                ${formatSessionOptionLabel(level, "reasoning")}
              </option>`,
          )}
        </select>
      </td>
    </tr>`,
    ...(isExpanded
      ? [
          html`<tr>
            <td colspan="11" style="padding: 0;">
              <div
                style="padding: 14px 16px; border-top: 1px solid var(--border); background: var(--surface-2, rgba(127, 127, 127, 0.05));"
              >
                ${props.checkpointLoadingKey === row.key
                  ? html`<div class="muted">${t("dashboard.sessions.checkpoints.loading")}</div>`
                  : checkpointError
                    ? html`<div class="callout danger">${checkpointError}</div>`
                    : checkpointItems.length === 0
                      ? html`
                          <div class="muted">
                            ${t("dashboard.sessions.checkpoints.noneRecorded")}
                          </div>
                        `
                      : html`
                          <div style="display: grid; gap: 10px;">
                            ${checkpointItems.map(
                              (checkpoint) => html`
                                <div
                                  style="border: 1px solid var(--border); border-radius: var(--radius-md); padding: 12px; display: grid; gap: 8px;"
                                >
                                  <div
                                    style="display: flex; gap: 8px; justify-content: space-between; align-items: center; flex-wrap: wrap;"
                                  >
                                    <strong>
                                      ${formatCheckpointReason(checkpoint.reason)} ·
                                      ${formatRelativeTimestamp(checkpoint.createdAt)}
                                    </strong>
                                    <span class="muted" style="font-size: 12px;">
                                      ${formatCheckpointDelta(checkpoint)}
                                    </span>
                                  </div>
                                  ${checkpoint.summary
                                    ? html`<div style="white-space: pre-wrap;">
                                        ${checkpoint.summary}
                                      </div>`
                                    : html`
                                        <div class="muted">
                                          ${t("dashboard.sessions.checkpoints.noSummary")}
                                        </div>
                                      `}
                                  <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                                    <button
                                      class="btn btn--sm"
                                      ?disabled=${props.checkpointBusyKey ===
                                      checkpoint.checkpointId}
                                      @click=${() =>
                                        props.onBranchFromCheckpoint(
                                          row.key,
                                          checkpoint.checkpointId,
                                        )}
                                    >
                                      ${t("dashboard.sessions.checkpoints.branch")}
                                    </button>
                                    <button
                                      class="btn btn--sm"
                                      ?disabled=${props.checkpointBusyKey ===
                                      checkpoint.checkpointId}
                                      @click=${() =>
                                        props.onRestoreCheckpoint(row.key, checkpoint.checkpointId)}
                                    >
                                      ${t("dashboard.sessions.checkpoints.restore")}
                                    </button>
                                  </div>
                                </div>
                              `,
                            )}
                          </div>
                        `}
              </div>
            </td>
          </tr>`,
        ]
      : []),
  ];
}
