import { msg } from "@lit/localize";
import { html, nothing } from "lit";
import type { EventLogEntry } from "../app-events.ts";
import { formatEventPayload } from "../presenter.ts";

export type DebugProps = {
  loading: boolean;
  status: Record<string, unknown> | null;
  health: Record<string, unknown> | null;
  models: unknown[];
  heartbeat: unknown;
  eventLog: EventLogEntry[];
  callMethod: string;
  callParams: string;
  callResult: string | null;
  callError: string | null;
  onCallMethodChange: (next: string) => void;
  onCallParamsChange: (next: string) => void;
  onRefresh: () => void;
  onCall: () => void;
};

export function renderDebug(props: DebugProps) {
  const securityAudit =
    props.status && typeof props.status === "object"
      ? (props.status as { securityAudit?: { summary?: Record<string, number> } }).securityAudit
      : null;
  const securitySummary = securityAudit?.summary ?? null;
  const critical = securitySummary?.critical ?? 0;
  const warn = securitySummary?.warn ?? 0;
  const info = securitySummary?.info ?? 0;
  const securityTone = critical > 0 ? "danger" : warn > 0 ? "warn" : "success";
  const securityLabel =
    critical > 0
      ? msg("{count} critical", { id: "debug.security.critical", args: { count: critical } })
      : warn > 0
        ? msg("{count} warnings", { id: "debug.security.warnings", args: { count: warn } })
        : msg("No critical issues", { id: "debug.security.none" });
  const infoSuffix =
    info > 0 ? msg(" · {count} info", { id: "debug.security.info", args: { count: info } }) : "";

  return html`
    <section class="grid grid-cols-2">
      <div class="card">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="card-title">${msg("Snapshots", { id: "debug.snapshots" })}</div>
            <div class="card-sub">${msg("Status, health, and heartbeat data.", { id: "debug.snapshotsSub" })}</div>
          </div>
          <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${
              props.loading
                ? msg("Refreshing…", { id: "debug.refreshing" })
                : msg("Refresh", { id: "debug.refresh" })
            }
          </button>
        </div>
        <div class="stack" style="margin-top: 12px;">
          <div>
            <div class="muted">${msg("Status", { id: "debug.status" })}</div>
            ${
              securitySummary
                ? html`<div class="callout ${securityTone}" style="margin-top: 8px;">
                  ${msg("Security audit:", { id: "debug.security.auditLabel" })}
                  ${securityLabel}${infoSuffix}. ${msg("Run", { id: "debug.security.run" })}
                  <span class="mono">openclaw security audit --deep</span>
                  ${msg("for details.", { id: "debug.security.details" })}
                </div>`
                : nothing
            }
            <pre class="code-block">${JSON.stringify(props.status ?? {}, null, 2)}</pre>
          </div>
          <div>
            <div class="muted">${msg("Health", { id: "debug.health" })}</div>
            <pre class="code-block">${JSON.stringify(props.health ?? {}, null, 2)}</pre>
          </div>
          <div>
            <div class="muted">${msg("Last heartbeat", { id: "debug.heartbeat" })}</div>
            <pre class="code-block">${JSON.stringify(props.heartbeat ?? {}, null, 2)}</pre>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">${msg("Manual RPC", { id: "debug.rpc" })}</div>
        <div class="card-sub">${msg("Send a raw gateway method with JSON params.", { id: "debug.rpcSub" })}</div>
        <div class="form-grid" style="margin-top: 16px;">
          <label class="field">
            <span>${msg("Method", { id: "debug.rpcMethod" })}</span>
            <input
              .value=${props.callMethod}
              @input=${(e: Event) => props.onCallMethodChange((e.target as HTMLInputElement).value)}
              placeholder=${msg("system-presence", { id: "debug.rpcMethodPlaceholder" })}
            />
          </label>
          <label class="field">
            <span>${msg("Params (JSON)", { id: "debug.rpcParams" })}</span>
            <textarea
              .value=${props.callParams}
              @input=${(e: Event) =>
                props.onCallParamsChange((e.target as HTMLTextAreaElement).value)}
              rows="6"
            ></textarea>
          </label>
        </div>
        <div class="row" style="margin-top: 12px;">
          <button class="btn primary" @click=${props.onCall}>${msg("Call", { id: "debug.rpcCall" })}</button>
        </div>
        ${
          props.callError
            ? html`<div class="callout danger" style="margin-top: 12px;">
              ${props.callError}
            </div>`
            : nothing
        }
        ${
          props.callResult
            ? html`<pre class="code-block" style="margin-top: 12px;">${props.callResult}</pre>`
            : nothing
        }
      </div>
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">${msg("Models", { id: "debug.models" })}</div>
      <div class="card-sub">${msg("Catalog from models.list.", { id: "debug.modelsSub" })}</div>
      <pre class="code-block" style="margin-top: 12px;">${JSON.stringify(
        props.models ?? [],
        null,
        2,
      )}</pre>
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">${msg("Event Log", { id: "debug.eventLog" })}</div>
      <div class="card-sub">${msg("Latest gateway events.", { id: "debug.eventLogSub" })}</div>
      ${
        props.eventLog.length === 0
          ? html`
              <div class="muted" style="margin-top: 12px">${msg("No events yet.", { id: "debug.eventLogEmpty" })}</div>
            `
          : html`
            <div class="list" style="margin-top: 12px;">
              ${props.eventLog.map(
                (evt) => html`
                  <div class="list-item">
                    <div class="list-main">
                      <div class="list-title">${evt.event}</div>
                      <div class="list-sub">${new Date(evt.ts).toLocaleTimeString()}</div>
                    </div>
                    <div class="list-meta">
                      <pre class="code-block">${formatEventPayload(evt.payload)}</pre>
                    </div>
                  </div>
                `,
              )}
            </div>
          `
      }
    </section>
  `;
}
