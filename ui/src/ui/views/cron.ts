import { html, nothing } from "lit";
import { formatRelativeTimestamp, formatMs } from "../format.ts";
import { pathForTab } from "../navigation.ts";
import { formatCronSchedule, formatNextRun } from "../presenter.ts";
import type {
  ChannelUiMetaEntry,
  CronJob,
  CronRunLogEntry,
  CronStatus,
  OpsRuntimeFailureItem,
  OpsRuntimeRunItem,
  OpsRuntimeRunsResult,
} from "../types.ts";
import type { CronFormState, CronRuntimeRunsFilters } from "../ui-types.ts";

export type CronProps = {
  basePath: string;
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
  runtimeRunsLoading: boolean;
  runtimeRunsError: string | null;
  runtimeRunsFilters: CronRuntimeRunsFilters;
  runtimeRunsResult: OpsRuntimeRunsResult | null;
  onFormChange: (patch: Partial<CronFormState>) => void;
  onRefresh: () => void;
  onAdd: () => void;
  onToggle: (job: CronJob, enabled: boolean) => void;
  onRun: (job: CronJob) => void;
  onRemove: (job: CronJob) => void;
  onLoadRuns: (jobId: string) => void;
  onRuntimeFiltersChange: (patch: Partial<CronRuntimeRunsFilters>) => void;
  onRuntimeApply: () => void;
  onRuntimeRefresh: () => void;
  onRuntimeClear: () => void;
  onRuntimePreset: (preset: "1h" | "6h" | "24h" | "7d" | "clear") => void;
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
    return "last";
  }
  const meta = props.channelMeta?.find((entry) => entry.id === channel);
  if (meta?.label) {
    return meta.label;
  }
  return props.channelLabels?.[channel] ?? channel;
}

export function renderCron(props: CronProps) {
  const channelOptions = buildChannelOptions(props);
  const selectedJob =
    props.runsJobId == null ? undefined : props.jobs.find((job) => job.id === props.runsJobId);
  const selectedRunTitle = selectedJob?.name ?? props.runsJobId ?? "(select a job)";
  const orderedRuns = props.runs.toSorted((a, b) => b.ts - a.ts);
  const runtimeSummary = props.runtimeRunsResult?.summary;
  const runtimeRuns = props.runtimeRunsResult?.runs ?? [];
  const runtimeFailures = props.runtimeRunsResult?.failures ?? [];
  const supportsAnnounce =
    props.form.sessionTarget === "isolated" && props.form.payloadKind === "agentTurn";
  const selectedDeliveryMode =
    props.form.deliveryMode === "announce" && !supportsAnnounce ? "none" : props.form.deliveryMode;
  return html`
    <section class="grid grid-cols-2">
      <div class="card">
        <div class="card-title">Scheduler</div>
        <div class="card-sub">Gateway-owned cron scheduler status.</div>
        <div class="stat-grid" style="margin-top: 16px;">
          <div class="stat">
            <div class="stat-label">Enabled</div>
            <div class="stat-value">
              ${props.status ? (props.status.enabled ? "Yes" : "No") : "n/a"}
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">Jobs</div>
            <div class="stat-value">${props.status?.jobs ?? "n/a"}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Next wake</div>
            <div class="stat-value">${formatNextRun(props.status?.nextWakeAtMs ?? null)}</div>
          </div>
        </div>
        <div class="row" style="margin-top: 12px;">
          <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? "Refreshing…" : "Refresh"}
          </button>
          ${props.error ? html`<span class="muted">${props.error}</span>` : nothing}
        </div>
      </div>

      <div class="card">
        <div class="card-title">New Job</div>
        <div class="card-sub">Create a scheduled wakeup or agent run.</div>
        <div class="form-grid" style="margin-top: 16px;">
          <label class="field">
            <span>Name</span>
            <input
              .value=${props.form.name}
              @input=${(e: Event) =>
                props.onFormChange({ name: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="field">
            <span>Description</span>
            <input
              .value=${props.form.description}
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
            <span>Enabled</span>
            <input
              type="checkbox"
              .checked=${props.form.enabled}
              @change=${(e: Event) =>
                props.onFormChange({ enabled: (e.target as HTMLInputElement).checked })}
            />
          </label>
          <label class="field">
            <span>Schedule</span>
            <select
              .value=${props.form.scheduleKind}
              @change=${(e: Event) =>
                props.onFormChange({
                  scheduleKind: (e.target as HTMLSelectElement)
                    .value as CronFormState["scheduleKind"],
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
                  sessionTarget: (e.target as HTMLSelectElement)
                    .value as CronFormState["sessionTarget"],
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
              <option value="now">Now</option>
              <option value="next-heartbeat">Next heartbeat</option>
            </select>
          </label>
          <label class="field">
            <span>Payload</span>
            <select
              .value=${props.form.payloadKind}
              @change=${(e: Event) =>
                props.onFormChange({
                  payloadKind: (e.target as HTMLSelectElement)
                    .value as CronFormState["payloadKind"],
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
          ></textarea>
        </label>
        <div class="form-grid" style="margin-top: 12px;">
          <label class="field">
            <span>Delivery</span>
            <select
              .value=${selectedDeliveryMode}
              @change=${(e: Event) =>
                props.onFormChange({
                  deliveryMode: (e.target as HTMLSelectElement)
                    .value as CronFormState["deliveryMode"],
                })}
            >
              ${
                supportsAnnounce
                  ? html`
                      <option value="announce">Announce summary (default)</option>
                    `
                  : nothing
              }
              <option value="webhook">Webhook POST</option>
              <option value="none">None (internal)</option>
            </select>
          </label>
          ${
            props.form.payloadKind === "agentTurn"
              ? html`
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
                `
              : nothing
          }
          ${
            selectedDeliveryMode !== "none"
              ? html`
                  <label class="field">
                    <span>${selectedDeliveryMode === "webhook" ? "Webhook URL" : "Channel"}</span>
                    ${
                      selectedDeliveryMode === "webhook"
                        ? html`
                            <input
                              .value=${props.form.deliveryTo}
                              @input=${(e: Event) =>
                                props.onFormChange({
                                  deliveryTo: (e.target as HTMLInputElement).value,
                                })}
                              placeholder="https://example.invalid/cron"
                            />
                          `
                        : html`
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
                          `
                    }
                  </label>
                  ${
                    selectedDeliveryMode === "announce"
                      ? html`
                          <label class="field">
                            <span>To</span>
                            <input
                              .value=${props.form.deliveryTo}
                              @input=${(e: Event) =>
                                props.onFormChange({
                                  deliveryTo: (e.target as HTMLInputElement).value,
                                })}
                              placeholder="+1555… or chat id"
                            />
                          </label>
                        `
                      : nothing
                  }
                `
              : nothing
          }
        </div>
        <div class="row" style="margin-top: 14px;">
          <button class="btn primary" ?disabled=${props.busy} @click=${props.onAdd}>
            ${props.busy ? "Saving…" : "Add job"}
          </button>
        </div>
      </div>
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">Jobs</div>
      <div class="card-sub">All scheduled jobs stored in the gateway.</div>
      ${
        props.jobs.length === 0
          ? html`
              <div class="muted" style="margin-top: 12px">No jobs yet.</div>
            `
          : html`
            <div class="list" style="margin-top: 12px;">
              ${props.jobs.map((job) => renderJob(job, props))}
            </div>
          `
      }
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">Run history</div>
      <div class="card-sub">Latest runs for ${selectedRunTitle}.</div>
      ${
        props.runsJobId == null
          ? html`
              <div class="muted" style="margin-top: 12px">Select a job to inspect run history.</div>
            `
          : orderedRuns.length === 0
            ? html`
                <div class="muted" style="margin-top: 12px">No runs yet.</div>
              `
            : html`
              <div class="list" style="margin-top: 12px;">
                ${orderedRuns.map((entry) => renderRun(entry, props.basePath))}
              </div>
            `
      }
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">Runtime runs</div>
      <div class="card-sub">
        Cross-job history with failure aggregation (${runtimeSummary?.jobsScanned ?? 0}/${runtimeSummary?.jobsTotal ?? 0} jobs).
      </div>
      ${renderRuntimeRunsControls(props)}
      ${
        props.runtimeRunsError
          ? html`<div class="muted" style="margin-top: 10px">${props.runtimeRunsError}</div>`
          : nothing
      }
      ${
        runtimeSummary
          ? html`
              <div class="chip-row" style="margin-top: 12px;">
                <span class="chip">runs ${runtimeSummary.totalRuns}</span>
                <span class="chip chip-ok">ok ${runtimeSummary.okRuns}</span>
                <span class="chip ${runtimeSummary.errorRuns > 0 ? "chip-danger" : ""}">
                  error ${runtimeSummary.errorRuns}
                </span>
                <span class="chip">skipped ${runtimeSummary.skippedRuns}</span>
                <span class="chip ${runtimeSummary.timeoutRuns > 0 ? "chip-warn" : ""}">
                  timeout ${runtimeSummary.timeoutRuns}
                </span>
                <span class="chip ${runtimeSummary.needsAction > 0 ? "chip-danger" : ""}">
                  needsAction ${runtimeSummary.needsAction}
                </span>
              </div>
            `
          : nothing
      }
      <div class="grid grid-cols-2" style="margin-top: 12px;">
        <div class="card">
          <div class="card-title">Failures</div>
          <div class="card-sub">Jobs that currently look unhealthy.</div>
          ${
            runtimeFailures.length === 0
              ? html`
                  <div class="muted" style="margin-top: 12px">No failure rollups.</div>
                `
              : html`
                  <div class="list" style="margin-top: 12px;">
                    ${runtimeFailures.map((item) => renderRuntimeFailure(item))}
                  </div>
                `
          }
        </div>
        <div class="card">
          <div class="card-title">Runs</div>
          <div class="card-sub">Recent runs across cron jobs.</div>
          ${
            runtimeRuns.length === 0
              ? html`
                  <div class="muted" style="margin-top: 12px">No runs in selected range.</div>
                `
              : html`
                  <div class="list" style="margin-top: 12px;">
                    ${runtimeRuns.map((item) => renderRuntimeRun(item, props.basePath))}
                  </div>
                `
          }
        </div>
      </div>
    </section>
  `;
}

function renderRuntimeRunsControls(props: CronProps) {
  const filters = props.runtimeRunsFilters;
  return html`
    <div class="form-grid cron-runtime-filters" style="margin-top: 12px;">
      <label class="field">
        <span>Search</span>
        <input
          .value=${filters.search}
          placeholder="jobId / name / error / model"
          @input=${(event: Event) =>
            props.onRuntimeFiltersChange({
              search: (event.target as HTMLInputElement).value,
            })}
          @keydown=${(event: KeyboardEvent) => {
            if (event.key === "Enter") {
              event.preventDefault();
              props.onRuntimeApply();
            }
          }}
        />
      </label>
      <label class="field">
        <span>Status</span>
        <select
          .value=${filters.status}
          @change=${(event: Event) =>
            props.onRuntimeFiltersChange({
              status: (event.target as HTMLSelectElement).value as CronRuntimeRunsFilters["status"],
            })}
        >
          <option value="all">all</option>
          <option value="error">error</option>
          <option value="ok">ok</option>
          <option value="skipped">skipped</option>
        </select>
      </label>
      <label class="field">
        <span>From</span>
        <input
          type="datetime-local"
          .value=${filters.fromLocal}
          @change=${(event: Event) =>
            props.onRuntimeFiltersChange({
              fromLocal: (event.target as HTMLInputElement).value,
            })}
        />
      </label>
      <label class="field">
        <span>To</span>
        <input
          type="datetime-local"
          .value=${filters.toLocal}
          @change=${(event: Event) =>
            props.onRuntimeFiltersChange({
              toLocal: (event.target as HTMLInputElement).value,
            })}
        />
      </label>
      <label class="field">
        <span>Limit</span>
        <input
          .value=${filters.limit}
          @input=${(event: Event) =>
            props.onRuntimeFiltersChange({
              limit: (event.target as HTMLInputElement).value,
            })}
        />
      </label>
      <label class="field checkbox">
        <span>Include disabled</span>
        <input
          type="checkbox"
          .checked=${filters.includeDisabledCron}
          @change=${(event: Event) =>
            props.onRuntimeFiltersChange({
              includeDisabledCron: (event.target as HTMLInputElement).checked,
            })}
        />
      </label>
    </div>
    <div class="row" style="margin-top: 10px;">
      <button class="btn btn-sm" @click=${() => props.onRuntimePreset("1h")}>Last 1h</button>
      <button class="btn btn-sm" @click=${() => props.onRuntimePreset("6h")}>Last 6h</button>
      <button class="btn btn-sm" @click=${() => props.onRuntimePreset("24h")}>Last 24h</button>
      <button class="btn btn-sm" @click=${() => props.onRuntimePreset("7d")}>Last 7d</button>
      <button class="btn btn-sm" @click=${() => props.onRuntimePreset("clear")}>Clear range</button>
      <button class="btn primary btn-sm" ?disabled=${props.runtimeRunsLoading} @click=${props.onRuntimeApply}>
        ${props.runtimeRunsLoading ? "Loading…" : "Apply filters"}
      </button>
      <button class="btn btn-sm" ?disabled=${props.runtimeRunsLoading} @click=${props.onRuntimeRefresh}>
        Refresh
      </button>
      <button class="btn btn-sm" ?disabled=${props.runtimeRunsLoading} @click=${props.onRuntimeClear}>
        Reset filters
      </button>
    </div>
  `;
}

function renderRuntimeFailure(item: OpsRuntimeFailureItem) {
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${item.jobName}</div>
        <div class="list-sub">${item.jobId}</div>
        <div class="muted">
          lastStatus=${item.lastStatus ?? "n/a"} · consecutiveErrors=${item.consecutiveErrors}
        </div>
        ${item.lastError ? html`<div class="muted">lastError: ${item.lastError}</div>` : nothing}
      </div>
      <div class="list-meta">
        <div>${item.needsAction ? "needsAction" : "watch"}</div>
        <div class="muted">errors ${item.errors}</div>
        <div class="muted">timeouts ${item.timeoutErrors}</div>
        <div class="muted">runs ${item.totalRuns}</div>
        <div class="muted">${formatMs(item.lastErrorAtMs)}</div>
      </div>
    </div>
  `;
}

function renderRuntimeRun(item: OpsRuntimeRunItem, basePath: string) {
  const statusClass =
    item.status === "ok"
      ? "cron-job-status-ok"
      : item.status === "error"
        ? "cron-job-status-error"
        : "cron-job-status-skipped";
  const chatUrl =
    typeof item.sessionKey === "string" && item.sessionKey.trim().length > 0
      ? `${pathForTab("chat", basePath)}?session=${encodeURIComponent(item.sessionKey)}`
      : null;
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${item.jobName}</div>
        <div class="list-sub">${item.jobId}</div>
        <div class="muted">${item.summary ?? item.error ?? "-"}</div>
      </div>
      <div class="list-meta">
        <div><span class=${`cron-job-status-pill ${statusClass}`}>${item.status}</span></div>
        <div class="muted">${formatMs(item.ts)}</div>
        <div class="muted">${item.durationMs ?? 0}ms</div>
        ${
          chatUrl
            ? html`<div><a class="session-link" href=${chatUrl}>Open run chat</a></div>`
            : nothing
        }
      </div>
    </div>
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
          @input=${(e: Event) =>
            props.onFormChange({ cronExpr: (e.target as HTMLInputElement).value })}
        />
      </label>
      <label class="field">
        <span>Timezone (optional)</span>
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
  const itemClass = `list-item list-item-clickable cron-job${isSelected ? " list-item-selected" : ""}`;
  return html`
    <div class=${itemClass} @click=${() => props.onLoadRuns(job.id)}>
      <div class="list-main">
        <div class="list-title">${job.name}</div>
        <div class="list-sub">${formatCronSchedule(job)}</div>
        ${renderJobPayload(job)}
        ${job.agentId ? html`<div class="muted cron-job-agent">Agent: ${job.agentId}</div>` : nothing}
      </div>
      <div class="list-meta">
        ${renderJobState(job)}
      </div>
      <div class="cron-job-footer">
        <div class="chip-row cron-job-chips">
          <span class=${`chip ${job.enabled ? "chip-ok" : "chip-danger"}`}>
            ${job.enabled ? "enabled" : "disabled"}
          </span>
          <span class="chip">${job.sessionTarget}</span>
          <span class="chip">${job.wakeMode}</span>
        </div>
        <div class="row cron-job-actions">
          <button
            class="btn"
            ?disabled=${props.busy}
            @click=${(event: Event) => {
              event.stopPropagation();
              props.onToggle(job, !job.enabled);
            }}
          >
            ${job.enabled ? "Disable" : "Enable"}
          </button>
          <button
            class="btn"
            ?disabled=${props.busy}
            @click=${(event: Event) => {
              event.stopPropagation();
              props.onRun(job);
            }}
          >
            Run
          </button>
          <button
            class="btn"
            ?disabled=${props.busy}
            @click=${(event: Event) => {
              event.stopPropagation();
              props.onLoadRuns(job.id);
            }}
          >
            History
          </button>
          <button
            class="btn danger"
            ?disabled=${props.busy}
            @click=${(event: Event) => {
              event.stopPropagation();
              props.onRemove(job);
            }}
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderJobPayload(job: CronJob) {
  if (job.payload.kind === "systemEvent") {
    return html`<div class="cron-job-detail">
      <span class="cron-job-detail-label">System</span>
      <span class="muted cron-job-detail-value">${job.payload.text}</span>
    </div>`;
  }

  const delivery = job.delivery;
  const deliveryTarget =
    delivery?.mode === "webhook"
      ? delivery.to
        ? ` (${delivery.to})`
        : ""
      : delivery?.channel || delivery?.to
        ? ` (${delivery.channel ?? "last"}${delivery.to ? ` -> ${delivery.to}` : ""})`
        : "";

  return html`
    <div class="cron-job-detail">
      <span class="cron-job-detail-label">Prompt</span>
      <span class="muted cron-job-detail-value">${job.payload.message}</span>
    </div>
    ${
      delivery
        ? html`<div class="cron-job-detail">
            <span class="cron-job-detail-label">Delivery</span>
            <span class="muted cron-job-detail-value">${delivery.mode}${deliveryTarget}</span>
          </div>`
        : nothing
    }
  `;
}

function formatStateRelative(ms?: number) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return "n/a";
  }
  return formatRelativeTimestamp(ms);
}

function renderJobState(job: CronJob) {
  const status = job.state?.lastStatus ?? "n/a";
  const statusClass =
    status === "ok"
      ? "cron-job-status-ok"
      : status === "error"
        ? "cron-job-status-error"
        : status === "skipped"
          ? "cron-job-status-skipped"
          : "cron-job-status-na";
  const nextRunAtMs = job.state?.nextRunAtMs;
  const lastRunAtMs = job.state?.lastRunAtMs;

  return html`
    <div class="cron-job-state">
      <div class="cron-job-state-row">
        <span class="cron-job-state-key">Status</span>
        <span class=${`cron-job-status-pill ${statusClass}`}>${status}</span>
      </div>
      <div class="cron-job-state-row">
        <span class="cron-job-state-key">Next</span>
        <span class="cron-job-state-value" title=${formatMs(nextRunAtMs)}>
          ${formatStateRelative(nextRunAtMs)}
        </span>
      </div>
      <div class="cron-job-state-row">
        <span class="cron-job-state-key">Last</span>
        <span class="cron-job-state-value" title=${formatMs(lastRunAtMs)}>
          ${formatStateRelative(lastRunAtMs)}
        </span>
      </div>
    </div>
  `;
}

function renderRun(entry: CronRunLogEntry, basePath: string) {
  const chatUrl =
    typeof entry.sessionKey === "string" && entry.sessionKey.trim().length > 0
      ? `${pathForTab("chat", basePath)}?session=${encodeURIComponent(entry.sessionKey)}`
      : null;
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${entry.status}</div>
        <div class="list-sub">${entry.summary ?? ""}</div>
      </div>
      <div class="list-meta">
        <div>${formatMs(entry.ts)}</div>
        <div class="muted">${entry.durationMs ?? 0}ms</div>
        ${
          chatUrl
            ? html`<div><a class="session-link" href=${chatUrl}>Open run chat</a></div>`
            : nothing
        }
        ${entry.error ? html`<div class="muted">${entry.error}</div>` : nothing}
      </div>
    </div>
  `;
}
