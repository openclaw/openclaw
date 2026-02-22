import { html, nothing } from "lit";
import type { EventLogEntry } from "../app-events.ts";
import { formatEventPayload } from "../presenter.ts";
import type { HealthSummary, ModelCatalogEntry } from "../types.ts";

export type DebugProps = {
  loading: boolean;
  status: Record<string, unknown> | null;
  health: HealthSummary | null;
  models: ModelCatalogEntry[];
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
    critical > 0 ? `${critical} critical` : warn > 0 ? `${warn} warnings` : "No critical issues";

  return html`
    <section class="grid grid-cols-2">
      <div class="card">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="card-title">Snapshots</div>
            <div class="card-sub">Status, health, and heartbeat data.</div>
          </div>
          <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        <div class="stack" style="margin-top: 12px;">
          <div>
            <div class="muted">Status</div>
            ${
              securitySummary
                ? html`<div class="callout ${securityTone}" style="margin-top: 8px;">
                  Security audit: ${securityLabel}${info > 0 ? ` · ${info} info` : ""}. Run
                  <span class="mono">openclaw security audit --deep</span> for details.
                </div>`
                : nothing
            }
            <pre class="code-block">${JSON.stringify(props.status ?? {}, null, 2)}</pre>
          </div>
          <div>
            <div class="muted">Health</div>
            <pre class="code-block">${JSON.stringify(props.health ?? {}, null, 2)}</pre>
          </div>
          <div>
            <div class="muted">Last heartbeat</div>
            <pre class="code-block">${JSON.stringify(props.heartbeat ?? {}, null, 2)}</pre>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Manual RPC</div>
        <div class="card-sub">Send a raw gateway method with JSON params.</div>
        <div class="form-grid" style="margin-top: 16px;">
          <label class="field">
            <span>Method</span>
            <input
              .value=${props.callMethod}
              @input=${(e: Event) => props.onCallMethodChange((e.target as HTMLInputElement).value)}
              placeholder="system-presence"
            />
          </label>
          <label class="field">
            <span>Params (JSON)</span>
            <textarea
              .value=${props.callParams}
              @input=${(e: Event) =>
                props.onCallParamsChange((e.target as HTMLTextAreaElement).value)}
              rows="6"
            ></textarea>
          </label>
        </div>
        <div class="row" style="margin-top: 12px;">
          <button class="btn primary" @click=${props.onCall}>Call</button>
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
      <div class="card-title">Models</div>
      <div class="card-sub">Catalog from models.list.</div>
      <pre class="code-block" style="margin-top: 12px;">${JSON.stringify(
        props.models ?? [],
        null,
        2,
      )}</pre>
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="row" style="justify-content: space-between; align-items: baseline;">
        <div>
          <div class="card-title">Event Log</div>
          <div class="card-sub">Latest gateway events.</div>
        </div>
        ${
          props.eventLog.length > 0
            ? html`<button
                class="btn btn-sm"
                @click=${(e: Event) => {
                  const section = (e.target as HTMLElement).closest("section")!;
                  const details = section.querySelectorAll<HTMLDetailsElement>(
                    "details.debug-event-entry",
                  );
                  const allOpen = Array.from(details).every((d) => d.open);
                  details.forEach((d) => (d.open = !allOpen));
                }}
              >${"Expand All / Collapse All"}</button>`
            : nothing
        }
      </div>
      ${
        props.eventLog.length === 0
          ? html`
              <div class="muted" style="margin-top: 12px">No events yet.</div>
            `
          : html`
            <div class="debug-event-log-scroll">
              ${props.eventLog.map(
                (evt) => html`
                  <details class="debug-event-entry">
                    <summary class="debug-event-summary">
                      <span class="debug-event-name">${evt.event}</span>
                      <span class="debug-event-ts muted">${new Date(evt.ts).toLocaleTimeString()}</span>
                    </summary>
                    ${
                      evt.payload
                        ? html`<pre class="code-block debug-event-payload">${formatEventPayload(evt.payload)}</pre>`
                        : html`
                            <div class="muted" style="padding: 8px 0 4px">No payload.</div>
                          `
                    }
                  </details>
                `,
              )}
            </div>
          `
      }
    </section>
  `;
}
