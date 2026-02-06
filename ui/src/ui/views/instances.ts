import { msg } from "@lit/localize";
import { html, nothing } from "lit";
import type { PresenceEntry } from "../types.ts";
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
          <div class="card-title">${msg("Connected Instances", { id: "instances.title" })}</div>
          <div class="card-sub">${msg("Presence beacons from the gateway and clients.", { id: "instances.subtitle" })}</div>
        </div>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${
            props.loading
              ? msg("Loading…", { id: "instances.loading" })
              : msg("Refresh", { id: "instances.refresh" })
          }
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
                <div class="muted">${msg("No instances reported yet.", { id: "instances.empty" })}</div>
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
      ? msg("{count}s ago", {
          id: "instances.lastInputAgo",
          args: { count: entry.lastInputSeconds },
        })
      : msg("n/a", { id: "instances.na" });
  const mode = entry.mode ?? msg("unknown", { id: "instances.unknown" });
  const roles = Array.isArray(entry.roles) ? entry.roles.filter(Boolean) : [];
  const scopes = Array.isArray(entry.scopes) ? entry.scopes.filter(Boolean) : [];
  const scopesLabel =
    scopes.length > 0
      ? scopes.length > 3
        ? msg("{count} scopes", { id: "instances.scopesCount", args: { count: scopes.length } })
        : msg("scopes: {scopes}", {
            id: "instances.scopesList",
            args: { scopes: scopes.join(", ") },
          })
      : null;
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${entry.host ?? msg("unknown host", { id: "instances.unknownHost" })}</div>
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
        <div class="muted">${msg("Last input {value}", { id: "instances.lastInput", args: { value: lastInput } })}</div>
        <div class="muted">${msg("Reason {reason}", {
          id: "instances.reason",
          args: { reason: entry.reason ?? "" },
        })}</div>
      </div>
    </div>
  `;
}
