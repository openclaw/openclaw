import { html, nothing } from "lit";
import type { AppMode } from "../navigation.ts";
import type { LogEntry, LogLevel } from "../types.ts";
import { icons } from "../icons.ts";
import { tryParseJson, renderJsonTree } from "./json-renderer.ts";

const LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];
const LEVEL_ORDER: Record<string, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

type SortField = "time" | "level" | "subsystem" | "message";
type SortDir = "asc" | "desc";

let currentSortField: SortField = "time";
let currentSortDir: SortDir = "desc";
let selectedEntryIndex: number | null = null;
let detailViewMode: "structured" | "raw" = "structured";

export type LogsProps = {
  mode: AppMode;
  loading: boolean;
  error: string | null;
  file: string | null;
  entries: LogEntry[];
  filterText: string;
  levelFilters: Record<LogLevel, boolean>;
  autoFollow: boolean;
  truncated: boolean;
  onFilterTextChange: (next: string) => void;
  onLevelToggle: (level: LogLevel, enabled: boolean) => void;
  onToggleAutoFollow: (next: boolean) => void;
  onRefresh: () => void;
  onExport: (lines: string[], label: string) => void;
  onScroll: (event: Event) => void;
};

function formatTime(value?: string | null) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString();
}

function formatFullTime(value?: string | null) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toISOString();
}

function matchesFilter(entry: LogEntry, needle: string) {
  if (!needle) {
    return true;
  }
  const haystack = [entry.message, entry.subsystem, entry.raw]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

function sortEntries(entries: LogEntry[], field: SortField, dir: SortDir): LogEntry[] {
  return [...entries].toSorted((a, b) => {
    let cmp = 0;
    switch (field) {
      case "time":
        cmp = (a.time ?? "").localeCompare(b.time ?? "");
        break;
      case "level":
        cmp = (LEVEL_ORDER[a.level ?? ""] ?? -1) - (LEVEL_ORDER[b.level ?? ""] ?? -1);
        break;
      case "subsystem":
        cmp = (a.subsystem ?? "").localeCompare(b.subsystem ?? "");
        break;
      case "message":
        cmp = (a.message ?? a.raw ?? "").localeCompare(b.message ?? b.raw ?? "");
        break;
    }
    return dir === "asc" ? cmp : -cmp;
  });
}

function toggleSort(field: SortField, requestUpdate: () => void) {
  if (currentSortField === field) {
    currentSortDir = currentSortDir === "asc" ? "desc" : "asc";
  } else {
    currentSortField = field;
    currentSortDir = field === "time" ? "desc" : "asc";
  }
  requestUpdate();
}

function extractSummary(entry: LogEntry): string {
  // Use the parsed message field if it's clean (not JSON-looking)
  const msg = entry.message ?? "";
  if (msg && !msg.startsWith("{") && !msg.startsWith("[")) {
    // Return first line only
    const firstLine = msg.split("\n")[0].trim();
    return firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
  }
  // Fall back to raw, grab the human-readable tail after the JSON blob
  const raw = entry.raw ?? "";
  // Common pattern: JSON blob followed by human text like "closed before connect conn=..."
  const match = raw.match(/\}\s*(.+)$/s);
  if (match?.[1]) {
    const tail = match[1].trim().split("\n")[0];
    return tail.length > 120 ? `${tail.slice(0, 120)}…` : tail;
  }
  // Just take first line of whatever we have
  const first = (msg || raw).split("\n")[0].trim();
  return first.length > 120 ? `${first.slice(0, 120)}…` : first;
}

function renderDetailPanel(entry: LogEntry, requestUpdate: () => void) {
  const parsed = tryParseJson(entry.raw);
  const hasJson = parsed !== null;

  return html`
    <div class="log-detail">
      <div class="log-detail-header">
        <div class="card-title" style="font-size: 13px;">Log Entry Detail</div>
        <button class="btn btn--sm" @click=${() => {
          selectedEntryIndex = null;
          requestUpdate();
        }}><span class="icon-sm" style="width:12px;height:12px;">${icons.x}</span></button>
      </div>
      <div class="log-detail-fields">
        <div class="log-detail-field">
          <div class="log-detail-label">Time</div>
          <div class="log-detail-value mono">${formatFullTime(entry.time)}</div>
        </div>
        <div class="log-detail-row-inline">
          <div class="log-detail-field" style="flex:1">
            <div class="log-detail-label">Level</div>
            <div class="log-detail-value"><span class="log-level ${entry.level ?? ""}">${entry.level ?? ""}</span></div>
          </div>
          ${
            entry.subsystem
              ? html`
            <div class="log-detail-field" style="flex:2">
              <div class="log-detail-label">Subsystem</div>
              <div class="log-detail-value mono">${entry.subsystem}</div>
            </div>
          `
              : nothing
          }
        </div>
        <div class="log-detail-field">
          <div class="log-detail-label">Message</div>
          <div class="log-detail-value mono">${extractSummary(entry)}</div>
        </div>
        <div class="log-detail-field">
          <div class="log-detail-label" style="display: flex; align-items: center; justify-content: space-between;">
            <span>${hasJson ? "Data" : "Raw"}</span>
            ${
              hasJson
                ? html`
              <div class="log-detail-view-toggle">
                <button class="log-chip ${detailViewMode === "structured" ? "active info" : ""}"
                  style="padding: 2px 8px; font-size: 10px;"
                  @click=${() => {
                    detailViewMode = "structured";
                    requestUpdate();
                  }}>Structured</button>
                <button class="log-chip ${detailViewMode === "raw" ? "active info" : ""}"
                  style="padding: 2px 8px; font-size: 10px;"
                  @click=${() => {
                    detailViewMode = "raw";
                    requestUpdate();
                  }}>Raw</button>
              </div>
            `
                : nothing
            }
          </div>
          ${
            hasJson && detailViewMode === "structured"
              ? html`<div class="log-detail-json">${renderJsonTree(parsed)}</div>`
              : html`<pre class="log-detail-raw">${entry.raw}</pre>`
          }
        </div>
      </div>
    </div>
  `;
}

export function renderLogs(props: LogsProps) {
  const isBasic = props.mode === "basic";
  const needle = props.filterText.trim().toLowerCase();
  const levelFiltered = LEVELS.some((level) => !props.levelFilters[level]);
  const filtered = props.entries.filter((entry) => {
    if (entry.level && !props.levelFilters[entry.level]) {
      return false;
    }
    return matchesFilter(entry, needle);
  });
  const sorted = sortEntries(filtered, currentSortField, currentSortDir);
  const exportLabel = needle || levelFiltered ? "filtered" : "visible";
  const requestUpdate = () => props.onFilterTextChange(props.filterText);

  // Clamp selected index
  const selectedEntry =
    selectedEntryIndex !== null && selectedEntryIndex < sorted.length
      ? sorted[selectedEntryIndex]
      : null;
  if (!selectedEntry) {
    selectedEntryIndex = null;
  }

  const renderHeaderCell = (field: SortField, label: string) => {
    const isSorted = currentSortField === field;
    const arrow = isSorted ? (currentSortDir === "asc" ? "↑" : "↓") : "↕";
    return html`
      <div class="log-header-cell ${isSorted ? "sorted" : ""}" @click=${() => toggleSort(field, requestUpdate)}>
        ${label} <span class="log-sort-arrow">${arrow}</span>
      </div>
    `;
  };

  return html`
    <div class="logs-toolbar">
      <input type="text" .value=${props.filterText}
        @input=${(e: Event) => props.onFilterTextChange((e.target as HTMLInputElement).value)}
        placeholder="Search logs" />
      <label class="logs-auto-follow">
        <input type="checkbox" .checked=${props.autoFollow}
          @change=${(e: Event) => props.onToggleAutoFollow((e.target as HTMLInputElement).checked)} />
        <span>Auto-follow</span>
      </label>
      <button class="btn btn--sm" ?disabled=${props.loading} @click=${props.onRefresh}>
        ${props.loading ? "Loading…" : "Refresh"}
      </button>
      <button class="btn btn--sm" ?disabled=${sorted.length === 0}
        @click=${() =>
          props.onExport(
            sorted.map((entry) => entry.raw),
            exportLabel,
          )}>
        Export ${exportLabel}
      </button>
    </div>

    <div class="chip-row" style="margin-top: 8px;">
      ${LEVELS.map(
        (level) => html`
        <button class="log-chip ${level} ${props.levelFilters[level] ? "active" : ""}"
          @click=${() => props.onLevelToggle(level, !props.levelFilters[level])}>
          ${level}
        </button>
      `,
      )}
    </div>

    ${props.file ? html`<div class="muted" style="margin-top: 10px;">File: ${props.file}</div>` : nothing}
    ${
      props.truncated
        ? html`
            <div class="callout" style="margin-top: 10px">Log output truncated; showing latest chunk.</div>
          `
        : nothing
    }
    ${props.error ? html`<div class="callout danger" style="margin-top: 10px;">${props.error}</div>` : nothing}

    <div class="logs-split ${selectedEntry ? "logs-split--open" : ""}" style="margin-top: 8px;">
      <section class="card" style="padding: 0; flex: 1; min-width: 0; overflow: hidden;">
        <div class="log-stream" @scroll=${props.onScroll}>
          <div class="log-header">
            ${renderHeaderCell("time", "Time")}
            ${renderHeaderCell("level", "Level")}
            ${isBasic ? nothing : renderHeaderCell("subsystem", "Subsystem")}
            ${renderHeaderCell("message", "Message")}
          </div>
          ${
            sorted.length === 0
              ? html`
                  <div class="muted" style="padding: 12px">No log entries.</div>
                `
              : sorted.map(
                  (entry, i) => html`
                <div class="log-row ${selectedEntryIndex === i ? "selected" : ""}"
                  @click=${() => {
                    selectedEntryIndex = i;
                    requestUpdate();
                  }}>
                  <div class="log-time mono">${formatTime(entry.time)}</div>
                  <div class="log-level ${entry.level ?? ""}">${entry.level ?? ""}</div>
                  ${isBasic ? nothing : html`<div class="log-subsystem mono">${entry.subsystem ?? ""}</div>`}
                  <div class="log-message mono">${entry.message ?? entry.raw}</div>
                </div>
              `,
                )
          }
        </div>
      </section>
      ${selectedEntry ? renderDetailPanel(selectedEntry, requestUpdate) : nothing}
    </div>
  `;
}
