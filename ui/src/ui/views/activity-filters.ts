import { html } from "lit";
import type { ActivityNodeKind } from "../activity/activity-types.ts";

export type ActivityFilters = {
  kinds: Set<ActivityNodeKind>;
  search: string;
  timeRangeMs: number | null;
};

export function createDefaultFilters(): ActivityFilters {
  return {
    kinds: new Set(["run", "tool", "thinking", "subagent"]),
    search: "",
    timeRangeMs: null,
  };
}

const KIND_OPTIONS: { kind: ActivityNodeKind; label: string }[] = [
  { kind: "run", label: "Runs" },
  { kind: "tool", label: "Tools" },
  { kind: "thinking", label: "Thinking" },
  { kind: "subagent", label: "Subagents" },
];

const TIME_RANGE_OPTIONS = [
  { label: "All", value: null },
  { label: "1m", value: 60_000 },
  { label: "5m", value: 5 * 60_000 },
  { label: "15m", value: 15 * 60_000 },
];

export type ActivityFiltersBarProps = {
  filters: ActivityFilters;
  onSearchChange: (search: string) => void;
  onKindToggle: (kind: ActivityNodeKind) => void;
  onTimeRangeChange: (ms: number | null) => void;
};

export function renderActivityFilters(props: ActivityFiltersBarProps) {
  const { filters } = props;

  return html`
    <div class="activity-filters">
      <input
        type="text"
        class="activity-filters__search"
        placeholder="Search events…"
        .value=${filters.search}
        @input=${(e: Event) => props.onSearchChange((e.target as HTMLInputElement).value)}
      />

      <div class="activity-filters__kinds" role="group" aria-label="Filter by kind">
        ${KIND_OPTIONS.map(
          (opt) => html`
            <label class="activity-filters__kind">
              <input
                type="checkbox"
                .checked=${filters.kinds.has(opt.kind)}
                @change=${() => props.onKindToggle(opt.kind)}
              />
              ${opt.label}
            </label>
          `,
        )}
      </div>

      <div class="activity-filters__time" role="group" aria-label="Time range">
        ${TIME_RANGE_OPTIONS.map(
          (opt) => html`
            <button
              class="btn btn--subtle btn--xs ${filters.timeRangeMs === opt.value
                ? "btn--active"
                : ""}"
              @click=${() => props.onTimeRangeChange(opt.value)}
            >
              ${opt.label}
            </button>
          `,
        )}
      </div>
    </div>
  `;
}
