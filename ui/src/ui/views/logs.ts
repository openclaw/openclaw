import { html, nothing } from "lit";

import { toast } from "../components/toast";
import type { LogEntry, LogLevel } from "../types";
import { formatAgo } from "../format";
import { icon } from "../icons";

const LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

// Extended props with new features
export type LogsProps = {
  loading: boolean;
  error: string | null;
  file: string | null;
  entries: LogEntry[];
  filterText: string;
  levelFilters: Record<LogLevel, boolean>;
  autoFollow: boolean;
  truncated: boolean;
  showRelativeTime: boolean;
  // New: Sidebar state
  showSidebar: boolean;
  // New: Filter panel state
  showFilters: boolean;
  // New: Subsystem filters
  subsystemFilters: Set<string>;
  // New: Available subsystems extracted from entries
  availableSubsystems: string[];
  // Callbacks
  onFilterTextChange: (next: string) => void;
  onLevelToggle: (level: LogLevel, enabled: boolean) => void;
  onToggleAutoFollow: (next: boolean) => void;
  onToggleRelativeTime: (next: boolean) => void;
  onRefresh: () => void;
  onClear: () => void;
  onExport: (lines: string[], label: string) => void;
  onScroll: (event: Event) => void;
  onJumpToBottom: () => void;
  // New callbacks
  onToggleSidebar?: () => void;
  onToggleFilters?: () => void;
  onSubsystemToggle?: (subsystem: string) => void;
};

function formatTime(value?: string | null, relative = false): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  if (relative) {
    return formatAgo(date.getTime());
  }
  return date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function matchesFilter(entry: LogEntry, needle: string): boolean {
  if (!needle) return true;
  const haystack = [entry.message, entry.subsystem, entry.raw]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

/**
 * Try to detect and parse JSON from a string.
 */
function detectJson(text: string): { isJson: false } | { isJson: true; data: unknown; prefix: string; raw: string } {
  if (!text) return { isJson: false };
  const jsonStartIndex = text.search(/[{[]/);
  if (jsonStartIndex === -1) return { isJson: false };
  const prefix = text.slice(0, jsonStartIndex).trim();
  const jsonCandidate = text.slice(jsonStartIndex);
  try {
    const data = JSON.parse(jsonCandidate);
    if (typeof data === "object" && data !== null) {
      return { isJson: true, data, prefix, raw: jsonCandidate };
    }
  } catch {
    // Not valid JSON
  }
  return { isJson: false };
}

/**
 * Format JSON with syntax highlighting
 */
function formatJsonWithHighlight(data: unknown, indent = 0): ReturnType<typeof html> {
  const indentStr = "  ".repeat(indent);

  if (data === null) {
    return html`<span class="json-null">null</span>`;
  }
  if (typeof data === "boolean") {
    return html`<span class="json-boolean">${String(data)}</span>`;
  }
  if (typeof data === "number") {
    return html`<span class="json-number">${data}</span>`;
  }
  if (typeof data === "string") {
    return html`<span class="json-string">"${data}"</span>`;
  }
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return html`<span class="json-bracket">[]</span>`;
    }
    return html`<span class="json-bracket">[</span>
${data.map((item, i) => html`${indentStr}  ${formatJsonWithHighlight(item, indent + 1)}${i < data.length - 1 ? "," : ""}\n`)}${indentStr}<span class="json-bracket">]</span>`;
  }
  if (typeof data === "object") {
    const entries = Object.entries(data);
    if (entries.length === 0) {
      return html`<span class="json-bracket">{}</span>`;
    }
    return html`<span class="json-bracket">{</span>
${entries.map(([key, value], i) => html`${indentStr}  <span class="json-key">"${key}"</span>: ${formatJsonWithHighlight(value, indent + 1)}${i < entries.length - 1 ? "," : ""}\n`)}${indentStr}<span class="json-bracket">}</span>`;
  }
  return html`${String(data)}`;
}

/**
 * Get a short preview of JSON data
 */
function getJsonPreview(data: unknown): string {
  if (Array.isArray(data)) {
    return `Array(${data.length})`;
  }
  if (typeof data === "object" && data !== null) {
    const keys = Object.keys(data);
    if (keys.length <= 3) {
      return `{ ${keys.join(", ")} }`;
    }
    return `{ ${keys.slice(0, 3).join(", ")}, ... }`;
  }
  return String(data);
}

function highlightSearch(text: string, searchTerm: string): ReturnType<typeof html> {
  if (!searchTerm || !text) {
    return html`${text}`;
  }
  const lowerText = text.toLowerCase();
  const lowerSearch = searchTerm.toLowerCase();
  const index = lowerText.indexOf(lowerSearch);

  if (index === -1) {
    return html`${text}`;
  }

  const before = text.slice(0, index);
  const match = text.slice(index, index + searchTerm.length);
  const after = text.slice(index + searchTerm.length);

  return html`${before}<mark class="log-highlight">${match}</mark>${after}`;
}

/**
 * Render message with collapsible JSON support
 */
function renderMessage(
  text: string,
  searchTerm: string,
  entryId: string
): ReturnType<typeof html> {
  const jsonResult = detectJson(text);

  if (!jsonResult.isJson) {
    return highlightSearch(text, searchTerm);
  }

  const { prefix, data } = jsonResult;

  return html`
    ${prefix ? html`${highlightSearch(prefix, searchTerm)} ` : nothing}
    <details class="log-json">
      <summary class="log-json__toggle">
        ${icon("chevron-right", { size: 10 })}
        <span class="log-json__preview">${getJsonPreview(data)}</span>
      </summary>
      <pre class="log-json__content">${formatJsonWithHighlight(data)}</pre>
    </details>
  `;
}

/**
 * Copy text to clipboard and show feedback
 */
async function copyToClipboard(text: string, button: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    button.classList.add("log-entry__copy--success");
    setTimeout(() => button.classList.remove("log-entry__copy--success"), 1500);
    toast.success("Log entry copied");
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
    button.classList.add("log-entry__copy--success");
    setTimeout(() => button.classList.remove("log-entry__copy--success"), 1500);
    toast.success("Log entry copied");
  }
}

/**
 * Setup keyboard shortcuts for the logs view
 */
export function setupLogsKeyboardShortcuts(props: {
  onFocusSearch: () => void;
  onJumpToBottom: () => void;
  onRefresh: () => void;
  onToggleAutoFollow: () => void;
}): () => void {
  const handler = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
      if (e.key === "Escape") {
        target.blur();
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === "f") {
      e.preventDefault();
      props.onFocusSearch();
      return;
    }

    if (e.key === "g" || e.key === "G") {
      e.preventDefault();
      props.onJumpToBottom();
      return;
    }

    if (e.key === "r" && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      props.onRefresh();
      return;
    }

    if (e.key === "f" && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      props.onToggleAutoFollow();
      return;
    }
  };

  document.addEventListener("keydown", handler);
  return () => document.removeEventListener("keydown", handler);
}

/**
 * Count active level filters
 */
function countActiveFilters(levelFilters: Record<LogLevel, boolean>, subsystemFilters: Set<string>): number {
  const inactiveLevels = LEVELS.filter(level => !levelFilters[level]).length;
  return inactiveLevels + subsystemFilters.size;
}

/**
 * Render skeleton loading state for log entries
 */
function renderLogsSkeleton() {
  const skeletonCount = 8;
  return html`
    <div class="logs-output logs-output--skeleton">
      ${Array.from({ length: skeletonCount }, (_, index) => html`
        <div class="log-entry log-entry--skeleton">
          <span class="log-entry__ln skeleton skeleton--text" style="width: 2rem;"></span>
          <span class="log-entry__time skeleton skeleton--text" style="width: 4rem;"></span>
          <span class="log-entry__level skeleton skeleton--text" style="width: 3rem;"></span>
          <div class="log-entry__content">
            <span class="skeleton skeleton--text" style="width: ${60 + (index % 3) * 15}%;"></span>
          </div>
        </div>
      `)}
    </div>
  `;
}

/**
 * Render the session sidebar
 */
function renderSidebar(props: LogsProps) {
  // For now, show a placeholder for session history
  // This can be expanded to show actual session history when available
  return html`
    <aside class="logs-sidebar">
      <div class="logs-sidebar__header">
        <div class="logs-sidebar__title">
          ${icon("history", { size: 14 })}
          <span>Sessions</span>
        </div>
        <button
          class="logs-sidebar__toggle"
          @click=${() => props.onToggleSidebar?.()}
          title="Hide sidebar"
        >
          ${icon("panel-left-close", { size: 16 })}
        </button>
      </div>
      <div class="logs-sidebar__content">
        <!-- Current session card -->
        <div class="logs-session-card logs-session-card--active">
          <div class="logs-session-card__header">
            <span class="logs-session-card__name">Current Session</span>
            <span class="logs-session-card__badge logs-session-card__badge--current">
              ${icon("radio", { size: 10 })}
              Live
            </span>
          </div>
          <div class="logs-session-card__meta">
            <span class="logs-session-card__count">
              ${icon("file-text", { size: 12 })}
              ${props.entries.length} entries
            </span>
          </div>
        </div>

        <!-- Placeholder for session history -->
        <div class="logs-sidebar__empty">
          ${icon("clock", { size: 32 })}
          <div class="logs-sidebar__empty-text">
            Session history will appear here as you use the gateway.
          </div>
        </div>
      </div>
    </aside>
  `;
}

/**
 * Render the main logs view
 */
export function renderLogs(props: LogsProps) {
  const needle = props.filterText.trim().toLowerCase();
  const levelFiltered = LEVELS.some((level) => !props.levelFilters[level]);
  const subsystemFiltered = props.subsystemFilters?.size > 0;

  // Apply all filters
  const filtered = props.entries.filter((entry) => {
    // Level filter
    if (entry.level && !props.levelFilters[entry.level]) return false;
    // Subsystem filter (if any are selected, only show those)
    if (subsystemFiltered && entry.subsystem && !props.subsystemFilters.has(entry.subsystem)) {
      return false;
    }
    // Text filter
    return matchesFilter(entry, needle);
  });

  const exportLabel = needle || levelFiltered || subsystemFiltered ? "filtered" : "visible";
  const totalCount = props.entries.length;
  const filteredCount = filtered.length;
  const showingFiltered = filteredCount !== totalCount;

  // Extract unique subsystems from entries
  const subsystems = props.availableSubsystems ?? [
    ...new Set(props.entries.map((e) => e.subsystem).filter(Boolean) as string[]),
  ].sort();

  // Count active filters for badge
  const activeFilterCount = countActiveFilters(props.levelFilters, props.subsystemFilters ?? new Set());

  return html`
    <div class="logs-layout ${props.showSidebar ? "logs-layout--with-sidebar" : ""}">
      <!-- Session Sidebar -->
      ${props.showSidebar ? renderSidebar(props) : nothing}

      <!-- Main Content -->
      <div class="logs-main">
        <!-- Toolbar -->
        <div class="logs-toolbar">
          <!-- Primary toolbar row -->
          <div class="logs-toolbar__primary">
            <div class="logs-toolbar__left">
              <!-- Sidebar toggle (when collapsed) -->
              ${!props.showSidebar
                ? html`
                    <button
                      class="logs-toolbar__sidebar-toggle"
                      @click=${() => props.onToggleSidebar?.()}
                      title="Show sessions"
                    >
                      ${icon("panel-left", { size: 18 })}
                    </button>
                  `
                : nothing}

              <!-- Search -->
              <div class="logs-search">
                <span class="logs-search__icon">${icon("search", { size: 16 })}</span>
                <input
                  type="text"
                  class="logs-search__input"
                  id="logs-search-input"
                  placeholder="Search logs..."
                  .value=${props.filterText}
                  @input=${(e: Event) =>
                    props.onFilterTextChange((e.target as HTMLInputElement).value)}
                />
                ${props.filterText
                  ? html`
                      <button
                        class="logs-search__clear"
                        @click=${() => props.onFilterTextChange("")}
                        title="Clear search"
                      >
                        ${icon("x", { size: 12 })}
                      </button>
                    `
                  : nothing}
              </div>

              <!-- Filter toggle -->
              <button
                class="logs-filter-toggle ${props.showFilters ? "logs-filter-toggle--active" : ""}"
                @click=${() => props.onToggleFilters?.()}
                title="${props.showFilters ? "Hide filters" : "Show filters"}"
              >
                ${icon("filter", { size: 14 })}
                <span>Filters</span>
                ${activeFilterCount > 0
                  ? html`<span class="logs-filter-toggle__count">${activeFilterCount}</span>`
                  : nothing}
              </button>
            </div>

            <div class="logs-toolbar__right">
              <!-- Live badge -->
              ${props.autoFollow
                ? html`
                    <div class="logs-live-badge">
                      <span class="logs-live-badge__dot"></span>
                      <span>LIVE</span>
                    </div>
                  `
                : nothing}

              <!-- Time format toggle -->
              <button
                class="logs-action-btn ${props.showRelativeTime ? "logs-action-btn--active" : ""}"
                @click=${() => props.onToggleRelativeTime(!props.showRelativeTime)}
                title="${props.showRelativeTime ? "Show absolute time" : "Show relative time"}"
              >
                ${icon("clock", { size: 14 })}
              </button>

              <!-- Auto-follow toggle -->
              <button
                class="logs-action-btn ${props.autoFollow ? "logs-action-btn--active" : ""}"
                @click=${() => props.onToggleAutoFollow(!props.autoFollow)}
                title="${props.autoFollow ? "Disable auto-follow" : "Enable auto-follow"}"
              >
                ${icon("arrow-down-to-line", { size: 14 })}
              </button>

              <div class="logs-toolbar__divider"></div>

              <!-- Refresh -->
              <button
                class="logs-action-btn"
                ?disabled=${props.loading}
                @click=${props.onRefresh}
                title="Refresh logs"
              >
                <span class="${props.loading ? "logs-action-btn__spinner" : ""}">
                  ${icon("refresh-cw", { size: 14 })}
                </span>
              </button>

              <!-- Export -->
              <button
                class="logs-action-btn"
                ?disabled=${filtered.length === 0}
                @click=${() => props.onExport(filtered.map((entry) => entry.raw), exportLabel)}
                title="Export logs"
              >
                ${icon("download", { size: 14 })}
              </button>

              <!-- Clear -->
              <button
                class="logs-action-btn logs-action-btn--icon logs-action-btn--danger"
                ?disabled=${props.entries.length === 0}
                @click=${props.onClear}
                title="Clear logs"
              >
                ${icon("trash-2", { size: 14 })}
              </button>
            </div>
          </div>

          <!-- Secondary toolbar (filters) - collapsible -->
          <div class="logs-toolbar__secondary ${props.showFilters ? "logs-toolbar__secondary--visible" : ""}">
            <!-- Level filters -->
            <div class="logs-levels">
              ${LEVELS.map(
                (level) => html`
                  <button
                    class="logs-level-chip logs-level-chip--${level} ${props.levelFilters[level] ? "logs-level-chip--active" : ""}"
                    @click=${() => props.onLevelToggle(level, !props.levelFilters[level])}
                    title="${props.levelFilters[level] ? "Hide" : "Show"} ${level.toUpperCase()}"
                  >
                    <span class="logs-level-chip__dot"></span>
                    ${level.toUpperCase()}
                  </button>
                `
              )}
            </div>

            <!-- Subsystem filters (if any) -->
            ${subsystems.length > 0
              ? html`
                  <div class="logs-subsystems">
                    <span class="logs-subsystems__label">Sources:</span>
                    ${subsystems.slice(0, 10).map(
                      (sub) => html`
                        <button
                          class="logs-subsystem-tag ${props.subsystemFilters?.has(sub) ? "logs-subsystem-tag--active" : ""}"
                          @click=${() => props.onSubsystemToggle?.(sub)}
                          title="${props.subsystemFilters?.has(sub) ? "Remove filter" : "Filter by"} ${sub}"
                        >
                          ${sub}
                          ${props.subsystemFilters?.has(sub)
                            ? html`<span class="logs-subsystem-tag__remove">${icon("x", { size: 10 })}</span>`
                            : nothing}
                        </button>
                      `
                    )}
                    ${subsystems.length > 10
                      ? html`<span class="logs-subsystem-tag">+${subsystems.length - 10} more</span>`
                      : nothing}
                  </div>
                `
              : nothing}
          </div>
        </div>

        <!-- Alerts -->
        ${props.truncated
          ? html`
              <div class="logs-alert logs-alert--warning">
                <span class="logs-alert__icon">${icon("alert-triangle", { size: 16 })}</span>
                <span class="logs-alert__content">Log output truncated. Showing latest entries only.</span>
              </div>
            `
          : nothing}
        ${props.error
          ? html`
              <div class="logs-alert logs-alert--error">
                <span class="logs-alert__icon">${icon("alert-circle", { size: 16 })}</span>
                <span class="logs-alert__content">${props.error}</span>
              </div>
            `
          : nothing}

        <!-- Terminal Viewer -->
        <div class="logs-viewer">
          <div class="logs-viewer__scroll" @scroll=${props.onScroll}>
            ${props.loading && props.entries.length === 0
              ? renderLogsSkeleton()
              : filtered.length === 0
                ? html`
                    <div class="logs-empty">
                      <div class="logs-empty__icon">
                        ${icon("scroll-text", { size: 32 })}
                      </div>
                      <div class="logs-empty__title">No log entries</div>
                      <div class="logs-empty__desc">
                        ${props.entries.length > 0
                          ? "No entries match your current filters. Try adjusting your search or level filters."
                          : "Gateway logs will appear here when the gateway is running."}
                      </div>
                      ${props.entries.length > 0
                        ? html`<button class="btn btn--sm" style="margin-top: 12px;" @click=${() => props.onFilterTextChange("")}>
                            ${icon("x", { size: 14 })}
                            <span>Clear filters</span>
                          </button>`
                        : html`<button class="btn btn--sm" style="margin-top: 12px;" ?disabled=${props.loading} @click=${props.onRefresh}>
                            ${icon("refresh-cw", { size: 14 })}
                            <span>Refresh</span>
                          </button>`}
                    </div>
                  `
              : html`
                  <div class="logs-output">
                    ${filtered.map(
                      (entry, index) => html`
                        <div
                          class="log-entry ${entry.level ? `log-entry--${entry.level}` : ""} ${needle && matchesFilter(entry, needle) ? "log-entry--highlight" : ""}"
                        >
                          <span class="log-entry__ln">${String(index + 1).padStart(4, " ")}</span>
                          <span class="log-entry__time">${formatTime(entry.time, props.showRelativeTime)}</span>
                          <span class="log-entry__level log-entry__level--${entry.level ?? "info"}">
                            ${(entry.level ?? "log").toUpperCase()}
                          </span>
                          <div class="log-entry__content">
                            ${entry.subsystem
                              ? html`<span class="log-entry__subsystem">${entry.subsystem}</span>`
                              : nothing}
                            <span class="log-entry__message">${renderMessage(entry.message ?? entry.raw, props.filterText, `log-${index}`)}</span>
                          </div>
                          <button
                            class="log-entry__copy"
                            @click=${(e: Event) => copyToClipboard(entry.raw, e.currentTarget as HTMLButtonElement)}
                            title="Copy log entry"
                            aria-label="Copy log entry to clipboard"
                          >
                            ${icon("copy", { size: 12 })}
                          </button>
                        </div>
                      `
                    )}
                  </div>
                `}
          </div>

          <!-- Jump to bottom button -->
          ${!props.autoFollow && filtered.length > 20
            ? html`
                <button class="logs-jump" @click=${props.onJumpToBottom} title="Jump to latest">
                  ${icon("chevrons-down", { size: 16 })}
                  <span>Jump to latest</span>
                </button>
              `
            : nothing}
        </div>

        <!-- Status Bar -->
        <div class="logs-status">
          <div class="logs-status__left">
            <div class="logs-status__item">
              ${icon("file-text", { size: 12 })}
              <span>
                ${filteredCount.toLocaleString()} entries
                ${showingFiltered ? html` <span style="opacity: 0.6">/ ${totalCount.toLocaleString()}</span>` : nothing}
              </span>
            </div>
            ${props.file
              ? html`
                  <div class="logs-status__separator"></div>
                  <div class="logs-status__item">
                    ${icon("folder", { size: 12 })}
                    <code style="font-size: 10px; opacity: 0.8">${props.file}</code>
                  </div>
                `
              : nothing}
            ${needle
              ? html`
                  <div class="logs-status__separator"></div>
                  <div class="logs-status__item">
                    ${icon("search", { size: 12 })}
                    <span>"${needle}"</span>
                  </div>
                `
              : nothing}
          </div>
          <div class="logs-status__right">
            ${props.autoFollow
              ? html`
                  <div class="logs-status__live">
                    <span class="logs-status__live-dot"></span>
                    <span>Auto-following</span>
                  </div>
                `
              : nothing}
            <div class="logs-shortcuts">
              <span class="logs-shortcut"><kbd>⌘F</kbd> Search</span>
              <span class="logs-shortcut"><kbd>G</kbd> Bottom</span>
              <span class="logs-shortcut"><kbd>F</kbd> Follow</span>
              <span class="logs-shortcut"><kbd>R</kbd> Refresh</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}
