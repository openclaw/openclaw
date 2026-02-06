import { msg } from "@lit/localize";
import { html, nothing } from "lit";
import type { LogEntry, LogLevel } from "../types.ts";

const LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

export type LogsProps = {
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

export function renderLogs(props: LogsProps) {
  const needle = props.filterText.trim().toLowerCase();
  const levelFiltered = LEVELS.some((level) => !props.levelFilters[level]);
  const filtered = props.entries.filter((entry) => {
    if (entry.level && !props.levelFilters[entry.level]) {
      return false;
    }
    return matchesFilter(entry, needle);
  });
  const exportLabel =
    needle || levelFiltered
      ? msg("filtered", { id: "logs.export.filtered" })
      : msg("visible", { id: "logs.export.visible" });

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">${msg("Logs", { id: "logs.title" })}</div>
          <div class="card-sub">${msg("Gateway file logs (JSONL).", { id: "logs.subtitle" })}</div>
        </div>
        <div class="row" style="gap: 8px;">
          <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${
              props.loading
                ? msg("Loading…", { id: "logs.loading" })
                : msg("Refresh", { id: "logs.refresh" })
            }
          </button>
          <button
            class="btn"
            ?disabled=${filtered.length === 0}
            @click=${() =>
              props.onExport(
                filtered.map((entry) => entry.raw),
                exportLabel,
              )}
          >
            ${msg("Export {label}", { id: "logs.export", args: { label: exportLabel } })}
          </button>
        </div>
      </div>

      <div class="filters" style="margin-top: 14px;">
        <label class="field" style="min-width: 220px;">
          <span>${msg("Filter", { id: "logs.filter" })}</span>
          <input
            .value=${props.filterText}
            @input=${(e: Event) => props.onFilterTextChange((e.target as HTMLInputElement).value)}
            placeholder=${msg("Search logs", { id: "logs.searchPlaceholder" })}
          />
        </label>
        <label class="field checkbox">
          <span>${msg("Auto-follow", { id: "logs.autoFollow" })}</span>
          <input
            type="checkbox"
            .checked=${props.autoFollow}
            @change=${(e: Event) =>
              props.onToggleAutoFollow((e.target as HTMLInputElement).checked)}
          />
        </label>
      </div>

      <div class="chip-row" style="margin-top: 12px;">
        ${LEVELS.map(
          (level) => html`
            <label class="chip log-chip ${level}">
              <input
                type="checkbox"
                .checked=${props.levelFilters[level]}
                @change=${(e: Event) =>
                  props.onLevelToggle(level, (e.target as HTMLInputElement).checked)}
              />
              <span>${level}</span>
            </label>
          `,
        )}
      </div>

      ${
        props.file
          ? html`<div class="muted" style="margin-top: 10px;">${msg("File: {file}", {
              id: "logs.file",
              args: { file: props.file },
            })}</div>`
          : nothing
      }
      ${
        props.truncated
          ? html`
              <div class="callout" style="margin-top: 10px">${msg(
                "Log output truncated; showing latest chunk.",
                { id: "logs.truncated" },
              )}</div>
            `
          : nothing
      }
      ${
        props.error
          ? html`<div class="callout danger" style="margin-top: 10px;">${props.error}</div>`
          : nothing
      }

      <div class="log-stream" style="margin-top: 12px;" @scroll=${props.onScroll}>
        ${
          filtered.length === 0
            ? html`
                <div class="muted" style="padding: 12px">${msg("No log entries.", {
                  id: "logs.empty",
                })}</div>
              `
            : filtered.map(
                (entry) => html`
                <div class="log-row">
                  <div class="log-time mono">${formatTime(entry.time)}</div>
                  <div class="log-level ${entry.level ?? ""}">${entry.level ?? ""}</div>
                  <div class="log-subsystem mono">${entry.subsystem ?? ""}</div>
                  <div class="log-message mono">${entry.message ?? entry.raw}</div>
                </div>
              `,
              )
        }
      </div>
    </section>
  `;
}
