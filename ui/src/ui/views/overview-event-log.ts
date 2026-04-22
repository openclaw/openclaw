import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { EventLogEntry } from "../app-events.ts";
import { icons } from "../icons.ts";
import { formatEventPayload } from "../presenter.ts";

export type OverviewEventLogProps = {
  events: EventLogEntry[];
};

export function renderOverviewEventLog(props: OverviewEventLogProps) {
  if (props.events.length === 0) {
    return nothing;
  }

  // Keep overview focused on recent activity while preserving stable append order
  // in the shared event log buffer.
  const visible = props.events.slice(-20).toReversed();

  return html`
    <details class="card ov-event-log" open>
      <summary class="ov-expandable-toggle">
        <span class="nav-item__icon">${icons.radio}</span>
        ${t("overview.eventLog.title")}
        <span class="ov-count-badge">${props.events.length}</span>
      </summary>
      <div class="ov-event-log-list">
        ${visible.map(
          (entry) => html`
            <div class="ov-event-log-entry">
              <span class="ov-event-log-ts">${new Date(entry.ts).toLocaleTimeString()}</span>
              <span class="ov-event-log-name">${entry.event}</span>
              ${entry.payload
                ? html`<span class="ov-event-log-payload muted"
                    >${formatEventPayload(entry.payload).slice(0, 120)}</span
                  >`
                : nothing}
            </div>
          `,
        )}
      </div>
    </details>
  `;
}
