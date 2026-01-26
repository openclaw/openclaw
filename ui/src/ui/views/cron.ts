import { html, nothing } from "lit";

import { skeleton } from "../components/design-utils";
import { formatMs } from "../format";
import { icon } from "../icons";
import {
  formatCronPayload,
  formatCronSchedule,
  formatCronState,
  formatNextRun,
} from "../presenter";
import type { ChannelUiMetaEntry, CronJob, CronRunLogEntry, CronStatus } from "../types";
import type { CronFormState } from "../ui-types";

export type CronProps = {
  loading: boolean;
  status: CronStatus | null;
  jobs: CronJob[];
  error: string | null;
  busy: boolean;
  form: CronFormState;
  channels: string[];
  channelLabels?: Record<string, string>;
  channelMeta?: ChannelUiMetaEntry[];
  runsJobId: string | null;
  runs: CronRunLogEntry[];
  onFormChange: (patch: Partial<CronFormState>) => void;
  onRefresh: () => void;
  onAdd: () => void;
  onToggle: (job: CronJob, enabled: boolean) => void;
  onRun: (job: CronJob) => void;
  onRemove: (job: CronJob) => void;
  onLoadRuns: (jobId: string) => void;
};

function buildChannelOptions(props: CronProps): string[] {
  const options = ["last", ...props.channels.filter(Boolean)];
  const current = props.form.channel?.trim();
  if (current && !options.includes(current)) {
    options.push(current);
  }
  const seen = new Set<string>();
  return options.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function resolveChannelLabel(props: CronProps, channel: string): string {
  if (channel === "last") return "last";
  const meta = props.channelMeta?.find((entry) => entry.id === channel);
  if (meta?.label) return meta.label;
  return props.channelLabels?.[channel] ?? channel;
}

function renderCronSkeleton() {
  return html`
    <section class="grid grid-cols-2">
      <!-- Status card skeleton -->
      <div class="card">
        <div class="card-header">
          <div style="display:flex;align-items:center;gap:10px;">
            ${skeleton({ width: "20px", height: "20px", rounded: true })}
            <div style="display:flex;flex-direction:column;gap:6px;">
              ${skeleton({ width: "100px", height: "18px" })}
              ${skeleton({ width: "240px", height: "12px" })}
            </div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:20px;">
          ${Array.from({ length: 2 }, () => html`
            <div style="padding:12px;border-radius:8px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);">
              ${skeleton({ width: "70px", height: "12px" })}
              ${skeleton({ width: "50px", height: "20px" })}
            </div>
          `)}
        </div>
        <div style="margin-top:12px;padding:12px;border-radius:8px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);">
          ${skeleton({ width: "80px", height: "12px" })}
          ${skeleton({ width: "120px", height: "14px" })}
        </div>
      </div>
      <!-- Jobs list skeleton -->
      <div class="card">
        <div class="card-header" style="margin-bottom:16px;">
          ${skeleton({ width: "120px", height: "18px" })}
        </div>
        ${Array.from({ length: 4 }, (_, i) => html`
          <div style="padding:12px;margin-bottom:8px;border-radius:8px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);display:flex;justify-content:space-between;align-items:center;">
            <div style="display:flex;flex-direction:column;gap:6px;">
              ${skeleton({ width: `${160 - i * 10}px`, height: "14px" })}
              ${skeleton({ width: `${200 - i * 15}px`, height: "12px" })}
            </div>
            ${skeleton({ width: "60px", height: "28px" })}
          </div>
        `)}
      </div>
    </section>
  `;
}

export function renderCron(props: CronProps) {
  // Show skeleton on initial load
  if (props.loading && !props.status && props.jobs.length === 0) {
    return renderCronSkeleton();
  }
  const channelOptions = buildChannelOptions(props);
  return html`
    <section class="grid grid-cols-2">
      <div class="card">
        <div class="card-header">
          <div class="card-header__icon">
            ${icon("clock", { size: 20 })}
          </div>
          <div>
            <div class="card-title">Scheduler</div>
            <div class="card-sub">Gateway-owned cron scheduler status</div>
          </div>
        </div>
        <div class="stat-grid--compact" style="margin-top: 20px;">
          <div class="stat--modern ${props.status?.enabled ? "stat--ok" : ""}">
            <div class="stat__icon">
              ${icon(props.status?.enabled ? "check" : "pause", { size: 18 })}
            </div>
            <div class="stat__content">
              <div class="stat-label">Status</div>
              <div class="stat-value">${props.status ? (props.status.enabled ? "Running" : "Stopped") : "n/a"}</div>
            </div>
          </div>
          <div class="stat--modern">
            <div class="stat__icon">
              ${icon("zap", { size: 18 })}
            </div>
            <div class="stat__content">
              <div class="stat-label">Active Jobs</div>
              <div class="stat-value">${props.status?.jobs ?? "n/a"}</div>
            </div>
          </div>
        </div>
        <div class="stat--modern" style="margin-top: 12px;">
          <div class="stat__icon">
            ${icon("clock", { size: 18 })}
          </div>
          <div class="stat__content">
            <div class="stat-label">Next Wake</div>
            <div class="stat-value" style="font-family: var(--mono); font-size: 14px;">
              ${formatNextRun(props.status?.nextWakeAtMs ?? null)}
            </div>
          </div>
        </div>
        <div class="card-actions">
          <button class="btn btn--secondary" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${icon("refresh-cw", { size: 14 })}
            <span>${props.loading ? "Refreshing..." : "Refresh"}</span>
          </button>
          ${props.error
            ? html`<span class="badge badge--danger">${icon("alert-circle", { size: 12 })} Error</span>`
            : nothing}
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-header__icon">
            ${icon("plus", { size: 20 })}
          </div>
          <div>
            <div class="card-title">New Job</div>
            <div class="card-sub">Create a scheduled wakeup or agent run</div>
          </div>
        </div>
        <div class="form-grid" style="margin-top: 20px;">
          <label class="field">
            <span>Name</span>
            <input
              .value=${props.form.name}
              placeholder="daily-summary"
              @input=${(e: Event) =>
                props.onFormChange({ name: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="field">
            <span>Description</span>
            <input
              .value=${props.form.description}
              placeholder="Optional description"
              @input=${(e: Event) =>
                props.onFormChange({ description: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="field">
            <span>Agent ID</span>
            <input
              .value=${props.form.agentId}
              @input=${(e: Event) =>
                props.onFormChange({ agentId: (e.target as HTMLInputElement).value })}
              placeholder="default"
            />
          </label>
          <label class="field checkbox">
            <input
              type="checkbox"
              .checked=${props.form.enabled}
              @change=${(e: Event) =>
                props.onFormChange({ enabled: (e.target as HTMLInputElement).checked })}
            />
            <span>Enabled</span>
          </label>
          <label class="field">
            <span>Schedule</span>
            <select
              .value=${props.form.scheduleKind}
              @change=${(e: Event) =>
                props.onFormChange({
                  scheduleKind: (e.target as HTMLSelectElement).value as CronFormState["scheduleKind"],
                })}
            >
              <option value="every">Every</option>
              <option value="at">At</option>
              <option value="cron">Cron</option>
            </select>
          </label>
        </div>
        ${renderScheduleFields(props)}
        <div class="form-grid" style="margin-top: 12px;">
          <label class="field">
            <span>Session</span>
            <select
              .value=${props.form.sessionTarget}
              @change=${(e: Event) =>
                props.onFormChange({
                  sessionTarget: (e.target as HTMLSelectElement).value as CronFormState["sessionTarget"],
                })}
            >
              <option value="main">Main</option>
              <option value="isolated">Isolated</option>
            </select>
          </label>
          <label class="field">
            <span>Wake mode</span>
            <select
              .value=${props.form.wakeMode}
              @change=${(e: Event) =>
                props.onFormChange({
                  wakeMode: (e.target as HTMLSelectElement).value as CronFormState["wakeMode"],
                })}
            >
              <option value="next-heartbeat">Next heartbeat</option>
              <option value="now">Now</option>
            </select>
          </label>
          <label class="field">
            <span>Payload</span>
            <select
              .value=${props.form.payloadKind}
              @change=${(e: Event) =>
                props.onFormChange({
                  payloadKind: (e.target as HTMLSelectElement).value as CronFormState["payloadKind"],
                })}
            >
              <option value="systemEvent">System event</option>
              <option value="agentTurn">Agent turn</option>
            </select>
          </label>
        </div>
        <label class="field" style="margin-top: 12px;">
          <span>${props.form.payloadKind === "systemEvent" ? "System text" : "Agent message"}</span>
          <textarea
            .value=${props.form.payloadText}
            @input=${(e: Event) =>
              props.onFormChange({
                payloadText: (e.target as HTMLTextAreaElement).value,
              })}
            rows="4"
            placeholder="Enter the message or system event text..."
          ></textarea>
        </label>
        ${props.form.payloadKind === "agentTurn"
          ? html`
              <div class="form-grid" style="margin-top: 12px;">
                <label class="field checkbox">
                  <input
                    type="checkbox"
                    .checked=${props.form.deliver}
                    @change=${(e: Event) =>
                      props.onFormChange({
                        deliver: (e.target as HTMLInputElement).checked,
                      })}
                  />
                  <span>Deliver</span>
                </label>
                <label class="field">
                  <span>Channel</span>
                  <select
                    .value=${props.form.channel || "last"}
                    @change=${(e: Event) =>
                      props.onFormChange({
                        channel: (e.target as HTMLSelectElement).value as CronFormState["channel"],
                      })}
                  >
                    ${channelOptions.map(
                      (channel) =>
                        html`<option value=${channel}>
                          ${resolveChannelLabel(props, channel)}
                        </option>`,
                    )}
                  </select>
                </label>
                <label class="field">
                  <span>To</span>
                  <input
                    .value=${props.form.to}
                    @input=${(e: Event) =>
                      props.onFormChange({ to: (e.target as HTMLInputElement).value })}
                    placeholder="+1555... or chat id"
                  />
                </label>
                <label class="field">
                  <span>Timeout (seconds)</span>
                  <input
                    .value=${props.form.timeoutSeconds}
                    @input=${(e: Event) =>
                      props.onFormChange({
                        timeoutSeconds: (e.target as HTMLInputElement).value,
                      })}
                  />
                </label>
                ${props.form.sessionTarget === "isolated"
                  ? html`
                      <label class="field">
                        <span>Post to main prefix</span>
                        <input
                          .value=${props.form.postToMainPrefix}
                          @input=${(e: Event) =>
                            props.onFormChange({
                              postToMainPrefix: (e.target as HTMLInputElement).value,
                            })}
                        />
                      </label>
                    `
                  : nothing}
              </div>
            `
          : nothing}
        <div class="card-actions">
          <button class="btn btn--primary" ?disabled=${props.busy} @click=${props.onAdd}>
            ${icon("plus", { size: 14 })}
            <span>${props.busy ? "Saving..." : "Add job"}</span>
          </button>
        </div>
      </div>
    </section>

    <section class="card" style="margin-top: 20px;">
      <!-- Modern Table Header Card -->
      <div class="table-header-card">
        <div class="table-header-card__left">
          <div class="table-header-card__icon">
            ${icon("zap", { size: 22 })}
          </div>
          <div class="table-header-card__info">
            <div class="table-header-card__title">Jobs</div>
            <div class="table-header-card__subtitle">${props.jobs.length} scheduled job${props.jobs.length !== 1 ? "s" : ""}</div>
          </div>
        </div>
        <div class="table-header-card__right">
          <span class="badge ${props.jobs.filter((j) => j.enabled).length > 0 ? "badge--ok badge--animated" : "badge--muted"}">
            ${props.jobs.filter((j) => j.enabled).length} active
          </span>
        </div>
      </div>
      ${props.jobs.length === 0
        ? html`
          <div class="data-table__empty">
            <div class="data-table__empty-icon">${icon("clock", { size: 32 })}</div>
            <div class="data-table__empty-title">No jobs yet</div>
            <div class="data-table__empty-desc">Create a new scheduled job using the form above</div>
          </div>
        `
        : html`
            <div class="cron-jobs-list">
              ${props.jobs.map((job) => renderJob(job, props))}
            </div>
          `}
    </section>

    <section class="card" style="margin-top: 20px;">
      <!-- Modern Table Header Card -->
      <div class="table-header-card">
        <div class="table-header-card__left">
          <div class="table-header-card__icon">
            ${icon("scroll-text", { size: 22 })}
          </div>
          <div class="table-header-card__info">
            <div class="table-header-card__title">Run History</div>
            <div class="table-header-card__subtitle">${props.runsJobId ? `Runs for ${props.runsJobId}` : "Select a job to view history"}</div>
          </div>
        </div>
        ${props.runsJobId
          ? html`
              <div class="table-header-card__right">
                <span class="badge badge--muted">${props.runs.length} run${props.runs.length !== 1 ? "s" : ""}</span>
              </div>
            `
          : nothing}
      </div>
      ${props.runsJobId == null
        ? html`
            <div class="data-table__empty">
              <div class="data-table__empty-icon">${icon("scroll-text", { size: 32 })}</div>
              <div class="data-table__empty-title">No job selected</div>
              <div class="data-table__empty-desc">Click "Runs" on a job to see its execution history</div>
            </div>
          `
        : props.runs.length === 0
          ? html`
            <div class="data-table__empty">
              <div class="data-table__empty-icon">${icon("clock", { size: 32 })}</div>
              <div class="data-table__empty-title">No runs yet</div>
              <div class="data-table__empty-desc">This job hasn't been executed yet</div>
            </div>
          `
          : html`
              <div class="run-history-list">
                ${props.runs.map((entry) => renderRun(entry))}
              </div>
            `}
    </section>
  `;
}

function renderScheduleFields(props: CronProps) {
  const form = props.form;
  if (form.scheduleKind === "at") {
    return html`
      <label class="field" style="margin-top: 12px;">
        <span>Run at</span>
        <input
          type="datetime-local"
          .value=${form.scheduleAt}
          @input=${(e: Event) =>
            props.onFormChange({
              scheduleAt: (e.target as HTMLInputElement).value,
            })}
        />
      </label>
    `;
  }
  if (form.scheduleKind === "every") {
    return html`
      <div class="form-grid" style="margin-top: 12px;">
        <label class="field">
          <span>Every</span>
          <input
            .value=${form.everyAmount}
            @input=${(e: Event) =>
              props.onFormChange({
                everyAmount: (e.target as HTMLInputElement).value,
              })}
          />
        </label>
        <label class="field">
          <span>Unit</span>
          <select
            .value=${form.everyUnit}
            @change=${(e: Event) =>
              props.onFormChange({
                everyUnit: (e.target as HTMLSelectElement).value as CronFormState["everyUnit"],
              })}
          >
            <option value="minutes">Minutes</option>
            <option value="hours">Hours</option>
            <option value="days">Days</option>
          </select>
        </label>
      </div>
    `;
  }
  return html`
    <div class="form-grid" style="margin-top: 12px;">
      <label class="field">
        <span>Expression</span>
        <input
          .value=${form.cronExpr}
          placeholder="0 9 * * *"
          @input=${(e: Event) =>
            props.onFormChange({ cronExpr: (e.target as HTMLInputElement).value })}
        />
      </label>
      <label class="field">
        <span>Timezone (optional)</span>
        <input
          .value=${form.cronTz}
          placeholder="America/New_York"
          @input=${(e: Event) =>
            props.onFormChange({ cronTz: (e.target as HTMLInputElement).value })}
        />
      </label>
    </div>
  `;
}

function renderJob(job: CronJob, props: CronProps) {
  const isSelected = props.runsJobId === job.id;
  return html`
    <div
      class="cron-job-card cron-job-card--modern ${isSelected ? "cron-job-card--selected" : ""}"
      @click=${() => props.onLoadRuns(job.id)}
    >
      <div class="cron-job-card__header">
        <div class="cron-job-card__status-indicator ${job.enabled ? "cron-job-card__status-indicator--active" : ""}"></div>
        <div class="cron-job-card__info">
          <div class="cron-job-card__name">
            ${icon(job.enabled ? "play" : "pause", { size: 14 })}
            <span>${job.name}</span>
          </div>
          <div class="cron-job-card__schedule">${formatCronSchedule(job)}</div>
          <div class="cron-job-card__payload">${formatCronPayload(job)}</div>
          ${job.agentId ? html`<div class="cron-job-card__agent">Agent: ${job.agentId}</div>` : nothing}
          <div class="cron-job-card__meta">
            <span class="badge ${job.enabled ? "badge--ok badge--animated" : "badge--muted"}">
              ${icon(job.enabled ? "check" : "pause", { size: 10 })}
              <span>${job.enabled ? "enabled" : "disabled"}</span>
            </span>
            <span class="badge badge--info">${job.sessionTarget}</span>
            <span class="badge badge--muted">${job.wakeMode}</span>
          </div>
        </div>
        <div class="cron-job-card__actions">
          <div class="cron-job-card__state">
            ${formatCronState(job)}
          </div>
          <div class="row-actions row-actions--modern">
            <button
              class="row-actions__btn"
              title=${job.enabled ? "Disable" : "Enable"}
              ?disabled=${props.busy}
              @click=${(event: Event) => {
                event.stopPropagation();
                props.onToggle(job, !job.enabled);
              }}
            >
              ${icon(job.enabled ? "pause" : "play", { size: 14 })}
            </button>
            <button
              class="row-actions__btn row-actions__btn--primary"
              title="Run now"
              ?disabled=${props.busy}
              @click=${(event: Event) => {
                event.stopPropagation();
                props.onRun(job);
              }}
            >
              ${icon("zap", { size: 14 })}
            </button>
            <button
              class="row-actions__btn"
              title="View runs"
              ?disabled=${props.busy}
              @click=${(event: Event) => {
                event.stopPropagation();
                props.onLoadRuns(job.id);
              }}
            >
              ${icon("scroll-text", { size: 14 })}
            </button>
            <button
              class="row-actions__btn row-actions__btn--danger"
              title="Remove"
              ?disabled=${props.busy}
              @click=${(event: Event) => {
                event.stopPropagation();
                props.onRemove(job);
              }}
            >
              ${icon("trash", { size: 14 })}
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderRun(entry: CronRunLogEntry) {
  const isSuccess = entry.status === "ok" || entry.status === "skipped";
  return html`
    <div class="run-history-item run-history-item--modern">
      <div class="run-history-item__indicator ${isSuccess ? "run-history-item__indicator--ok" : "run-history-item__indicator--error"}"></div>
      <span class="run-history-item__status ${isSuccess ? "run-history-item__status--ok" : "run-history-item__status--error"}">
        ${icon(isSuccess ? "check" : "alert-circle", { size: 14 })}
        <span>${entry.status}</span>
      </span>
      <div class="run-history-item__summary">
        ${entry.summary ?? ""}
        ${entry.error ? html`<span class="run-history-item__error"> - ${entry.error}</span>` : nothing}
      </div>
      <div class="run-history-item__meta">
        <span class="run-history-item__timestamp">${formatMs(entry.ts)}</span>
        <span class="run-history-item__duration badge badge--muted">${entry.durationMs ?? 0}ms</span>
      </div>
    </div>
  `;
}
