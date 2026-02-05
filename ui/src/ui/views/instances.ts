import { html, nothing } from "lit";
import type { PresenceEntry } from "../types.ts";
import { t } from "../../i18n/i18n";
import { formatPresenceAge, formatPresenceSummary } from "../presenter.ts";

export type InstancesProps = {
  loading: boolean;
  entries: PresenceEntry[];
  lastError: string | null;
  statusMessage: string | null;
  onRefresh: () => void;
};

export function renderInstances(props: InstancesProps) {
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">${t("page.title.instances")}</div>
          <div class="card-sub">${t("page.subtitle.instances")}</div>
        </div>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? t("common.loading") : t("common.refresh")}
        </button>
      </div>
      ${
        props.lastError
          ? html`<div class="callout danger" style="margin-top: 12px;">
            ${props.lastError}
          </div>`
          : nothing
      }
      ${
        props.statusMessage
          ? html`<div class="callout" style="margin-top: 12px;">
            ${props.statusMessage}
          </div>`
          : nothing
      }
      <div class="list" style="margin-top: 16px;">
        ${
          props.entries.length === 0
            ? html`
                <div class="muted">${t("instances.no_instances_yet")}</div>
              `
            : props.entries.map((entry) => renderEntry(entry))
        }
      </div>
    </section>
  `;
}

function renderEntry(entry: PresenceEntry) {
  const lastInput =
    entry.lastInputSeconds != null
      ? `${entry.lastInputSeconds}${t("instances.seconds_ago")}`
      : t("common.n_a");
  const mode = entry.mode ?? t("instances.unknown");
  const roles = Array.isArray(entry.roles) ? entry.roles.filter(Boolean) : [];
  const scopes = Array.isArray(entry.scopes) ? entry.scopes.filter(Boolean) : [];
  const scopesLabel =
    scopes.length > 0
      ? scopes.length > 3
        ? `${scopes.length} ${t("instances.scopes")}`
        : `${t("instances.scopes_label")}: ${scopes.join(", ")}`
      : null;
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${entry.host ?? t("instances.unknown_host")}</div>
        <div class="list-sub">${formatPresenceSummary(entry)}</div>
        <div class="chip-row">
          <span class="chip">${mode}</span>
          ${roles.map((role) => html`<span class="chip">${role}</span>`)}
          ${scopesLabel ? html`<span class="chip">${scopesLabel}</span>` : nothing}
          ${entry.platform ? html`<span class="chip">${entry.platform}</span>` : nothing}
          ${entry.deviceFamily ? html`<span class="chip">${entry.deviceFamily}</span>` : nothing}
          ${
            entry.modelIdentifier
              ? html`<span class="chip">${entry.modelIdentifier}</span>`
              : nothing
          }
          ${entry.version ? html`<span class="chip">${entry.version}</span>` : nothing}
        </div>
      </div>
      <div class="list-meta">
        <div>${formatPresenceAge(entry)}</div>
        <div class="muted">${t("instances.last_input")} ${lastInput}</div>
        <div class="muted">${t("instances.reason")} ${entry.reason ?? ""}</div>
      </div>
    </div>
  `;
}
