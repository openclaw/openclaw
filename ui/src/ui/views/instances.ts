import { html, nothing } from "lit";
import type { PresenceEntry } from "../types.ts";
import { formatPresenceAge, formatPresenceSummary } from "../presenter.ts";
import { icons } from "../icons.ts";

export type InstancesProps = {
  loading: boolean;
  entries: PresenceEntry[];
  lastError: string | null;
  statusMessage: string | null;
  onRefresh: () => void;
};

export function renderInstances(props: InstancesProps) {
  return html`
    <section class="card" style="padding: 0;">
      <div style="padding: 12px 14px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center;">
        <div>
          <div class="card-title">Instances</div>
          <div class="card-sub">Presence beacons from connected clients and nodes.</div>
        </div>
        <button class="btn btn--sm" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      ${props.lastError ? html`<div class="callout danger" style="margin: 12px 14px;">${props.lastError}</div>` : nothing}
      ${props.statusMessage ? html`<div class="callout" style="margin: 12px 14px;">${props.statusMessage}</div>` : nothing}
      ${props.entries.length === 0
        ? html`<div style="padding: 12px 14px;" class="muted">No instances reported yet.</div>`
        : html`
          <div class="log-stream">
            <div class="log-header" style="grid-template-columns: minmax(0, 2fr) 100px 120px 80px;">
              <div class="log-header-cell">Host</div>
              <div class="log-header-cell">Mode</div>
              <div class="log-header-cell">Platform</div>
              <div class="log-header-cell">Last Seen</div>
            </div>
            ${props.entries.map((entry) => {
              const summary = formatPresenceSummary(entry);
              return html`
                <div class="log-row" style="grid-template-columns: minmax(0, 2fr) 100px 120px 80px;" title="${summary}">
                  <div style="display: flex; align-items: center; gap: 6px; overflow: hidden;">
                    <span class="icon-sm" style="width: 14px; height: 14px; color: var(--muted); flex-shrink: 0;">${icons.monitor}</span>
                    <span class="mono" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px;">${entry.host ?? "unknown"}</span>
                  </div>
                  <div><span class="log-level info">${entry.mode ?? "unknown"}</span></div>
                  <div class="mono" style="font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${entry.platform ?? "unknown"}</div>
                  <div class="mono" style="font-size: 11px; color: var(--muted);">${formatPresenceAge(entry)}</div>
                </div>
              `;
            })}
          </div>
        `
      }
    </section>
  `;
}
