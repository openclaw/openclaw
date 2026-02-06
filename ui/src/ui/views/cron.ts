import { msg } from "@lit/localize";
import { html, nothing } from "lit";
import type { ChannelUiMetaEntry, CronJob, CronRunLogEntry, CronStatus } from "../types.ts";
import type { CronFormState } from "../ui-types.ts";
import { formatMs } from "../format.ts";
import {
  formatCronPayload,
  formatCronSchedule,
  formatCronState,
  formatNextRun,
} from "../presenter.ts";

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
  const current = props.form.deliveryChannel?.trim();
  if (current && !options.includes(current)) {
    options.push(current);
  }
  const seen = new Set<string>();
  return options.filter((value) => {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}

function resolveChannelLabel(props: CronProps, channel: string): string {
  if (channel === "last") {
    return msg("last", { id: "cron.channel.last" });
  }
  const meta = props.channelMeta?.find((entry) => entry.id === channel);
  if (meta?.label) {
    return meta.label;
  }
  return props.channelLabels?.[channel] ?? channel;
}

export function renderCron(props: CronProps) {
  const channelOptions = buildChannelOptions(props);
  return html`
    <section class="grid grid-cols-2">
      <div class="card">
        <div class="card-title">${msg("Scheduler", { id: "cron.scheduler" })}</div>
        <div class="card-sub">${msg("Gateway-owned cron scheduler status.", { id: "cron.schedulerSub" })}</div>
        <div class="stat-grid" style="margin-top: 16px;">
          <div class="stat">
            <div class="stat-label">${msg("Enabled", { id: "cron.enabled" })}</div>
            <div class="stat-value">
              ${
                props.status
                  ? props.status.enabled
                    ? msg("Yes", { id: "cron.yes" })
                    : msg("No", { id: "cron.no" })
                  : msg("n/a", { id: "cron.na" })
              }
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">${msg("Jobs", { id: "cron.jobs" })}</div>
            <div class="stat-value">${props.status?.jobs ?? msg("n/a", { id: "cron.na" })}</div>
          </div>
          <div class="stat">
            <div class="stat-label">${msg("Next wake", { id: "cron.nextWake" })}</div>
            <div class="stat-value">${formatNextRun(props.status?.nextWakeAtMs ?? null)}</div>
          </div>
        </div>
        <div class="row" style="margin-top: 12px;">
          <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${
              props.loading
                ? msg("Refreshing…", { id: "cron.refreshing" })
                : msg("Refresh", { id: "cron.refresh" })
            }
          </button>
          ${props.error ? html`<span class="muted">${props.error}</span>` : nothing}
        </div>
      </div>

      <div class="card">
        <div class="card-title">${msg("New Job", { id: "cron.newJob" })}</div>
        <div class="card-sub">${msg("Create a scheduled wakeup or agent run.", { id: "cron.newJobSub" })}</div>
        <div class="form-grid" style="margin-top: 16px;">
          <label class="field">
            <span>${msg("Name", { id: "cron.name" })}</span>
            <input
              .value=${props.form.name}
              @input=${(e: Event) =>
                props.onFormChange({ name: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="field">
            <span>${msg("Description", { id: "cron.description" })}</span>
            <input
              .value=${props.form.description}
              @input=${(e: Event) =>
                props.onFormChange({ description: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="field">
            <span>${msg("Agent ID", { id: "cron.agentId" })}</span>
            <input
              .value=${props.form.agentId}
              @input=${(e: Event) =>
                props.onFormChange({ agentId: (e.target as HTMLInputElement).value })}
              placeholder=${msg("default", { id: "cron.default" })}
            />
          </label>
          <label class="field checkbox">
            <span>${msg("Enabled", { id: "cron.enabled" })}</span>
            <input
              type="checkbox"
              .checked=${props.form.enabled}
              @change=${(e: Event) =>
                props.onFormChange({ enabled: (e.target as HTMLInputElement).checked })}
            />
          </label>
          <label class="field">
            <span>${msg("Schedule", { id: "cron.schedule" })}</span>
            <select
              .value=${props.form.scheduleKind}
              @change=${(e: Event) =>
                props.onFormChange({
                  scheduleKind: (e.target as HTMLSelectElement)
                    .value as CronFormState["scheduleKind"],
                })}
            >
              <option value="every">${msg("Every", { id: "cron.scheduleEvery" })}</option>
              <option value="at">${msg("At", { id: "cron.scheduleAt" })}</option>
              <option value="cron">${msg("Cron", { id: "cron.scheduleCron" })}</option>
            </select>
          </label>
        </div>
        ${renderScheduleFields(props)}
        <div class="form-grid" style="margin-top: 12px;">
          <label class="field">
            <span>${msg("Session", { id: "cron.session" })}</span>
            <select
              .value=${props.form.sessionTarget}
              @change=${(e: Event) =>
                props.onFormChange({
                  sessionTarget: (e.target as HTMLSelectElement)
                    .value as CronFormState["sessionTarget"],
                })}
            >
              <option value="main">${msg("Main", { id: "cron.sessionMain" })}</option>
              <option value="isolated">${msg("Isolated", { id: "cron.sessionIsolated" })}</option>
            </select>
          </label>
          <label class="field">
            <span>${msg("Wake mode", { id: "cron.wakeMode" })}</span>
            <select
              .value=${props.form.wakeMode}
              @change=${(e: Event) =>
                props.onFormChange({
                  wakeMode: (e.target as HTMLSelectElement).value as CronFormState["wakeMode"],
                })}
            >
              <option value="next-heartbeat">${msg("Next heartbeat", { id: "cron.nextHeartbeat" })}</option>
              <option value="now">${msg("Now", { id: "cron.now" })}</option>
            </select>
          </label>
          <label class="field">
            <span>${msg("Payload", { id: "cron.payload" })}</span>
            <select
              .value=${props.form.payloadKind}
              @change=${(e: Event) =>
                props.onFormChange({
                  payloadKind: (e.target as HTMLSelectElement)
                    .value as CronFormState["payloadKind"],
                })}
            >
              <option value="systemEvent">${msg("System event", { id: "cron.payloadSystem" })}</option>
              <option value="agentTurn">${msg("Agent turn", { id: "cron.payloadAgent" })}</option>
            </select>
          </label>
        </div>
        <label class="field" style="margin-top: 12px;">
          <span>${
            props.form.payloadKind === "systemEvent"
              ? msg("System text", { id: "cron.payloadSystemText" })
              : msg("Agent message", { id: "cron.payloadAgentMessage" })
          }</span>
          <textarea
            .value=${props.form.payloadText}
            @input=${(e: Event) =>
              props.onFormChange({
                payloadText: (e.target as HTMLTextAreaElement).value,
              })}
            rows="4"
          ></textarea>
        </label>
        ${
          props.form.payloadKind === "agentTurn"
            ? html`
                <div class="form-grid" style="margin-top: 12px;">
                  <label class="field">
                    <span>${msg("Delivery", { id: "cron.delivery" })}</span>
                    <select
                      .value=${props.form.deliveryMode}
                      @change=${(e: Event) =>
                        props.onFormChange({
                          deliveryMode: (e.target as HTMLSelectElement)
                            .value as CronFormState["deliveryMode"],
                        })}
                    >
                      <option value="announce">
                        ${msg("Announce summary (default)", { id: "cron.deliveryAnnounce" })}
                      </option>
                      <option value="none">
                        ${msg("None (internal)", { id: "cron.deliveryNone" })}
                      </option>
                    </select>
                  </label>
                  <label class="field">
                    <span>${msg("Timeout (seconds)", { id: "cron.timeout" })}</span>
                    <input
                      .value=${props.form.timeoutSeconds}
                      @input=${(e: Event) =>
                        props.onFormChange({
                          timeoutSeconds: (e.target as HTMLInputElement).value,
                        })}
                    />
                  </label>
                  ${
                    props.form.deliveryMode === "announce"
                      ? html`
                          <label class="field">
                            <span>${msg("Channel", { id: "cron.channel" })}</span>
                            <select
                              .value=${props.form.deliveryChannel || "last"}
                              @change=${(e: Event) =>
                                props.onFormChange({
                                  deliveryChannel: (e.target as HTMLSelectElement).value,
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
                            <span>${msg("To", { id: "cron.to" })}</span>
                            <input
                              .value=${props.form.deliveryTo}
                              @input=${(e: Event) =>
                                props.onFormChange({
                                  deliveryTo: (e.target as HTMLInputElement).value,
                                })}
                              placeholder=${msg("+1555… or chat id", { id: "cron.toPlaceholder" })}
                            />
                          </label>
                        `
                      : nothing
                  }
                </div>
              `
            : nothing
        }
        <div class="row" style="margin-top: 14px;">
          <button class="btn primary" ?disabled=${props.busy} @click=${props.onAdd}>
            ${
              props.busy
                ? msg("Saving…", { id: "cron.saving" })
                : msg("Add job", { id: "cron.addJob" })
            }
          </button>
        </div>
      </div>
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">${msg("Jobs", { id: "cron.jobsTitle" })}</div>
      <div class="card-sub">${msg("All scheduled jobs stored in the gateway.", { id: "cron.jobsSub" })}</div>
      ${
        props.jobs.length === 0
          ? html`
              <div class="muted" style="margin-top: 12px">${msg("No jobs yet.", { id: "cron.noJobs" })}</div>
            `
          : html`
            <div class="list" style="margin-top: 12px;">
              ${props.jobs.map((job) => renderJob(job, props))}
            </div>
          `
      }
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">${msg("Run history", { id: "cron.runHistory" })}</div>
      <div class="card-sub">${msg("Latest runs for {job}.", {
        id: "cron.runHistorySub",
        args: { job: props.runsJobId ?? msg("(select a job)", { id: "cron.selectJob" }) },
      })}</div>
      ${
        props.runsJobId == null
          ? html`
              <div class="muted" style="margin-top: 12px">${msg("Select a job to inspect run history.", { id: "cron.selectJobHint" })}</div>
            `
          : props.runs.length === 0
            ? html`
                <div class="muted" style="margin-top: 12px">${msg("No runs yet.", { id: "cron.noRuns" })}</div>
              `
            : html`
              <div class="list" style="margin-top: 12px;">
                ${props.runs.map((entry) => renderRun(entry))}
              </div>
            `
      }
    </section>
  `;
}

function renderScheduleFields(props: CronProps) {
  const form = props.form;
  if (form.scheduleKind === "at") {
    return html`
      <label class="field" style="margin-top: 12px;">
        <span>${msg("Run at", { id: "cron.runAt" })}</span>
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
          <span>${msg("Every", { id: "cron.every" })}</span>
          <input
            .value=${form.everyAmount}
            @input=${(e: Event) =>
              props.onFormChange({
                everyAmount: (e.target as HTMLInputElement).value,
              })}
          />
        </label>
        <label class="field">
          <span>${msg("Unit", { id: "cron.unit" })}</span>
          <select
            .value=${form.everyUnit}
            @change=${(e: Event) =>
              props.onFormChange({
                everyUnit: (e.target as HTMLSelectElement).value as CronFormState["everyUnit"],
              })}
          >
            <option value="minutes">${msg("Minutes", { id: "cron.minutes" })}</option>
            <option value="hours">${msg("Hours", { id: "cron.hours" })}</option>
            <option value="days">${msg("Days", { id: "cron.days" })}</option>
          </select>
        </label>
      </div>
    `;
  }
  return html`
    <div class="form-grid" style="margin-top: 12px;">
      <label class="field">
        <span>${msg("Expression", { id: "cron.expression" })}</span>
        <input
          .value=${form.cronExpr}
          @input=${(e: Event) =>
            props.onFormChange({ cronExpr: (e.target as HTMLInputElement).value })}
        />
      </label>
      <label class="field">
        <span>${msg("Timezone (optional)", { id: "cron.timezoneOptional" })}</span>
        <input
          .value=${form.cronTz}
          @input=${(e: Event) =>
            props.onFormChange({ cronTz: (e.target as HTMLInputElement).value })}
        />
      </label>
    </div>
  `;
}

function renderJob(job: CronJob, props: CronProps) {
  const isSelected = props.runsJobId === job.id;
  const itemClass = `list-item list-item-clickable${isSelected ? " list-item-selected" : ""}`;
  return html`
    <div class=${itemClass} @click=${() => props.onLoadRuns(job.id)}>
      <div class="list-main">
        <div class="list-title">${job.name}</div>
        <div class="list-sub">${formatCronSchedule(job)}</div>
        <div class="muted">${formatCronPayload(job)}</div>
        ${job.agentId ? html`<div class="muted">${msg("Agent", { id: "cron.agent" })}: ${job.agentId}</div>` : nothing}
        <div class="chip-row" style="margin-top: 6px;">
          <span class="chip">${job.enabled ? msg("enabled", { id: "cron.enabledLower" }) : msg("disabled", { id: "cron.disabledLower" })}</span>
          <span class="chip">${job.sessionTarget}</span>
          <span class="chip">${job.wakeMode}</span>
        </div>
      </div>
      <div class="list-meta">
        <div>${formatCronState(job)}</div>
        <div class="row" style="justify-content: flex-end; margin-top: 8px;">
          <button
            class="btn"
            ?disabled=${props.busy}
            @click=${(event: Event) => {
              event.stopPropagation();
              props.onToggle(job, !job.enabled);
            }}
          >
            ${job.enabled ? msg("Disable", { id: "cron.disable" }) : msg("Enable", { id: "cron.enable" })}
          </button>
          <button
            class="btn"
            ?disabled=${props.busy}
            @click=${(event: Event) => {
              event.stopPropagation();
              props.onRun(job);
            }}
          >
            ${msg("Run", { id: "cron.run" })}
          </button>
          <button
            class="btn"
            ?disabled=${props.busy}
            @click=${(event: Event) => {
              event.stopPropagation();
              props.onLoadRuns(job.id);
            }}
          >
            ${msg("Runs", { id: "cron.runs" })}
          </button>
          <button
            class="btn danger"
            ?disabled=${props.busy}
            @click=${(event: Event) => {
              event.stopPropagation();
              props.onRemove(job);
            }}
          >
            ${msg("Remove", { id: "cron.remove" })}
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderRun(entry: CronRunLogEntry) {
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${entry.status}</div>
        <div class="list-sub">${entry.summary ?? ""}</div>
      </div>
      <div class="list-meta">
        <div>${formatMs(entry.ts)}</div>
        <div class="muted">${entry.durationMs ?? 0}ms</div>
        ${entry.error ? html`<div class="muted">${entry.error}</div>` : nothing}
      </div>
    </div>
  `;
}
