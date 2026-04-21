import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { EventLogEntry } from "../app-events.ts";
import { formatEventPayload } from "../presenter.ts";

export type DebugProps = {
  loading: boolean;
  status: Record<string, unknown> | null;
  health: Record<string, unknown> | null;
  models: unknown[];
  heartbeat: unknown;
  eventLog: EventLogEntry[];
  methods: string[];
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
      ? t("dashboard.debug.criticalCount", { count: String(critical) })
      : warn > 0
        ? t("dashboard.debug.warningCount", { count: String(warn) })
        : t("dashboard.debug.noCriticalIssues");

  return html`
    <section class="grid">
      <div class="card">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="card-title">${t("dashboard.debug.snapshotsTitle")}</div>
            <div class="card-sub">${t("dashboard.debug.snapshotsSubtitle")}</div>
          </div>
          <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? t("common.refreshing") : t("common.refresh")}
          </button>
        </div>
        <div class="stack" style="margin-top: 12px;">
          <div>
            <div class="muted">${t("dashboard.debug.status")}</div>
            ${securitySummary
              ? html`<div class="callout ${securityTone}" style="margin-top: 8px;">
                  ${t("dashboard.debug.securityAuditPrefix")}:
                  ${securityLabel}${info > 0
                    ? ` · ${t("dashboard.debug.infoCount", { count: String(info) })}`
                    : ""}.
                  ${t("dashboard.debug.securityAuditHint", {
                    command: "openclaw security audit --deep",
                  })}
                </div>`
              : nothing}
            <pre class="code-block">${JSON.stringify(props.status ?? {}, null, 2)}</pre>
          </div>
          <div>
            <div class="muted">${t("dashboard.debug.health")}</div>
            <pre class="code-block">${JSON.stringify(props.health ?? {}, null, 2)}</pre>
          </div>
          <div>
            <div class="muted">${t("dashboard.debug.lastHeartbeat")}</div>
            <pre class="code-block">${JSON.stringify(props.heartbeat ?? {}, null, 2)}</pre>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">${t("dashboard.debug.manualRpcTitle")}</div>
        <div class="card-sub">${t("dashboard.debug.manualRpcSubtitle")}</div>
        <div class="stack" style="margin-top: 16px;">
          <label class="field">
            <span>${t("dashboard.debug.method")}</span>
            <select
              .value=${props.callMethod}
              @change=${(e: Event) =>
                props.onCallMethodChange((e.target as HTMLSelectElement).value)}
            >
              ${!props.callMethod
                ? html` <option value="" disabled>${t("dashboard.debug.selectMethod")}</option> `
                : nothing}
              ${props.methods.map((m) => html`<option value=${m}>${m}</option>`)}
            </select>
          </label>
          <label class="field">
            <span>${t("dashboard.debug.paramsJson")}</span>
            <textarea
              .value=${props.callParams}
              @input=${(e: Event) =>
                props.onCallParamsChange((e.target as HTMLTextAreaElement).value)}
              rows="6"
            ></textarea>
          </label>
        </div>
        <div class="row" style="margin-top: 12px;">
          <button class="btn primary" @click=${props.onCall}>${t("common.call")}</button>
        </div>
        ${props.callError
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.callError}</div>`
          : nothing}
        ${props.callResult
          ? html`<pre class="code-block" style="margin-top: 12px;">${props.callResult}</pre>`
          : nothing}
      </div>
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">${t("dashboard.debug.modelsTitle")}</div>
      <div class="card-sub">${t("dashboard.debug.modelsSubtitle")}</div>
      <pre class="code-block" style="margin-top: 12px;">
${JSON.stringify(props.models ?? [], null, 2)}</pre
      >
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">${t("dashboard.debug.eventLogTitle")}</div>
      <div class="card-sub">${t("dashboard.debug.eventLogSubtitle")}</div>
      ${props.eventLog.length === 0
        ? html` <div class="muted" style="margin-top: 12px">${t("dashboard.debug.noEvents")}</div> `
        : html`
            <div class="list debug-event-log" style="margin-top: 12px;">
              ${props.eventLog.map(
                (evt) => html`
                  <div class="list-item debug-event-log__item">
                    <div class="list-main">
                      <div class="list-title">${evt.event}</div>
                      <div class="list-sub">${new Date(evt.ts).toLocaleTimeString()}</div>
                    </div>
                    <div class="list-meta debug-event-log__meta">
                      <pre class="code-block debug-event-log__payload">
${formatEventPayload(evt.payload)}</pre
                      >
                    </div>
                  </div>
                `,
              )}
            </div>
          `}
    </section>
  `;
}
