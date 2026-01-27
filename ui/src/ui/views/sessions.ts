import { html, nothing } from "lit";

import { toast } from "../components/toast";
import { skeleton } from "../components/design-utils";
import { formatAgo } from "../format";
import { formatSessionTokens } from "../presenter";
import { hrefForTab } from "../navigation";
import { icon } from "../icons";
import { inferSessionType } from "../session-meta";
import type { GatewaySessionRow, SessionsListResult, SessionsPreviewEntry } from "../types";

export type SessionActiveTask = {
  taskId: string;
  taskName: string;
  status: "in-progress" | "pending";
  startedAt?: number;
};

export type SessionStatus = "active" | "idle" | "completed";
export type SessionSortColumn = "name" | "updated" | "tokens" | "status" | "kind";
export type SessionSortDir = "asc" | "desc";
export type SessionKindFilter = "all" | "direct" | "group" | "global" | "unknown";
export type SessionStatusFilter = "all" | "active" | "idle" | "completed";
export type SessionLaneFilter = "all" | "cron" | "regular";
export type SessionViewMode = "list" | "table";

const UNLABELED_AGENT_KEY = "__unlabeled__";

function isSubagentSessionKey(key: string): boolean {
  const trimmed = key.trim();
  return trimmed.startsWith("subagent:") || trimmed.includes(":subagent:");
}

function parseAgentIdFromSessionKey(key: string): string | null {
  const trimmed = key.trim();
  if (!trimmed.startsWith("agent:")) return null;
  const rest = trimmed.slice("agent:".length);
  const idx = rest.indexOf(":");
  if (idx <= 0) return null;
  const agentId = rest.slice(0, idx).trim();
  return agentId || null;
}

function resolveAgentDisplayName(row: GatewaySessionRow): string {
  const label = row.label?.trim();
  if (label) return label;
  const agentId = parseAgentIdFromSessionKey(row.key);
  if (agentId) return agentId;
  if (row.kind === "global") return "Global";
  if (row.kind === "unknown") return "Unknown";
  return "Unlabeled";
}

function normalizeAgentLabelKey(label?: string | null): string {
  const trimmed = (label ?? "").trim();
  return trimmed ? trimmed : UNLABELED_AGENT_KEY;
}

function displayAgentLabelKey(key: string): string {
  return key === UNLABELED_AGENT_KEY ? "Unlabeled" : key;
}

function resolveAgentLabelFilterDisplay(filterValue: string, rows: GatewaySessionRow[]): string {
  const normalized = filterValue.trim().toLowerCase();
  if (!normalized) return "";
  const match = rows.find(
    (row) => normalizeAgentLabelKey(row.label).toLowerCase() === normalized,
  );
  if (match) return displayAgentLabelKey(normalizeAgentLabelKey(match.label));
  return displayAgentLabelKey(normalized);
}

export type SessionsProps = {
  loading: boolean;
  result: SessionsListResult | null;
  error: string | null;
  activeMinutes: string;
  limit: string;
  includeGlobal: boolean;
  includeUnknown: boolean;
  basePath: string;
  search: string;
  sort: SessionSortColumn;
  sortDir: SessionSortDir;
  kindFilter: SessionKindFilter;
  statusFilter: SessionStatusFilter;
  agentLabelFilter: string;
  laneFilter: SessionLaneFilter;
  tagFilter: string[];
  viewMode: SessionViewMode;
  showHidden: boolean;
  autoHideCompletedMinutes: number;
  autoHideErroredMinutes: number;
  drawerKey: string | null;
  drawerExpanded: boolean;
  drawerPreviewLoading: boolean;
  drawerPreviewError: string | null;
  drawerPreview: SessionsPreviewEntry | null;
  onDrawerOpen: (key: string) => void;
  onDrawerOpenExpanded: (key: string) => void;
  onDrawerClose: () => void;
  onDrawerToggleExpanded: () => void;
  onDrawerRefreshPreview: () => void;
  // Active tasks per session (for showing task indicators)
  activeTasks?: Map<string, SessionActiveTask[]>;
  onSessionOpen?: (key: string) => void;
  onFiltersChange: (next: {
    activeMinutes: string;
    limit: string;
    includeGlobal: boolean;
    includeUnknown: boolean;
  }) => void;
  onSearchChange: (search: string) => void;
  onSortChange: (column: SessionSortColumn) => void;
  onKindFilterChange: (kind: SessionKindFilter) => void;
  onStatusFilterChange: (status: SessionStatusFilter) => void;
  onAgentLabelFilterChange: (label: string) => void;
  onTagFilterChange: (tags: string[]) => void;
  onLaneFilterChange: (lane: SessionLaneFilter) => void;
  onViewModeChange: (mode: SessionViewMode) => void;
  onShowHiddenChange: (show: boolean) => void;
  onAutoHideChange: (next: { completedMinutes: number; erroredMinutes: number }) => void;
  onDeleteMany: (keys: string[]) => void;
  onRefresh: () => void;
  onPatch: (
    key: string,
    patch: {
      label?: string | null;
      tags?: string[] | null;
      thinkingLevel?: string | null;
      verboseLevel?: string | null;
      reasoningLevel?: string | null;
    },
  ) => void;
  onDelete: (key: string) => void;
  onViewSessionLogs?: (key: string) => void;
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

const SESSIONS_NAME_COLUMN_WIDTH_STORAGE_KEY =
  "clawdbot.control.ui.sessions.nameColumnWidth.v1";

function readSessionsNameColumnWidth(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SESSIONS_NAME_COLUMN_WIDTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    return Math.min(900, Math.max(220, parsed));
  } catch {
    return null;
  }
}

function persistSessionsNameColumnWidth(value: number | null) {
  if (typeof window === "undefined") return;
  try {
    if (value == null) {
      window.localStorage.removeItem(SESSIONS_NAME_COLUMN_WIDTH_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(SESSIONS_NAME_COLUMN_WIDTH_STORAGE_KEY, String(value));
  } catch {
    // Ignore storage errors
  }
}

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

function resolveSessionDefaults(
  defaults: SessionsListResult["defaults"] | null,
): {
  modelProvider: string | null;
  model: string | null;
  contextTokens: number | null;
  thinkingDefault: string;
  verboseDefault: string;
  reasoningDefault: string;
  elevatedDefault: string;
} {
  return {
    modelProvider: defaults?.modelProvider ?? null,
    model: defaults?.model ?? null,
    contextTokens: defaults?.contextTokens ?? null,
    thinkingDefault: defaults?.thinkingDefault ?? "off",
    verboseDefault: defaults?.verboseDefault ?? "off",
    reasoningDefault: defaults?.reasoningDefault ?? "off",
    elevatedDefault: defaults?.elevatedDefault ?? "off",
  };
}

function resolveEffectiveStringSetting(params: {
  override?: string | null;
  defaultValue: string;
}): { effective: string; source: "override" | "default" } {
  const override = typeof params.override === "string" ? params.override.trim() : "";
  if (override) return { effective: override, source: "override" };
  return { effective: params.defaultValue, source: "default" };
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

const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const IDLE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

function deriveSessionStatus(row: GatewaySessionRow, activeTasks?: SessionActiveTask[]): SessionStatus {
  if (activeTasks && activeTasks.length > 0) return "active";
  if (!row.updatedAt) return "completed";
  const age = Date.now() - row.updatedAt;
  if (age < ACTIVE_THRESHOLD_MS) return "active";
  if (age < IDLE_THRESHOLD_MS) return "idle";
  return "completed";
}

function getStatusBadgeClass(status: SessionStatus): string {
  switch (status) {
    case "active":
      return "badge--success badge--animated";
    case "idle":
      return "badge--warning";
    case "completed":
      return "badge--muted";
  }
}

function shouldAutoHideSession(params: {
  row: GatewaySessionRow;
  now: number;
  activeTasks: SessionActiveTask[];
  autoHideCompletedMinutes: number;
  autoHideErroredMinutes: number;
}): boolean {
  const { row, now, activeTasks, autoHideCompletedMinutes, autoHideErroredMinutes } = params;
  if (!row.updatedAt) return false;
  if (activeTasks.some((t) => t.status === "in-progress")) return false;

  const ageMs = Math.max(0, now - row.updatedAt);
  if (row.abortedLastRun && autoHideErroredMinutes > 0) {
    return ageMs >= autoHideErroredMinutes * 60_000;
  }
  if (deriveSessionStatus(row, activeTasks) === "completed" && autoHideCompletedMinutes > 0) {
    return ageMs >= autoHideCompletedMinutes * 60_000;
  }
  return false;
}

function matchesSearch(row: GatewaySessionRow, search: string): boolean {
  if (!search) return true;
  const lower = search.toLowerCase();
  const searchable = [
    row.key,
    row.displayName,
    row.label,
    ...(Array.isArray(row.tags) ? row.tags : []),
    row.channel,
    row.subject,
    row.sessionId,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return searchable.includes(lower);
}

function normalizeTagLabel(raw?: string | null): string {
  return (raw ?? "").trim().replace(/\s+/g, " ");
}

function normalizeTagKey(raw?: string | null): string {
  return normalizeTagLabel(raw).toLowerCase();
}

function filterSessionsTags(
  rows: GatewaySessionRow[],
  selected: string[],
): GatewaySessionRow[] {
  const selectedKeys = selected.map((t) => normalizeTagKey(t)).filter(Boolean);
  if (selectedKeys.length === 0) return rows;
  return rows.filter((row) => {
    const tags = Array.isArray(row.tags) ? row.tags : [];
    const tagKeys = new Set(tags.map((t) => normalizeTagKey(t)).filter(Boolean));
    for (const key of selectedKeys) {
      if (!tagKeys.has(key)) return false;
    }
    return true;
  });
}

function countSessionStatuses(
  rows: GatewaySessionRow[],
  activeTasksByKey?: Map<string, SessionActiveTask[]>,
): {
  total: number;
  active: number;
  idle: number;
  completed: number;
} {
  let total = 0;
  let active = 0;
  let idle = 0;
  let completed = 0;
  for (const row of rows) {
    total += 1;
    const status = deriveSessionStatus(row, activeTasksByKey?.get(row.key));
    if (status === "active") active += 1;
    else if (status === "idle") idle += 1;
    else completed += 1;
  }
  return { total, active, idle, completed };
}

function filterSessionsBaseIgnoringStatus(
  rows: GatewaySessionRow[],
  props: SessionsProps,
): GatewaySessionRow[] {
  const agentFilterLower = props.agentLabelFilter.trim().toLowerCase();
  return rows.filter((row) => {
    if (!matchesSearch(row, props.search)) return false;
    if (props.kindFilter !== "all" && row.kind !== props.kindFilter) return false;
    if (agentFilterLower) {
      const key = normalizeAgentLabelKey(row.label).toLowerCase();
      if (key !== agentFilterLower) return false;
    }
    return true;
  });
}

function filterSessionsLane(
  rows: GatewaySessionRow[],
  props: SessionsProps,
): GatewaySessionRow[] {
  if (props.laneFilter === "all") return rows;
  return rows.filter((row) => inferSessionType(row.key) === props.laneFilter);
}

function sortSessions(
  rows: GatewaySessionRow[],
  sort: SessionSortColumn,
  sortDir: SessionSortDir,
  activeTasksByKey?: Map<string, SessionActiveTask[]>,
): GatewaySessionRow[] {
  const sorted = [...rows];
  const dir = sortDir === "asc" ? 1 : -1;
  sorted.sort((a, b) => {
    switch (sort) {
      case "name": {
        const nameA = (a.displayName ?? a.label ?? a.key).toLowerCase();
        const nameB = (b.displayName ?? b.label ?? b.key).toLowerCase();
        return nameA.localeCompare(nameB) * dir;
      }
      case "updated": {
        const timeA = a.updatedAt ?? 0;
        const timeB = b.updatedAt ?? 0;
        return (timeA - timeB) * dir;
      }
      case "tokens": {
        const tokensA = a.totalTokens ?? 0;
        const tokensB = b.totalTokens ?? 0;
        return (tokensA - tokensB) * dir;
      }
      case "status": {
        const statusOrder = { active: 0, idle: 1, completed: 2 };
        const statusA = statusOrder[deriveSessionStatus(a, activeTasksByKey?.get(a.key))];
        const statusB = statusOrder[deriveSessionStatus(b, activeTasksByKey?.get(b.key))];
        return (statusA - statusB) * dir;
      }
      case "kind": {
        const kindOrder = { direct: 0, group: 1, global: 2, unknown: 3 };
        const kindA = kindOrder[a.kind] ?? 4;
        const kindB = kindOrder[b.kind] ?? 4;
        return (kindA - kindB) * dir;
      }
      default:
        return 0;
    }
  });
  return sorted;
}

function countSessionTypes(rows: GatewaySessionRow[]): { total: number; cron: number; regular: number } {
  let total = 0;
  let cron = 0;
  let regular = 0;
  for (const row of rows) {
    total += 1;
    if (inferSessionType(row.key) === "cron") cron += 1;
    else regular += 1;
  }
  return { total, cron, regular };
}

function renderSessionsSkeleton() {
  return html`
    ${[1, 2, 3, 4, 5].map(
      (i) => html`
        <div class="data-table__row" style="animation: view-fade-in 0.2s ease-out; animation-delay: ${i * 50}ms; animation-fill-mode: backwards;">
          <div class="data-table__cell">${skeleton({ width: "220px", height: "20px" })}</div>
          <div class="data-table__cell">${skeleton({ width: "220px", height: "20px" })}</div>
          <div class="data-table__cell">${skeleton({ width: "180px", height: "20px" })}</div>
          <div class="data-table__cell">${skeleton({ width: "90px", height: "28px" })}</div>
        </div>
      `,
    )}
  `;
}

function renderSessionsListSkeleton() {
  return html`
    ${[1, 2, 3, 4, 5, 6].map(
      (i) => html`
        <div
          class="sessions-list-item"
          style="animation: view-fade-in 0.2s ease-out; animation-delay: ${i * 40}ms; animation-fill-mode: backwards;"
        >
          <div class="sessions-list-item__main">
            <div class="sessions-list-item__title-row">
              <div class="sessions-list-item__title">
                ${skeleton({ width: `${240 - i * 8}px`, height: "16px" })}
              </div>
              <div class="sessions-list-item__badges">
                ${skeleton({ width: "64px", height: "22px" })}
              </div>
            </div>
            <div class="sessions-list-item__subtitle">
              ${skeleton({ width: "220px", height: "12px" })}
            </div>
          </div>
          <div class="sessions-list-item__right">
            ${skeleton({ width: "90px", height: "12px" })}
            <div class="sessions-list-item__stats">${skeleton({ width: "120px", height: "22px" })}</div>
          </div>
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

function renderSortIcon(column: SessionSortColumn, props: SessionsProps) {
  if (props.sort !== column) {
    return html`<span class="sort-icon sort-icon--inactive">${icon("chevrons-down", { size: 12 })}</span>`;
  }
  return html`<span class="sort-icon sort-icon--active"
    >${icon("chevron-down", {
      size: 12,
      class: props.sortDir === "asc" ? "sort-icon__dir sort-icon__dir--asc" : "sort-icon__dir",
    })}</span
  >`;
}

export function renderSessions(props: SessionsProps) {
  const allRows = props.result?.sessions ?? [];
  const now = Date.now();
  const hiddenKeys = new Set<string>();
  const visibleRows: GatewaySessionRow[] = [];
  for (const row of allRows) {
    const activeTasks = props.activeTasks?.get(row.key) ?? [];
    if (
      shouldAutoHideSession({
        row,
        now,
        activeTasks,
        autoHideCompletedMinutes: props.autoHideCompletedMinutes,
        autoHideErroredMinutes: props.autoHideErroredMinutes,
      })
    ) {
      hiddenKeys.add(row.key);
    } else {
      visibleRows.push(row);
    }
  }
  const hiddenCount = hiddenKeys.size;
  const displayRows = props.showHidden ? allRows : visibleRows;
  const defaults = props.result?.defaults ?? null;
  const resolvedDefaults = resolveSessionDefaults(defaults);
  const baseRowsIgnoringStatus = filterSessionsBaseIgnoringStatus(displayRows, props);
  const baseRowsIgnoringStatusWithTags = filterSessionsTags(
    baseRowsIgnoringStatus,
    props.tagFilter,
  );
  const laneCounts = countSessionTypes(baseRowsIgnoringStatusWithTags);
  const laneFilteredRowsIgnoringStatus = filterSessionsLane(baseRowsIgnoringStatusWithTags, props);
  const statusCounts = countSessionStatuses(laneFilteredRowsIgnoringStatus, props.activeTasks);
  const statusFilteredRows =
    props.statusFilter === "all"
      ? laneFilteredRowsIgnoringStatus
      : laneFilteredRowsIgnoringStatus.filter(
          (row) =>
            deriveSessionStatus(row, props.activeTasks?.get(row.key)) === props.statusFilter,
        );
  const rows = sortSessions(statusFilteredRows, props.sort, props.sortDir, props.activeTasks);
  const drawerSession = props.drawerKey
    ? allRows.find((row) => row.key === props.drawerKey) ?? null
    : null;
  const fetchedCount = allRows.length;
  const totalCount = displayRows.length;
  const filteredCount = statusFilteredRows.length;
  const tagCountsSource = baseRowsIgnoringStatus;
  const tagCounts = (() => {
    const map = new Map<string, { label: string; count: number }>();
    for (const row of tagCountsSource) {
      const tags = Array.isArray(row.tags) ? row.tags : [];
      for (const raw of tags) {
        const label = normalizeTagLabel(raw);
        if (!label) continue;
        const key = normalizeTagKey(label);
        const existing = map.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          map.set(key, { label, count: 1 });
        }
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  })();
  const hasFilters =
    props.search ||
    props.kindFilter !== "all" ||
    props.statusFilter !== "all" ||
    props.laneFilter !== "all" ||
    Boolean(props.agentLabelFilter.trim()) ||
    (Array.isArray(props.tagFilter) && props.tagFilter.length > 0);
  const persistedNameColWidth = readSessionsNameColumnWidth();
  const sessionsTableStyle = persistedNameColWidth
    ? `--sessions-col-name: ${persistedNameColWidth}px;`
    : "";

  const selectedTagKeys = new Set(
    (Array.isArray(props.tagFilter) ? props.tagFilter : [])
      .map((t) => normalizeTagKey(t))
      .filter(Boolean),
  );

  const toggleTagFilter = (raw: string) => {
    const label = normalizeTagLabel(raw);
    const key = normalizeTagKey(label);
    if (!key) return;
    const current = Array.isArray(props.tagFilter) ? props.tagFilter : [];
    const exists = current.some((t) => normalizeTagKey(t) === key);
    if (exists) {
      props.onTagFilterChange(current.filter((t) => normalizeTagKey(t) !== key));
      return;
    }
    const canonicalLabel = tagCounts.find((t) => normalizeTagKey(t.label) === key)?.label ?? label;
    props.onTagFilterChange([...current, canonicalLabel]);
  };

  const activeFilterChips: Array<{ label: string; onClear: () => void }> = [];
  if (props.search) {
    activeFilterChips.push({
      label: `Search: ${props.search}`,
      onClear: () => props.onSearchChange(""),
    });
  }
  if (props.statusFilter !== "all") {
    activeFilterChips.push({
      label: `Status: ${props.statusFilter}`,
      onClear: () => props.onStatusFilterChange("all"),
    });
  }
  if (props.laneFilter !== "all") {
    activeFilterChips.push({
      label: `Lane: ${props.laneFilter}`,
      onClear: () => props.onLaneFilterChange("all"),
    });
  }
  if (props.kindFilter !== "all") {
    activeFilterChips.push({
      label: `Kind: ${props.kindFilter}`,
      onClear: () => props.onKindFilterChange("all"),
    });
  }
  if (props.agentLabelFilter.trim()) {
    activeFilterChips.push({
      label: `Agent: ${resolveAgentLabelFilterDisplay(props.agentLabelFilter, allRows)}`,
      onClear: () => props.onAgentLabelFilterChange(""),
    });
  }
  if (Array.isArray(props.tagFilter) && props.tagFilter.length > 0) {
    for (const tag of props.tagFilter) {
      const label = normalizeTagLabel(tag);
      if (!label) continue;
      activeFilterChips.push({
        label: `Tag: ${label}`,
        onClear: () => {
          const key = normalizeTagKey(label);
          props.onTagFilterChange(
            props.tagFilter.filter((t) => normalizeTagKey(t) !== key),
          );
        },
      });
    }
  }

  const clearAllFilters = () => {
    props.onSearchChange("");
    props.onKindFilterChange("all");
    props.onStatusFilterChange("all");
    props.onAgentLabelFilterChange("");
    props.onLaneFilterChange("all");
    props.onTagFilterChange([]);
  };

  const startResizeNameColumn = (event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget as HTMLElement | null;
    const table = handle?.closest(".sessions-table") as HTMLElement | null;
    const headerCell = handle?.closest(".data-table__header-cell") as HTMLElement | null;
    if (!table || !headerCell) return;

    const startX = event.clientX;
    const startWidth = headerCell.getBoundingClientRect().width;
    const minWidth = 220;
    const maxWidth = 900;
    let lastWidth = startWidth;

    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - startX;
      const next = Math.min(maxWidth, Math.max(minWidth, Math.round(startWidth + dx)));
      lastWidth = next;
      table.style.setProperty("--sessions-col-name", `${next}px`);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      persistSessionsNameColumnWidth(lastWidth);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const resetNameColumnWidth = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget as HTMLElement | null;
    const table = handle?.closest(".sessions-table") as HTMLElement | null;
    if (table) table.style.removeProperty("--sessions-col-name");
    persistSessionsNameColumnWidth(null);
  };

  return html`
    <section class="card">
      <!-- Modern Table Header Card -->
      <div class="table-header-card">
        <div class="table-header-card__left">
          <div class="table-header-card__icon">
            ${icon("file-text", { size: 22 })}
          </div>
          <div class="table-header-card__info">
            <div class="table-header-card__title">Sessions</div>
            <div class="table-header-card__subtitle">
              ${hasFilters
                ? `${filteredCount} of ${totalCount} shown`
                : `${totalCount} shown`}
              ${fetchedCount !== totalCount ? html` <span class="muted">(of ${fetchedCount} fetched)</span>` : nothing}
              ${hiddenCount > 0
                ? props.showHidden
                  ? html` <span class="muted">(incl. ${hiddenCount} hidden)</span>`
                  : html` <span class="muted">(${hiddenCount} hidden)</span>`
                : nothing}
            </div>
          </div>
        </div>
        <div class="table-header-card__right">
          <button class="btn btn--secondary" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${icon("refresh-cw", { size: 14 })}
            <span>${props.loading ? "Loading..." : "Refresh"}</span>
          </button>
        </div>
      </div>

      <div class="sessions-dashboard">
        <div class="sessions-dashboard__grid">
          <aside class="sessions-dashboard__filters">
            <div class="sessions-filters-pane">
              <div class="sessions-filters-pane__section">
                <div class="sessions-filters-pane__section-title">Search</div>
                <div class="field--modern table-filters__search" style="position: relative;">
          <div class="field__input-wrapper ${props.search ? "field__input-wrapper--has-clear" : ""}">
            <span class="field__icon">${icon("search", { size: 14 })}</span>
            <input
              class="field__input"
              type="text"
                      placeholder="Name, key, channel, subject..."
                      .value=${props.search}
                      @input=${(e: Event) =>
                        props.onSearchChange((e.target as HTMLInputElement).value)}
                    />
                    ${props.search
                      ? html`
                        <button
                          class="field__clear"
                          title="Clear search"
                          @click=${() => props.onSearchChange("")}
                        >
                          ${icon("x", { size: 12 })}
                        </button>
                      `
                      : nothing}
                  </div>
                </div>
	              </div>

	              <details class="sessions-filters-pane__details">
	                <summary class="sessions-filters-pane__details-summary">
	                  ${icon("inbox", { size: 14 })}
	                  <span>Display</span>
	                </summary>
	                <div class="sessions-filters-pane__details-body">
	                  <div class="field--modern">
	                    <label class="field__label">Auto-hide completed after (minutes)</label>
	                    <input
	                      class="field__input"
	                      type="number"
	                      min="0"
	                      step="5"
	                      inputmode="numeric"
	                      .value=${String(props.autoHideCompletedMinutes)}
	                      @input=${(e: Event) => {
	                        const completedMinutes = Math.max(
	                          0,
	                          Math.min(
	                            10_080,
	                            Math.floor(Number((e.target as HTMLInputElement).value) || 0),
	                          ),
	                        );
	                        props.onAutoHideChange({
	                          completedMinutes,
	                          erroredMinutes: props.autoHideErroredMinutes,
	                        });
	                      }}
	                    />
	                    <div class="muted" style="font-size: 11px;">0 = never</div>
	                  </div>
	                  <div class="field--modern">
	                    <label class="field__label">Auto-hide errored after (minutes)</label>
	                    <input
	                      class="field__input"
	                      type="number"
	                      min="0"
	                      step="5"
	                      inputmode="numeric"
	                      .value=${String(props.autoHideErroredMinutes)}
	                      @input=${(e: Event) => {
	                        const erroredMinutes = Math.max(
	                          0,
	                          Math.min(
	                            10_080,
	                            Math.floor(Number((e.target as HTMLInputElement).value) || 0),
	                          ),
	                        );
	                        props.onAutoHideChange({
	                          completedMinutes: props.autoHideCompletedMinutes,
	                          erroredMinutes,
	                        });
	                      }}
	                    />
	                    <div class="muted" style="font-size: 11px;">0 = never</div>
	                  </div>
	                  <label class="table-filters__toggle ${props.showHidden ? "table-filters__toggle--active" : ""}">
	                    <input
	                      type="checkbox"
	                      .checked=${props.showHidden}
	                      @change=${(e: Event) =>
	                        props.onShowHiddenChange((e.target as HTMLInputElement).checked)}
	                    />
	                    <span>Show hidden</span>
	                    ${hiddenCount > 0 ? html`<span class="muted">(${hiddenCount})</span>` : nothing}
	                  </label>
	                </div>
	              </details>

	              <div class="sessions-filters-pane__section">
	                <div class="sessions-filters-pane__section-title">Slices</div>
	                <div class="sessions-slices">
                  <div class="sessions-slices__group">
                    <div class="sessions-slices__label">Status</div>
                    <div class="chip-row sessions-slices__chips">
                      <button
                        class="chip ${props.statusFilter === "all" ? "chip--accent" : ""}"
                        type="button"
                        title="Show all statuses"
                        @click=${() => props.onStatusFilterChange("all")}
                      >
                        All ${statusCounts.total}
                      </button>
                      <button
                        class="chip ${props.statusFilter === "active" ? "chip--accent" : ""}"
                        type="button"
                        title="Show active sessions"
                        @click=${() => props.onStatusFilterChange("active")}
                      >
                        Active ${statusCounts.active}
                      </button>
                      <button
                        class="chip ${props.statusFilter === "idle" ? "chip--accent" : ""}"
                        type="button"
                        title="Show idle sessions"
                        @click=${() => props.onStatusFilterChange("idle")}
                      >
                        Idle ${statusCounts.idle}
                      </button>
                      <button
                        class="chip ${props.statusFilter === "completed" ? "chip--accent" : ""}"
                        type="button"
                        title="Show completed sessions"
                        @click=${() => props.onStatusFilterChange("completed")}
                      >
                        Completed ${statusCounts.completed}
                      </button>
                    </div>
                  </div>

                  <div class="sessions-slices__group">
                    <div class="sessions-slices__label">Lane</div>
                    <div class="chip-row sessions-slices__chips">
                      <button
                        class="chip ${props.laneFilter === "all" ? "chip--accent" : ""}"
                        type="button"
                        title="Show all lanes"
                        @click=${() => props.onLaneFilterChange("all")}
                      >
                        All ${laneCounts.total}
                      </button>
                      <button
                        class="chip ${props.laneFilter === "regular" ? "chip--accent" : ""}"
                        type="button"
                        title="Show regular sessions"
                        @click=${() => props.onLaneFilterChange("regular")}
                      >
                        Regular ${laneCounts.regular}
                      </button>
                      <button
                        class="chip ${props.laneFilter === "cron" ? "chip--accent" : ""}"
                        type="button"
                        title="Show cron sessions"
                        @click=${() => props.onLaneFilterChange("cron")}
                      >
                        Cron ${laneCounts.cron}
                      </button>
                    </div>
                  </div>
	                </div>
	              </div>

	              ${(() => {
	                const subagentRows = allRows.filter((row) => isSubagentSessionKey(row.key));
	                if (subagentRows.length === 0) return nothing;
	                const candidates = subagentRows.filter((row) => {
	                  const activeTasks = props.activeTasks?.get(row.key) ?? [];
	                  if (activeTasks.some((t) => t.status === "in-progress")) return false;
	                  return row.abortedLastRun || deriveSessionStatus(row, activeTasks) === "completed";
	                });
	                return html`
	                  <div class="sessions-filters-pane__section">
	                    <div class="sessions-filters-pane__section-title">Subagents</div>
	                    <div class="muted" style="font-size: 11px;">
	                      Subagent sessions are normally deleted by the gateway after a cooldown. Use
	                      this to delete completed/errored subagent sessions immediately.
	                    </div>
	                    <div class="chip-row">
	                      <span class="chip">Total ${subagentRows.length}</span>
	                      <span class="chip">Done/errored ${candidates.length}</span>
	                    </div>
	                    <button
	                      class="btn btn--secondary btn--sm"
	                      ?disabled=${props.loading || candidates.length === 0}
	                      @click=${() => props.onDeleteMany(candidates.map((r) => r.key))}
	                      title="Delete completed/errored subagent sessions"
	                    >
	                      ${icon("trash-2", { size: 14 })}
	                      <span>Clean up ${candidates.length}</span>
	                    </button>
	                  </div>
	                `;
	              })()}

	              <details class="sessions-filters-pane__details">
	                <summary class="sessions-filters-pane__details-summary">
	                  ${icon("filter", { size: 14 })}
	                  <span>More filters</span>
                </summary>
                <div class="sessions-filters-pane__details-body">
                  <div class="field--modern">
                    <label class="field__label">Kind</label>
                    <select
                      class="field__input"
                      .value=${props.kindFilter}
                      @change=${(e: Event) =>
                        props.onKindFilterChange(
                          (e.target as HTMLSelectElement).value as SessionKindFilter,
                        )}
                    >
                      <option value="all">All</option>
                      <option value="direct">Direct</option>
                      <option value="group">Group</option>
                      <option value="global">Global</option>
                      <option value="unknown">Unknown</option>
                    </select>
                  </div>
                  <div class="field--modern">
                    <label class="field__label">Agent</label>
                    <select
                      class="field__input"
                      .value=${props.agentLabelFilter}
                      @change=${(e: Event) =>
                        props.onAgentLabelFilterChange((e.target as HTMLSelectElement).value)}
                    >
                      <option value="">Any</option>
                      ${(() => {
                        const map = new Map<string, string>();
                        for (const row of allRows) {
                          const key = normalizeAgentLabelKey(row.label);
                          const keyLower = key.toLowerCase();
                          if (map.has(keyLower)) continue;
                          map.set(keyLower, displayAgentLabelKey(key));
                        }
                        return [...map.entries()]
                          .sort((a, b) => a[1].localeCompare(b[1]))
                          .map(([value, label]) => html`<option value=${value}>${label}</option>`);
                      })()}
                    </select>
                  </div>
                  <div class="field--modern">
                    <label class="field__label">Tags</label>
                    <div class="sessions-tags-filter">
                      <form
                        class="sessions-tags-filter__form"
                        @submit=${(e: Event) => {
                          e.preventDefault();
                          const form = e.currentTarget as HTMLFormElement;
                          const input = form.querySelector("input") as HTMLInputElement | null;
                          const value = normalizeTagLabel(input?.value ?? "");
                          if (!value) return;
                          toggleTagFilter(value);
                          if (input) input.value = "";
                        }}
                      >
                        <input
                          class="field__input sessions-tags-filter__input"
                          type="text"
                          placeholder="Add tag filter…"
                        />
                        <button class="btn btn--secondary btn--sm" type="submit">
                          ${icon("plus", { size: 14 })}
                          <span>Add</span>
                        </button>
                      </form>
                      <div class="chip-row">
                        <button
                          class="chip ${selectedTagKeys.size === 0 ? "chip--accent" : ""}"
                          type="button"
                          title="Clear tag filters"
                          @click=${() => props.onTagFilterChange([])}
                        >
                          Any
                        </button>
                        ${tagCounts.slice(0, 20).map(
                          (t) => html`
                            <button
                              class="chip ${selectedTagKeys.has(normalizeTagKey(t.label)) ? "chip--accent" : ""}"
                              type="button"
                              title=${selectedTagKeys.has(normalizeTagKey(t.label))
                                ? "Remove tag filter"
                                : "Filter by tag"}
                              @click=${() => toggleTagFilter(t.label)}
                            >
                              ${t.label} ${t.count}
                            </button>
                          `,
                        )}
                      </div>
                      ${selectedTagKeys.size > 1
                        ? html`<div class="muted" style="margin-top: 6px;">Matching all selected tags.</div>`
                        : nothing}
                    </div>
                  </div>
                </div>
              </details>

              ${hasFilters
                ? html`
                  <div class="sessions-filters-pane__section">
                    <div class="sessions-filters-pane__section-title">Active filters</div>
                    <div class="sessions-active-filters">
                      <div class="chip-row">
                        ${activeFilterChips.map(
                          (chip) => html`
                            <button
                              class="chip sessions-filter-chip"
                              type="button"
                              title="Remove filter"
                              @click=${chip.onClear}
                            >
                              <span class="sessions-filter-chip__label">${chip.label}</span>
                              <span class="sessions-filter-chip__x">${icon("x", { size: 12 })}</span>
                            </button>
                          `,
                        )}
                      </div>
                      <button class="btn btn--secondary btn--sm" @click=${clearAllFilters}>
                        ${icon("trash-2", { size: 14 })}
                        <span>Clear all</span>
                      </button>
                    </div>
                  </div>
                `
                : nothing}

              <!-- Server-side Fetch Options -->
              <details class="sessions-fetch-options">
                <summary class="sessions-fetch-options__summary">
                  ${icon("server", { size: 12 })}
                  <span>Fetch options</span>
                  <span class="muted sessions-fetch-options__hint">(Refresh to apply)</span>
                  ${(props.activeMinutes || props.limit || props.includeGlobal || props.includeUnknown)
                    ? html`
                      <span class="sessions-fetch-options__chips">
                        ${props.activeMinutes ? html`<span class="badge badge--muted">active ${props.activeMinutes}m</span>` : nothing}
                        ${props.limit ? html`<span class="badge badge--muted">limit ${props.limit}</span>` : nothing}
                        ${props.includeGlobal ? html`<span class="badge badge--muted">global</span>` : nothing}
                        ${props.includeUnknown ? html`<span class="badge badge--muted">unknown</span>` : nothing}
                      </span>
                    `
                    : nothing}
                  <span class="sessions-fetch-options__chev">${icon("chevron-down", { size: 14 })}</span>
                </summary>
                <div class="table-filters--modern table-filters--secondary">
                  <div class="field--modern" style="min-width: 100px;">
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
                  <div class="field--modern" style="min-width: 80px;">
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
                  ${props.result
                    ? html`<div class="muted" style="font-size: 11px;">Store: ${props.result.path}</div>`
                    : nothing}
                </div>
              </details>
            </div>
          </aside>

          <div class="sessions-dashboard__results">
            <div class="sessions-results-pane">
	              <div class="sessions-results-pane__toolbar">
	                <div class="sessions-results-pane__toolbar-left">
	                  ${hasFilters
	                    ? html`
	                      <span class="muted">${filteredCount} of ${totalCount} shown</span>
	                    `
	                    : html`<span class="muted">${totalCount} shown</span>`}
	                  ${fetchedCount !== totalCount ? html` <span class="muted">(of ${fetchedCount} fetched)</span>` : nothing}
	                  ${hiddenCount > 0
	                    ? props.showHidden
	                      ? html` <span class="muted">(incl. ${hiddenCount} hidden)</span>`
	                      : html` <span class="muted">(${hiddenCount} hidden)</span>`
	                    : nothing}
	                </div>
                <div class="sessions-results-pane__toolbar-right">
                  <div class="sessions-toolbar__group sessions-toolbar__group--view">
                    <button
                      class="sessions-view-toggle__btn ${props.viewMode === "list" ? "sessions-view-toggle__btn--active" : ""}"
                      type="button"
                      title="List view"
                      aria-pressed=${props.viewMode === "list"}
                      @click=${() => props.onViewModeChange("list")}
                    >
                      ${icon("list", { size: 14 })}<span>List</span>
                    </button>
                    <button
                      class="sessions-view-toggle__btn ${props.viewMode === "table" ? "sessions-view-toggle__btn--active" : ""}"
                      type="button"
                      title="Table view"
                      aria-pressed=${props.viewMode === "table"}
                      @click=${() => props.onViewModeChange("table")}
                    >
                      ${icon("box", { size: 14 })}<span>Table</span>
                    </button>
                  </div>

                  <div class="sessions-toolbar__group sessions-sort">
                    <select
                      class="field__input"
                      title="Sort by"
                      .value=${props.sort}
                      @change=${(e: Event) =>
                        props.onSortChange(
                          (e.target as HTMLSelectElement).value as SessionSortColumn,
                        )}
                    >
                      <option value="updated">Activity</option>
                      <option value="name">Name</option>
                      <option value="tokens">Tokens</option>
                      <option value="status">Status</option>
                      <option value="kind">Kind</option>
                    </select>
                    <button
                      class="btn btn--icon btn--icon-sm"
                      title=${props.sortDir === "asc" ? "Sort descending" : "Sort ascending"}
                      aria-label="Toggle sort direction"
                      @click=${() => props.onSortChange(props.sort)}
                    >
                      ${icon("chevrons-down", {
                        size: 14,
                        class:
                          props.sortDir === "asc"
                            ? "sessions-sort__dir-icon sessions-sort__dir-icon--asc"
                            : "sessions-sort__dir-icon",
                      })}
                    </button>
                  </div>
                </div>
              </div>

              ${props.error
                ? html`
                  <div class="callout--danger" style="margin: 12px 0;">
                    <div class="callout__icon">${icon("alert-circle", { size: 18 })}</div>
                    <div class="callout__content">${props.error}</div>
                  </div>
                `
                : nothing}

              ${props.viewMode === "list"
                ? html`
                  <div class="sessions-list" role="list" aria-busy=${props.loading && !props.result}>
                    ${props.loading && !props.result
                      ? renderSessionsListSkeleton()
                      : rows.length === 0
                        ? html`
                          <div class="data-table__empty">
                            <div class="data-table__empty-icon">${icon("file-text", { size: 32 })}</div>
                            <div class="data-table__empty-title">
                              ${hasFilters ? "No matching sessions" : "No sessions found"}
                            </div>
                            <div class="data-table__empty-desc">
                              ${hasFilters
                                ? "Try adjusting your search or filter criteria"
                                : "Sessions will appear here when users start conversations"}
                            </div>
                            ${hasFilters
                              ? html`<button class="btn btn--sm" style="margin-top: 12px;" @click=${() => props.onSearchChange("")}>
                                  ${icon("x", { size: 14 })}
                                  <span>Clear search</span>
                                </button>`
                              : html`<button class="btn btn--sm" style="margin-top: 12px;" ?disabled=${props.loading} @click=${props.onRefresh}>
                                  ${icon("refresh-cw", { size: 14 })}
                                  <span>Refresh</span>
                                </button>`}
                          </div>
                        `
                        : rows.map((row) =>
                            renderListItem(
                              row,
                              props.basePath,
                              defaults,
                              props.onPatch,
                              props.onDelete,
                              props.onSessionOpen,
                              props.onDrawerOpen,
                              props.onDrawerOpenExpanded,
                              props.drawerKey,
                              props.loading,
                              props.activeTasks?.get(row.key) ?? [],
                              props.onViewSessionLogs,
                            ),
                          )}
                  </div>
                `
                : html`
                  <div class="data-table data-table--modern sessions-table" style=${sessionsTableStyle}>
                    <div class="data-table__header">
                      <div
                        class="data-table__header-cell data-table__header-cell--sortable sessions-table__header-name"
                        @click=${() => props.onSortChange("name")}
                      >
                        <span>Session</span>
                        ${renderSortIcon("name", props)}
                        <div
                          class="sessions-table__resize-handle"
                          title="Drag to resize (double-click to reset)"
                          @pointerdown=${startResizeNameColumn}
                          @dblclick=${resetNameColumnWidth}
                        ></div>
                      </div>
                      <div
                        class="data-table__header-cell data-table__header-cell--sortable"
                        @click=${() => props.onSortChange("updated")}
                      >
                        <span>Activity</span>
                        ${renderSortIcon("updated", props)}
                      </div>
                      <div
                        class="data-table__header-cell data-table__header-cell--sortable"
                        @click=${() => props.onSortChange("tokens")}
                      >
                        <span>AI</span>
                        ${renderSortIcon("tokens", props)}
                      </div>
                      <div class="data-table__header-cell data-table__header-cell--actions">Actions</div>
                    </div>
                    <div class="data-table__body" aria-busy=${props.loading && !props.result}>
                      ${props.loading && !props.result
                        ? renderSessionsSkeleton()
                        : rows.length === 0
                          ? html`
                            <div class="data-table__empty">
                              <div class="data-table__empty-icon">${icon("file-text", { size: 32 })}</div>
                              <div class="data-table__empty-title">
                                ${hasFilters ? "No matching sessions" : "No sessions found"}
                              </div>
                              <div class="data-table__empty-desc">
                                ${hasFilters
                                  ? "Try adjusting your search or filter criteria"
                                  : "Sessions will appear here when users start conversations"}
                              </div>
                              ${hasFilters
                                ? html`<button class="btn btn--sm" style="margin-top: 12px;" @click=${() => props.onSearchChange("")}>
                                    ${icon("x", { size: 14 })}
                                    <span>Clear search</span>
                                  </button>`
                                : html`<button class="btn btn--sm" style="margin-top: 12px;" ?disabled=${props.loading} @click=${props.onRefresh}>
                                    ${icon("refresh-cw", { size: 14 })}
                                    <span>Refresh</span>
                                  </button>`}
                            </div>
                          `
                          : rows.map((row) =>
                              renderRow(
                                row,
                                props.basePath,
                                resolvedDefaults,
                                props.onPatch,
                                props.onDelete,
                                props.onSessionOpen,
                                props.onDrawerOpen,
                                props.onDrawerOpenExpanded,
                                props.drawerKey,
                                props.loading,
                                props.activeTasks?.get(row.key) ?? [],
                                props.onViewSessionLogs,
                              ),
                            )}
                    </div>
                  </div>
                `}
            </div>
          </div>
        </div>
      </div>
    </section>
    ${props.drawerKey
      ? renderSessionsDrawer({
          session: drawerSession,
          props,
        })
      : nothing}
  `;
}

function renderListItem(
  row: GatewaySessionRow,
  basePath: string,
  defaults: SessionsListResult["defaults"] | null,
  onPatch: SessionsProps["onPatch"],
  onDelete: SessionsProps["onDelete"],
  onSessionOpen: SessionsProps["onSessionOpen"],
  onDrawerOpen: SessionsProps["onDrawerOpen"],
  onDrawerOpenExpanded: SessionsProps["onDrawerOpenExpanded"],
  drawerKey: SessionsProps["drawerKey"],
  disabled: boolean,
  activeTasks: SessionActiveTask[],
  onViewLogs?: (key: string) => void,
) {
  const updated = row.updatedAt ? formatAgo(row.updatedAt) : "n/a";
  const resolvedDefaults = resolveSessionDefaults(defaults);
  const modelProvider = row.modelProvider ?? resolvedDefaults.modelProvider;
  const model = row.model ?? resolvedDefaults.model;
  const contextTokens = row.contextTokens ?? resolvedDefaults.contextTokens;
  const rawThinking = row.thinkingLevel ?? "";
  const isBinaryThinking = isBinaryThinkingProvider(row.modelProvider);
  const thinkingResolved = resolveEffectiveStringSetting({
    override: rawThinking,
    defaultValue: resolvedDefaults.thinkingDefault,
  });
  const thinking = resolveThinkLevelDisplay(thinkingResolved.effective, isBinaryThinking);
  const thinkingOverride = resolveThinkLevelDisplay(rawThinking, isBinaryThinking);
  const verboseResolved = resolveEffectiveStringSetting({
    override: row.verboseLevel ?? "",
    defaultValue: resolvedDefaults.verboseDefault,
  });
  const reasoningResolved = resolveEffectiveStringSetting({
    override: row.reasoningLevel ?? "",
    defaultValue: resolvedDefaults.reasoningDefault,
  });
  const displayName = row.displayName ?? row.key;
  const canLink = row.kind !== "global";
  const status = deriveSessionStatus(row, activeTasks);
  const statusBadgeClass = getStatusBadgeClass(status);

  const sessionType = inferSessionType(row.key);
  const sessionIdPrefix = row.sessionId ? row.sessionId.slice(0, 8) : truncateKey(row.key, 12);
  const labelValue = row.label?.trim() ?? "";
  const title = row.derivedTitle?.trim() || row.displayName || sessionIdPrefix || displayName;
  const agentName = resolveAgentDisplayName(row);
  const workspaceDir = row.workspaceDir?.trim() ?? "";
  const workspaceName = workspaceDir ? workspaceDir.replace(/.*[\\/]/, "") : "";
  const channelBucket = row.channel
    ? `${row.channel}${row.groupChannel ? ` #${row.groupChannel}` : ""}`
    : "";
  const bucketLabel = workspaceName || channelBucket;
  const bucketTitle = workspaceDir || channelBucket;
  const bucketIcon = workspaceName ? "folder" : "layers";

  const hasActiveTasks = activeTasks.length > 0;
  const inProgressCount = activeTasks.filter((t) => t.status === "in-progress").length;
  const hasError = Boolean(row.abortedLastRun);
  const hasDescription = typeof row.description === "string" && row.description.trim();
  const description = hasDescription ? row.description!.trim() : "";
  const hasLastMessagePreview =
    typeof row.lastMessagePreview === "string" && row.lastMessagePreview.trim();
  const lastMessagePreview = hasLastMessagePreview ? row.lastMessagePreview!.trim() : "";
  const previewText = description || lastMessagePreview;
  const selected = drawerKey === row.key;
  const thinkLevels = resolveThinkLevelOptions(row.modelProvider);

  return html`
    <div
      class="sessions-list-item ${selected ? "sessions-list-item--selected" : ""} ${hasActiveTasks ? "sessions-list-item--active" : ""}"
      role="listitem"
      @click=${() => onDrawerOpen(row.key)}
    >
      <div class="sessions-list-item__main">
        <div class="sessions-list-item__title-row">
          <div class="sessions-list-item__title" title=${title}>
            ${title}
            ${hasActiveTasks
              ? html`
                <span class="session-active-indicator" title="${inProgressCount} task(s) in progress">
                  ${icon("activity", { size: 12 })}
                  ${inProgressCount > 0 ? html`<span class="session-active-count">${inProgressCount}</span>` : nothing}
                </span>
              `
              : nothing}
          </div>
          <div class="sessions-list-item__badges">
            <span class="badge ${statusBadgeClass}">${status}</span>
            ${hasError ? html`<span class="badge badge--danger">aborted</span>` : nothing}
            <span class="badge badge--muted">${row.kind}</span>
          </div>
        </div>

        <div class="sessions-list-item__subtitle">
          <span class="sessions-agent-pill" title=${`Agent ${agentName}`}>
            ${icon("user", { size: 12 })} Agent <span class="sessions-agent-pill__name">${agentName}</span>
          </span>
          <span
            class="session-row__type ${sessionType === "cron" ? "session-row__type--cron" : "session-row__type--regular"}"
            title=${sessionType === "cron" ? "Cron session" : "Regular session"}
          >
            ${sessionType === "cron" ? "Cron" : "Regular"}
          </span>
          ${bucketLabel
            ? html`
              <span class="session-row__bucket" title=${bucketTitle}>
                ${icon(bucketIcon, { size: 12 })} ${bucketLabel}
              </span>
            `
            : nothing}
          <details
            class="session-label-editor"
            @click=${(e: Event) => e.stopPropagation()}
            @toggle=${(e: Event) => {
              const details = e.currentTarget as HTMLDetailsElement;
              if (!details.open) return;
              window.requestAnimationFrame(() => {
                const input = details.querySelector("input") as HTMLInputElement | null;
                if (input) {
                  input.focus();
                  input.select();
                }
              });
            }}
          >
            <summary
              class="session-label-editor__trigger"
              title=${labelValue ? "Click to edit label" : "Click to set label"}
            >
              ${sessionIdPrefix}
            </summary>
            <form
              class="session-label-editor__form"
              @submit=${(e: Event) => {
                e.preventDefault();
                const form = e.currentTarget as HTMLFormElement;
                const input = form.querySelector("input") as HTMLInputElement | null;
                const next = input?.value.trim() ?? "";
                onPatch(row.key, { label: next || null });
                const details = form.closest("details") as HTMLDetailsElement | null;
                if (details) details.open = false;
              }}
            >
              <input
                class="field__input session-label-editor__input"
                .value=${labelValue}
                ?disabled=${disabled}
                placeholder="Label (optional)"
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    const details = (e.currentTarget as HTMLElement).closest(
                      "details",
                    ) as HTMLDetailsElement | null;
                    if (details) details.open = false;
                  }
                }}
              />
              <button
                class="row-actions__btn"
                type="submit"
                title="Save label"
                aria-label="Save label"
                ?disabled=${disabled}
              >
                ${icon("check", { size: 14 })}
              </button>
            </form>
          </details>
        </div>

        ${previewText
          ? html`<div class="sessions-list-item__preview" title=${previewText}>${previewText}</div>`
          : nothing}
      </div>

      <div class="sessions-list-item__right">
        <div class="sessions-list-item__time">${updated}</div>
        <div class="sessions-list-item__model" title="Effective model and context window">
          <span class="sessions-list-item__model-mono">${modelProvider ?? "provider?"} · ${model ?? "model?"}</span>
          ${typeof contextTokens === "number"
            ? html`<span class="muted">· ctx ${contextTokens}</span>`
            : nothing}
        </div>
        <div class="sessions-list-item__stats">
          <span
            class="badge badge--muted"
            title=${thinkingResolved.source === "override"
              ? `Thinking (override): ${thinking}`
              : `Thinking (default): ${thinking}`}
          >
            ${icon("brain", { size: 12 })} ${thinking}
          </span>
          <span class="badge badge--muted session-token-badge session-token-badge--churn" title="Total tokens (increasing)">
            ${icon("trending-up", { size: 12, class: "session-token-badge__icon" })} ${formatSessionTokens(row)}
          </span>
        </div>
        <div class="row-actions">
          <details class="session-ai-settings" @click=${(e: Event) => e.stopPropagation()}>
            <summary class="row-actions__btn" title="AI settings" aria-label="AI settings">
              ${icon("settings", { size: 14 })}
            </summary>
            <div class="session-ai-settings__panel">
              <div class="session-ai-settings__row">
                <span class="muted">Thinking</span>
                <select
                  class="field__input"
                  .value=${thinkingOverride}
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
              <div class="session-ai-settings__row">
                <span class="muted">Verbose</span>
                <select
                  class="field__input"
                  .value=${row.verboseLevel ?? ""}
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
              <div class="session-ai-settings__row">
                <span class="muted">Reasoning</span>
                <select
                  class="field__input"
                  .value=${row.reasoningLevel ?? ""}
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
              <div class="muted" style="font-size: 11px;">
                Effective: thinking ${thinking} (${thinkingResolved.source}), verbose ${verboseResolved.effective} (${verboseResolved.source}), reasoning ${reasoningResolved.effective} (${reasoningResolved.source})
              </div>
            </div>
          </details>
          <button
            class="row-actions__btn"
            title="Copy session key"
            aria-label="Copy session key"
            ?disabled=${disabled}
            @click=${(e: Event) => {
              e.stopPropagation();
              copyToClipboard(row.key);
            }}
          >
            ${icon("copy", { size: 14 })}
          </button>
          ${canLink
            ? html`
              <button
                class="row-actions__btn"
                title="Open chat"
                aria-label="Open chat"
                ?disabled=${disabled}
                @click=${(e: Event) => {
                  e.stopPropagation();
                  onSessionOpen?.(row.key);
                }}
              >
                ${icon("message-square", { size: 14 })}
              </button>
            `
            : nothing}
          ${onViewLogs
            ? html`
              <button
                class="row-actions__btn"
                title="View logs"
                aria-label="View logs"
                ?disabled=${disabled}
                @click=${(e: Event) => {
                  e.stopPropagation();
                  onViewLogs(row.key);
                }}
              >
                ${icon("file-text", { size: 14 })}
              </button>
            `
            : nothing}
          <button
            class="row-actions__btn"
            title="Details"
            aria-label="Details"
            ?disabled=${disabled}
            @click=${(e: Event) => {
              e.stopPropagation();
              onDrawerOpenExpanded(row.key);
            }}
          >
            ${icon("more-vertical", { size: 14 })}
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderSessionsDrawer(params: {
  session: GatewaySessionRow | null;
  props: SessionsProps;
}) {
  const { session, props } = params;
  if (!session || !props.drawerKey) return nothing;
  const sessionType = inferSessionType(session.key);
  const sessionIdPrefix = session.sessionId ? session.sessionId.slice(0, 8) : truncateKey(session.key, 12);
  const title = (session.derivedTitle?.trim() || session.displayName || sessionIdPrefix).trim();
  const agentName = resolveAgentDisplayName(session);
  const subtitleParts: string[] = [];
  subtitleParts.push(`Agent ${agentName}`);
  subtitleParts.push(sessionType);
  subtitleParts.push(sessionIdPrefix);
  subtitleParts.push(session.kind);
  const subtitle = subtitleParts.join(" · ");
  const activeTasks = props.activeTasks?.get(session.key) ?? [];
  const status = deriveSessionStatus(session, activeTasks);
  const statusBadgeClass = getStatusBadgeClass(status);
  const updated = session.updatedAt ? formatAgo(session.updatedAt) : "n/a";
  const resolvedDefaults = resolveSessionDefaults(props.result?.defaults ?? null);
  const modelProvider = session.modelProvider ?? resolvedDefaults.modelProvider;
  const model = session.model ?? resolvedDefaults.model;
  const contextTokens = session.contextTokens ?? resolvedDefaults.contextTokens;
  const rawThinking = session.thinkingLevel ?? "";
  const isBinaryThinking = isBinaryThinkingProvider(session.modelProvider);
  const thinkingResolved = resolveEffectiveStringSetting({
    override: rawThinking,
    defaultValue: resolvedDefaults.thinkingDefault,
  });
  const thinkingEffective = resolveThinkLevelDisplay(thinkingResolved.effective, isBinaryThinking);
  const thinkingOverride = resolveThinkLevelDisplay(rawThinking, isBinaryThinking);
  const thinkLevels = resolveThinkLevelOptions(session.modelProvider);
  const verboseResolved = resolveEffectiveStringSetting({
    override: session.verboseLevel ?? "",
    defaultValue: resolvedDefaults.verboseDefault,
  });
  const reasoningResolved = resolveEffectiveStringSetting({
    override: session.reasoningLevel ?? "",
    defaultValue: resolvedDefaults.reasoningDefault,
  });
  const verbose = session.verboseLevel ?? "";
  const reasoning = session.reasoningLevel ?? "";
  const canLink = session.kind !== "global";
  const preview = props.drawerPreview?.key === session.key ? props.drawerPreview : null;
  const tags = Array.isArray(session.tags)
    ? session.tags.map((t) => normalizeTagLabel(t)).filter(Boolean)
    : [];

  return html`
    <div class="sessions-drawer-backdrop" @click=${props.onDrawerClose}></div>
    <aside class="sessions-drawer ${props.drawerExpanded ? "sessions-drawer--expanded" : ""}">
      <div class="sessions-drawer__header">
        <div style="min-width: 0;">
          <div class="sessions-drawer__title" title=${title}>${title}</div>
          <div class="sessions-drawer__subtitle" title=${subtitle}>${subtitle}</div>
        </div>
        <div class="sessions-drawer__header-actions">
          <button
            class="btn btn--icon btn--icon-sm"
            title=${props.drawerExpanded ? "Collapse" : "Expand"}
            aria-label=${props.drawerExpanded ? "Collapse" : "Expand"}
            @click=${props.onDrawerToggleExpanded}
          >
            ${icon("maximize", { size: 16 })}
          </button>
          <button
            class="btn btn--icon btn--icon-sm"
            title="Close"
            aria-label="Close"
            @click=${props.onDrawerClose}
          >
            ${icon("x", { size: 16 })}
          </button>
        </div>
      </div>
      <div class="sessions-drawer__body">
        <div class="sessions-drawer__section">
          <div class="sessions-drawer__section-header">
            <div class="sessions-drawer__section-title">Overview</div>
            <button
              class="btn btn--sm btn--secondary"
              ?disabled=${props.drawerPreviewLoading}
              @click=${props.onDrawerRefreshPreview}
            >
              ${icon("refresh-cw", { size: 14 })}
              <span>${props.drawerPreviewLoading ? "Loading..." : "Refresh"}</span>
            </button>
          </div>
          <div class="sessions-drawer__grid">
            <div class="sessions-drawer__kv">
              <div class="sessions-drawer__k">Status</div>
              <div class="sessions-drawer__v">
                <span class="badge ${statusBadgeClass}">${status}</span>
                ${session.abortedLastRun ? html`<span class="badge badge--danger">aborted</span>` : nothing}
              </div>
            </div>
            <div class="sessions-drawer__kv">
              <div class="sessions-drawer__k">Updated</div>
              <div class="sessions-drawer__v">${updated}</div>
            </div>
            <div class="sessions-drawer__kv">
              <div class="sessions-drawer__k">Key</div>
              <div class="sessions-drawer__v sessions-drawer__mono">
                <button
                  class="sessions-drawer__copy"
                  title="Copy session key"
                  @click=${() => copyToClipboard(session.key)}
                >
                  ${icon("copy", { size: 14 })}
                </button>
                <span>${session.key}</span>
              </div>
            </div>
            ${session.workspaceDir
              ? html`
                <div class="sessions-drawer__kv">
                  <div class="sessions-drawer__k">Workspace</div>
                  <div class="sessions-drawer__v sessions-drawer__mono" title=${session.workspaceDir}>${session.workspaceDir}</div>
                </div>
              `
              : nothing}
            ${session.channel
              ? html`
                <div class="sessions-drawer__kv">
                  <div class="sessions-drawer__k">Channel</div>
                  <div class="sessions-drawer__v">${session.channel}</div>
                </div>
              `
              : nothing}
            ${session.space
              ? html`
                <div class="sessions-drawer__kv">
                  <div class="sessions-drawer__k">Space</div>
                  <div class="sessions-drawer__v">${session.space}</div>
                </div>
              `
              : nothing}
            ${session.groupChannel
              ? html`
                <div class="sessions-drawer__kv">
                  <div class="sessions-drawer__k">Room</div>
                  <div class="sessions-drawer__v">${session.groupChannel}</div>
                </div>
              `
              : nothing}
            <div class="sessions-drawer__kv sessions-drawer__kv--full">
              <div class="sessions-drawer__k">Tags</div>
              <div class="sessions-drawer__v">
                <div class="chip-row">
                  ${tags.length === 0
                    ? html`<span class="muted">None</span>`
                    : tags.map(
                        (tag) => html`
                          <button
                            class="chip sessions-filter-chip"
                            type="button"
                            title="Remove tag"
                            ?disabled=${props.loading}
                            @click=${() => {
                              const key = normalizeTagKey(tag);
                              const next = tags.filter((t) => normalizeTagKey(t) !== key);
                              props.onPatch(session.key, { tags: next.length ? next : null });
                            }}
                          >
                            <span class="sessions-filter-chip__label">${tag}</span>
                            <span class="sessions-filter-chip__x">${icon("x", { size: 12 })}</span>
                          </button>
                        `,
                      )}
                </div>
                <form
                  class="sessions-tags-editor"
                  @submit=${(e: Event) => {
                    e.preventDefault();
                    const form = e.currentTarget as HTMLFormElement;
                    const input = form.querySelector("input") as HTMLInputElement | null;
                    const value = normalizeTagLabel(input?.value ?? "");
                    if (!value) return;
                    const key = normalizeTagKey(value);
                    const seen = new Set(tags.map((t) => normalizeTagKey(t)));
                    if (seen.has(key)) {
                      if (input) input.value = "";
                      return;
                    }
                    props.onPatch(session.key, { tags: [...tags, value] });
                    if (input) input.value = "";
                  }}
                >
                  <input
                    class="field__input sessions-tags-editor__input"
                    type="text"
                    placeholder="Add tag…"
                    ?disabled=${props.loading}
                  />
                  <button
                    class="btn btn--secondary btn--sm"
                    type="submit"
                    ?disabled=${props.loading}
                    title="Add tag"
                  >
                    ${icon("plus", { size: 14 })}
                    <span>Add</span>
                  </button>
                </form>
              </div>
            </div>
          </div>
          <div class="sessions-drawer__actions">
            ${canLink
              ? html`
                <button class="btn btn--primary" @click=${() => {
                  props.onDrawerClose();
                  props.onSessionOpen?.(session.key);
                }}>
                  ${icon("message-square", { size: 14 })}
                  <span>Open chat</span>
                </button>
              `
              : nothing}
            ${props.onViewSessionLogs
              ? html`
                <button class="btn btn--secondary" @click=${() => {
                  props.onDrawerClose();
                  props.onViewSessionLogs?.(session.key);
                }}>
                  ${icon("file-text", { size: 14 })}
                  <span>View logs</span>
                </button>
              `
              : nothing}
            <button
              class="btn btn--danger"
              ?disabled=${props.loading}
              @click=${() => {
                props.onDrawerClose();
                props.onDelete(session.key);
              }}
            >
              ${icon("trash", { size: 14 })}
              <span>Delete session</span>
            </button>
          </div>
        </div>

        <div class="sessions-drawer__section">
          <div class="sessions-drawer__section-title">AI</div>
          <div class="sessions-drawer__grid">
            <div class="sessions-drawer__kv">
              <div class="sessions-drawer__k">Agent</div>
              <div class="sessions-drawer__v">${agentName}</div>
            </div>
            <div class="sessions-drawer__kv">
              <div class="sessions-drawer__k">Model</div>
              <div class="sessions-drawer__v sessions-drawer__mono">${model ?? "unknown"}</div>
            </div>
            <div class="sessions-drawer__kv">
              <div class="sessions-drawer__k">Provider</div>
              <div class="sessions-drawer__v">${modelProvider ?? "unknown"}</div>
            </div>
            ${typeof contextTokens === "number"
              ? html`
                <div class="sessions-drawer__kv">
                  <div class="sessions-drawer__k">Context</div>
                  <div class="sessions-drawer__v">${contextTokens}</div>
                </div>
              `
              : nothing}
            <div class="sessions-drawer__kv">
              <div class="sessions-drawer__k">Tokens</div>
              <div class="sessions-drawer__v">
                <span class="badge badge--muted session-token-badge session-token-badge--churn">
                  ${icon("trending-up", { size: 12, class: "session-token-badge__icon" })} ${formatSessionTokens(session)}
                </span>
              </div>
            </div>
            ${typeof session.turnCount === "number"
              ? html`
                <div class="sessions-drawer__kv">
                  <div class="sessions-drawer__k">Turns</div>
                  <div class="sessions-drawer__v">${session.turnCount}</div>
                </div>
              `
              : nothing}
          </div>
          <details class="sessions-drawer__details">
            <summary class="sessions-drawer__details-summary">
              <span>AI settings</span>
              <span class="muted">${icon("chevron-down", { size: 14 })}</span>
            </summary>
            <div class="sessions-drawer__details-body">
              <div class="muted" style="font-size: 11px;">
                Effective: thinking ${thinkingEffective} (${thinkingResolved.source}), verbose ${verboseResolved.effective} (${verboseResolved.source}), reasoning ${reasoningResolved.effective} (${reasoningResolved.source})
              </div>
              <div class="sessions-drawer__ai-row">
                <span class="muted">Thinking</span>
                <select
                  class="field__input"
                  .value=${thinkingOverride}
                  ?disabled=${props.loading}
                  @change=${(e: Event) => {
                    const value = (e.target as HTMLSelectElement).value;
                    props.onPatch(session.key, {
                      thinkingLevel: resolveThinkLevelPatchValue(value, isBinaryThinking),
                    });
                  }}
                >
                  ${thinkLevels.map((level) =>
                    html`<option value=${level}>${level || "inherit"}</option>`,
                  )}
                </select>
              </div>
              <div class="sessions-drawer__ai-row">
                <span class="muted">Verbose</span>
                <select
                  class="field__input"
                  .value=${verbose}
                  ?disabled=${props.loading}
                  @change=${(e: Event) => {
                    const value = (e.target as HTMLSelectElement).value;
                    props.onPatch(session.key, { verboseLevel: value || null });
                  }}
                >
                  ${VERBOSE_LEVELS.map(
                    (level) => html`<option value=${level.value}>${level.label}</option>`,
                  )}
                </select>
              </div>
              <div class="sessions-drawer__ai-row">
                <span class="muted">Reasoning</span>
                <select
                  class="field__input"
                  .value=${reasoning}
                  ?disabled=${props.loading}
                  @change=${(e: Event) => {
                    const value = (e.target as HTMLSelectElement).value;
                    props.onPatch(session.key, { reasoningLevel: value || null });
                  }}
                >
                  ${REASONING_LEVELS.map((level) =>
                    html`<option value=${level}>${level || "inherit"}</option>`,
                  )}
                </select>
              </div>
            </div>
          </details>
        </div>

        <div class="sessions-drawer__section">
          <div class="sessions-drawer__section-header">
            <div class="sessions-drawer__section-title">Recent activity</div>
            ${props.drawerPreviewLoading
              ? html`<span class="muted">${icon("loader", { size: 14 })}</span>`
              : nothing}
          </div>
          ${props.drawerPreviewError
            ? html`<div class="callout--danger"><div class="callout__content">${props.drawerPreviewError}</div></div>`
            : nothing}
          ${preview
            ? preview.status === "ok"
              ? html`
                <div class="sessions-preview">
                  ${preview.items.map(
                    (item) => html`
                      <div class="sessions-preview__row">
                        <span class="sessions-preview__role">${item.role}</span>
                        <span class="sessions-preview__text">${item.text}</span>
                      </div>
                    `,
                  )}
                </div>
              `
              : html`<div class="muted">No recent transcript items.</div>`
            : props.drawerPreviewLoading
              ? html`<div class="muted">Loading preview…</div>`
              : html`<div class="muted">No preview available.</div>`}
        </div>
      </div>
    </aside>
  `;
}

function renderRow(
  row: GatewaySessionRow,
  basePath: string,
  defaults: ReturnType<typeof resolveSessionDefaults>,
  onPatch: SessionsProps["onPatch"],
  onDelete: SessionsProps["onDelete"],
  onSessionOpen: SessionsProps["onSessionOpen"],
  onDrawerOpen: SessionsProps["onDrawerOpen"],
  onDrawerOpenExpanded: SessionsProps["onDrawerOpenExpanded"],
  drawerKey: SessionsProps["drawerKey"],
  disabled: boolean,
  activeTasks: SessionActiveTask[],
  onViewLogs?: (key: string) => void,
) {
  const updated = row.updatedAt ? formatAgo(row.updatedAt) : "n/a";
  const rawThinking = row.thinkingLevel ?? "";
  const isBinaryThinking = isBinaryThinkingProvider(row.modelProvider);
  const thinkingResolved = resolveEffectiveStringSetting({
    override: rawThinking,
    defaultValue: defaults.thinkingDefault,
  });
  const thinking = resolveThinkLevelDisplay(thinkingResolved.effective, isBinaryThinking);
  const thinkingOverride = resolveThinkLevelDisplay(rawThinking, isBinaryThinking);
  const thinkLevels = resolveThinkLevelOptions(row.modelProvider);
  const verboseResolved = resolveEffectiveStringSetting({
    override: row.verboseLevel ?? "",
    defaultValue: defaults.verboseDefault,
  });
  const reasoningResolved = resolveEffectiveStringSetting({
    override: row.reasoningLevel ?? "",
    defaultValue: defaults.reasoningDefault,
  });
  const verbose = row.verboseLevel ?? "";
  const reasoning = row.reasoningLevel ?? "";
  const displayName = row.displayName ?? row.key;
  const canLink = row.kind !== "global";
  const chatUrl = canLink
    ? hrefForTab("chat", basePath, { session: row.key })
    : null;
  const status = deriveSessionStatus(row, activeTasks);
  const statusBadgeClass = getStatusBadgeClass(status);

  const sessionType = inferSessionType(row.key);
  const sessionIdPrefix = row.sessionId ? row.sessionId.slice(0, 8) : truncateKey(row.key, 12);
  const labelValue = row.label?.trim() ?? "";
  const title = row.derivedTitle?.trim() || displayName;
  const agentName = resolveAgentDisplayName(row);
  const workspaceDir = row.workspaceDir?.trim() ?? "";
  const workspaceName = workspaceDir ? workspaceDir.replace(/.*[\\/]/, "") : "";
  const channelBucket = row.channel
    ? `${row.channel}${row.groupChannel ? ` #${row.groupChannel}` : ""}`
    : "";
  const bucketLabel = workspaceName || channelBucket;
  const bucketTitle = workspaceDir || channelBucket;
  const bucketIcon = workspaceName ? "folder" : "layers";

  // Active task info
  const hasActiveTasks = activeTasks.length > 0;
  const inProgressCount = activeTasks.filter((t) => t.status === "in-progress").length;
  const hasError = Boolean(row.abortedLastRun);
  const hasDescription = typeof row.description === "string" && row.description.trim();
  const description = hasDescription ? row.description!.trim() : "";
  const hasLastMessagePreview =
    typeof row.lastMessagePreview === "string" && row.lastMessagePreview.trim();
  const lastMessagePreview = hasLastMessagePreview ? row.lastMessagePreview!.trim() : "";
  const previewText = description || lastMessagePreview;
  const selected = drawerKey === row.key;

  const modelProvider = row.modelProvider ?? defaults.modelProvider;
  const model = row.model ?? defaults.model;

  return html`
    <div
      class="data-table__row data-table__row--clickable ${selected ? "data-table__row--selected" : ""} ${hasActiveTasks ? "data-table__row--active" : ""}"
      @click=${() => onDrawerOpen(row.key)}
    >
      <div class="data-table__cell" data-label="Session">
        <div class="session-row">
          <div class="session-row__main">
            <div class="session-row__title" title=${title}>
              ${title}
              ${hasActiveTasks
                ? html`
                  <span class="session-active-indicator" title="${inProgressCount} task(s) in progress">
                    ${icon("activity", { size: 12 })}
                    ${inProgressCount > 0 ? html`<span class="session-active-count">${inProgressCount}</span>` : nothing}
                  </span>
                `
                : nothing}
            </div>
            <div class="session-row__meta">
              <span class="sessions-agent-pill" title=${`Agent ${agentName}`}>
                ${icon("user", { size: 12 })} Agent <span class="sessions-agent-pill__name">${agentName}</span>
              </span>
              <span
                class="session-row__type ${sessionType === "cron" ? "session-row__type--cron" : "session-row__type--regular"}"
                title=${sessionType === "cron" ? "Cron session" : "Regular session"}
              >
                ${sessionType === "cron" ? "Cron" : "Regular"}
              </span>
              ${bucketLabel
                ? html`
                  <span class="session-row__bucket" title=${bucketTitle}>
                    ${icon(bucketIcon, { size: 12 })} ${bucketLabel}
                  </span>
                `
                : nothing}
              <details
                class="session-label-editor"
                @click=${(e: Event) => e.stopPropagation()}
                @toggle=${(e: Event) => {
                  const details = e.currentTarget as HTMLDetailsElement;
                  if (!details.open) return;
                  window.requestAnimationFrame(() => {
                    const input = details.querySelector("input") as HTMLInputElement | null;
                    if (input) {
                      input.focus();
                      input.select();
                    }
                  });
                }}
              >
                <summary
                  class="session-label-editor__trigger"
                  title=${labelValue ? "Click to edit label" : "Click to set label"}
                >
                  ${sessionIdPrefix}
                </summary>
                <form
                  class="session-label-editor__form"
                  @submit=${(e: Event) => {
                    e.preventDefault();
                    const form = e.currentTarget as HTMLFormElement;
                    const input = form.querySelector("input") as HTMLInputElement | null;
                    const next = input?.value.trim() ?? "";
                    onPatch(row.key, { label: next || null });
                    const details = form.closest("details") as HTMLDetailsElement | null;
                    if (details) details.open = false;
                  }}
                >
                  <input
                    class="field__input session-label-editor__input"
                    .value=${labelValue}
                    ?disabled=${disabled}
                    placeholder="Label (optional)"
                    @keydown=${(e: KeyboardEvent) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        const details = (e.currentTarget as HTMLElement).closest(
                          "details",
                        ) as HTMLDetailsElement | null;
                        if (details) details.open = false;
                      }
                    }}
                  />
                  <button
                    class="row-actions__btn"
                    type="submit"
                    title="Save label"
                    aria-label="Save label"
                    ?disabled=${disabled}
                  >
                    ${icon("check", { size: 14 })}
                  </button>
                </form>
              </details>
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
        </div>
      </div>
      <div class="data-table__cell" data-label="Activity">
        <div class="session-activity">
          <div class="session-activity__top">
            <span class="badge ${statusBadgeClass}">${status}</span>
            ${hasError ? html`<span class="badge badge--danger">aborted</span>` : nothing}
            <span class="session-activity__updated">${updated}</span>
          </div>
          ${previewText
            ? html`<div class="session-activity__preview" title=${previewText}>${previewText}</div>`
            : nothing}
        </div>
      </div>
      <div class="data-table__cell" data-label="AI">
        <div class="session-ai">
          <div class="session-ai__model" title=${model ?? ""}>
            ${model ? html`<span class="session-ai__model-name">${model}</span>` : html`<span class="muted">unknown model</span>`}
            ${modelProvider ? html`<span class="session-ai__provider">${modelProvider}</span>` : nothing}
          </div>
          <div class="session-ai__stats">
            <span class="badge badge--muted" title="Thinking level">
              ${icon("brain", { size: 12 })} ${thinking}
            </span>
            <span class="badge badge--muted session-token-badge session-token-badge--churn" title="Total tokens (increasing)">
              ${icon("trending-up", { size: 12, class: "session-token-badge__icon" })} ${formatSessionTokens(row)}
            </span>
            ${typeof row.turnCount === "number"
              ? html`
                <span class="badge badge--muted" title="Turns">
                  ${icon("rotate-ccw", { size: 12 })} ${row.turnCount}
                </span>
              `
              : nothing}
            <details class="session-ai-settings" @click=${(e: Event) => e.stopPropagation()}>
              <summary class="row-actions__btn" title="AI settings" aria-label="AI settings">
                ${icon("settings", { size: 14 })}
              </summary>
              <div class="session-ai-settings__panel">
                <div class="session-ai-settings__row">
                  <span class="muted">Thinking</span>
                  <select
                    class="field__input"
                    .value=${thinkingOverride}
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
                <div class="session-ai-settings__row">
                  <span class="muted">Verbose</span>
                  <select
                    class="field__input"
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
                <div class="session-ai-settings__row">
                  <span class="muted">Reasoning</span>
                  <select
                    class="field__input"
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
                <div class="muted" style="font-size: 11px;">
                  Effective: thinking ${thinking} (${thinkingResolved.source}), verbose ${verboseResolved.effective} (${verboseResolved.source}), reasoning ${reasoningResolved.effective} (${reasoningResolved.source})
                </div>
              </div>
            </details>
          </div>
        </div>
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
                @click=${(e: Event) => {
                  e.stopPropagation();
                  onSessionOpen?.(row.key);
                }}
              >
                ${icon("message-square", { size: 14 })}
              </button>
            `
            : nothing}
          ${onViewLogs
            ? html`
              <button
                class="row-actions__btn"
                title="View logs"
                aria-label="View logs"
                ?disabled=${disabled}
                @click=${(e: Event) => {
                  e.stopPropagation();
                  onViewLogs(row.key);
                }}
              >
                ${icon("file-text", { size: 14 })}
              </button>
            `
            : nothing}
          <button
            class="row-actions__btn"
            title="Details"
            aria-label="Details"
            ?disabled=${disabled}
            @click=${(e: Event) => {
              e.stopPropagation();
              onDrawerOpenExpanded(row.key);
            }}
          >
            ${icon("more-vertical", { size: 14 })}
          </button>
        </div>
      </div>
    </div>
  `;
}
