import { html, nothing } from "lit";
import type { AgentsListResult, CronJob, CronRunLogEntry, SessionsListResult } from "../types.ts";

const QUEUE_PREFIX = "queue:";

type SessionRow = {
  key: string;
  label?: string | null;
  agentId?: string | null;
  updatedAt?: number | null;
};

function formatWhen(ms: number | null | undefined): string {
  if (!ms) {
    return "";
  }
  const d = new Date(ms);
  return d.toLocaleString();
}

function isQueuedJob(job: CronJob, agentId: string): boolean {
  const name = (job.name ?? "").toLowerCase();
  return name.startsWith(`${QUEUE_PREFIX}${agentId.toLowerCase()}:`);
}

export type AgentsRunnerProps = {
  agentsList: AgentsListResult | null;
  sessions: SessionsListResult | null;
  cronJobs: CronJob[];
  cronRunsJobId: string | null;
  cronRuns: CronRunLogEntry[];
  busy: boolean;
  onQueueTask: (agentId: string, task: string) => void;
  onRunJob: (job: CronJob) => void;
  onDisableJob: (job: CronJob) => void;
  onRemoveJob: (job: CronJob) => void;
  onLoadRuns: (jobId: string) => void;
  onOpenSession: (sessionKey: string) => void;
};

export function renderAgentsRunner(props: AgentsRunnerProps) {
  const agents = props.agentsList?.agents ?? [];

  return html`
    <div class="card" style="margin-top: 12px;">
      <div class="row" style="justify-content: space-between; align-items: baseline;">
        <div>
          <div class="card-title">Agent runner</div>
          <div class="card-sub">Queue tasks per agent (cron-backed) and see recent activity.</div>
        </div>
      </div>

      ${
        agents.length === 0
          ? html`
              <div class="muted" style="margin-top: 12px">No agents configured.</div>
            `
          : html`
            <div class="table" style="margin-top: 12px;">
              <div class="table-row table-header">
                <div>Agent</div>
                <div>Recent session</div>
                <div>Queue</div>
                <div>Actions</div>
              </div>
              ${agents.map((agent) => {
                const agentId = agent.id;
                const queued = props.cronJobs.filter((job) => isQueuedJob(job, agentId));

                const allSessions = (props.sessions?.sessions ?? []) as unknown as SessionRow[];
                const recentSessions = allSessions.filter((entry) => entry?.agentId === agentId);
                const recent = recentSessions[0] ?? null;

                const recentKey = recent?.key ?? null;
                const recentLabel = recent?.label ?? recentKey;
                const recentUpdatedAt =
                  typeof recent?.updatedAt === "number" ? recent.updatedAt : null;

                return html`
                  <div class="table-row" style="align-items: start;">
                    <div>
                      <div style="font-weight: 600;">${agent.label ?? agent.id}</div>
                      <div class="mono muted" style="font-size: 12px;">${agentId}</div>
                    </div>

                    <div>
                      ${
                        recentKey
                          ? html`
                            <button class="btn btn--sm" @click=${() => props.onOpenSession(recentKey)}>
                              Open
                            </button>
                            <div style="margin-top: 6px;">
                              <div>${recentLabel}</div>
                              <div class="muted" style="font-size: 12px;">Updated: ${formatWhen(
                                recentUpdatedAt,
                              )}</div>
                            </div>
                          `
                          : html`
                              <div class="muted">No recent sessions.</div>
                            `
                      }
                    </div>

                    <div>
                      ${
                        queued.length === 0
                          ? html`
                              <div class="muted">Empty</div>
                            `
                          : html`
                            <div style="display:flex; flex-direction: column; gap: 8px;">
                              ${queued.slice(0, 5).map((job) => {
                                const nextRunAt = job.state?.nextRunAtMs ?? null;
                                return html`
                                  <div class="callout" style="padding: 10px;">
                                    <div style="display:flex; justify-content: space-between; gap: 12px;">
                                      <div style="min-width:0;">
                                        <div style="font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${
                                          job.name
                                        }</div>
                                        <div class="muted" style="font-size: 12px;">Next: ${
                                          nextRunAt ? formatWhen(nextRunAt) : "—"
                                        }</div>
                                      </div>
                                      <div style="display:flex; gap: 6px; flex-wrap: wrap; justify-content:flex-end;">
                                        <button class="btn btn--sm" ?disabled=${props.busy} @click=${() => props.onRunJob(job)}>
                                          Run
                                        </button>
                                        <button class="btn btn--sm" ?disabled=${props.busy} @click=${() => props.onDisableJob(job)}>
                                          Disable
                                        </button>
                                        <button class="btn btn--sm btn--danger" ?disabled=${props.busy} @click=${() => props.onRemoveJob(job)}>
                                          Remove
                                        </button>
                                      </div>
                                    </div>
                                    <div style="margin-top: 8px;">
                                      <button class="btn btn--xs" @click=${() => props.onLoadRuns(job.id)}>View runs</button>
                                      ${
                                        props.cronRunsJobId === job.id
                                          ? html`
                                            <div class="mono muted" style="margin-top: 6px; font-size: 11px;">
                                              ${props.cronRuns.slice(0, 3).map(
                                                (r) =>
                                                  html`<div>
                                                  • ${r.status ?? ""} ${
                                                    r.ts ? formatWhen(r.ts) : ""
                                                  }
                                                </div>`,
                                              )}
                                            </div>
                                          `
                                          : nothing
                                      }
                                    </div>
                                  </div>
                                `;
                              })}
                              ${
                                queued.length > 5
                                  ? html`<div class="muted" style="font-size: 12px;">+${queued.length - 5} more…</div>`
                                  : nothing
                              }
                            </div>
                          `
                      }
                    </div>

                    <div>
                      <form
                        @submit=${(e: Event) => {
                          e.preventDefault();
                          const form = e.target as HTMLFormElement;
                          const input = form.querySelector("input");
                          const task = input?.value?.trim() ?? "";
                          if (!task) {
                            return;
                          }
                          props.onQueueTask(agentId, task);
                          if (input) {
                            input.value = "";
                          }
                        }}
                      >
                        <input
                          class="input"
                          style="width: 100%;"
                          placeholder="Add a task to the queue…"
                          ?disabled=${props.busy}
                        />
                        <button class="btn btn--sm" style="margin-top: 8px;" type="submit" ?disabled=${props.busy}>
                          Queue task
                        </button>
                      </form>
                    </div>
                  </div>
                `;
              })}
            </div>
          `
      }
    </div>
  `;
}
