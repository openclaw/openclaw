import { html } from "lit";
import type {
  ClarityNightlyResult,
  ClarityProposalsResult,
  ClarityStatusResult,
  ClaritySummaryResult,
  ClarityTimelineResult,
} from "../types.ts";

export type ClarityViewProps = {
  loading: boolean;
  error: string | null;
  status: ClarityStatusResult | null;
  summary: ClaritySummaryResult | null;
  period: "daily" | "weekly" | "monthly" | "custom";
  timeline: ClarityTimelineResult | null;
  proposals: ClarityProposalsResult | null;
  nightly: ClarityNightlyResult | null;
  timelineLimit: number;
  timelineFilters: {
    q: string;
    source: string;
    eventType: string;
    status: string;
    since: string;
    until: string;
  };
  onPeriodChange: (period: "daily" | "weekly" | "monthly" | "custom") => void;
  onTimelineLimitChange: (limit: number) => void;
  onTimelineFilterChange: (
    patch: Partial<{
      q: string;
      source: string;
      eventType: string;
      status: string;
      since: string;
      until: string;
    }>,
  ) => void;
  onRunTimelineQuery: () => void;
  onRefresh: () => void;
  onSetProposalState: (
    key: string,
    state: "approved" | "in_progress" | "standby" | "blocked" | "done",
  ) => void;
};

function textValue(value: unknown, fallback = "n/a"): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

export function renderClarityOS(props: ClarityViewProps) {
  return html`
    <section class="grid grid-cols-3">
      <div class="card stat-card">
        <div class="stat-label">State</div>
        <div class="stat-value">${props.loading ? "Loading…" : ((props.status?.status as { state?: string } | undefined)?.state ?? "n/a") === "idle" ? "ready" : ((props.status?.status as { state?: string } | undefined)?.state ?? "n/a")}</div>
        <div class="muted">Last step: ${(props.status?.status as { step?: string } | undefined)?.step ?? "n/a"}</div>
        <div class="muted">Scheduler: ${(() => {
          const sched = (
            props.status as unknown as { scheduler?: { state?: string; next_runs_utc?: string[] } }
          )?.scheduler;
          if (!sched) {
            return "n/a";
          }
          const next = Array.isArray(sched.next_runs_utc) ? sched.next_runs_utc.join(", ") : "";
          const base = sched.state === "idle" ? "active (scheduled)" : (sched.state ?? "n/a");
          return next ? `${base} · next: ${next} UTC` : base;
        })()}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Events (${props.period})</div>
        <div class="stat-value">${props.summary?.event_count ?? "n/a"}</div>
        <div class="muted">Cost est: $${props.summary?.total_cost_estimate_usd ?? "0"}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Proposals</div>
        <div class="stat-value">${props.proposals?.items?.length ?? 0}</div>
        <div class="muted">Nightly reports: ${props.nightly?.count ?? 0}</div>
      </div>
    </section>

    <section class="card" style="margin-top: 14px;">
      <div class="row" style="justify-content: space-between; align-items: center; gap: 8px;">
        <div>
          <div class="card-title">ClarityOS Controls</div>
          <div class="card-sub">Timeline scope and summary period.</div>
        </div>
        <div class="row" style="gap:8px;">
          <select @change=${(e: Event) => props.onPeriodChange((e.target as HTMLSelectElement).value as "daily" | "weekly" | "monthly" | "custom")}>
            ${["daily", "weekly", "monthly", "custom"].map(
              (p) => html`<option value=${p} ?selected=${props.period === p}>${p}</option>`,
            )}
          </select>
          <input
            type="number"
            min="20"
            max="2000"
            .value=${String(props.timelineLimit)}
            @change=${(e: Event) => props.onTimelineLimitChange(Number((e.target as HTMLInputElement).value || 200))}
            style="width:110px"
          />
          <button class="btn" @click=${() => props.onRefresh()}>Refresh</button>
        </div>

      <div class="card" style="margin-top:10px;padding:10px;">
        <div class="muted">Timeline search filters</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;margin-top:8px;">
          <input placeholder="query" .value=${props.timelineFilters.q} @input=${(e: Event) => props.onTimelineFilterChange({ q: (e.target as HTMLInputElement).value })} />
          <input placeholder="source" .value=${props.timelineFilters.source} @input=${(e: Event) => props.onTimelineFilterChange({ source: (e.target as HTMLInputElement).value })} />
          <input placeholder="event type" .value=${props.timelineFilters.eventType} @input=${(e: Event) => props.onTimelineFilterChange({ eventType: (e.target as HTMLInputElement).value })} />
          <input placeholder="status" .value=${props.timelineFilters.status} @input=${(e: Event) => props.onTimelineFilterChange({ status: (e.target as HTMLInputElement).value })} />
          <input placeholder="since ISO" .value=${props.timelineFilters.since} @input=${(e: Event) => props.onTimelineFilterChange({ since: (e.target as HTMLInputElement).value })} />
          <input placeholder="until ISO" .value=${props.timelineFilters.until} @input=${(e: Event) => props.onTimelineFilterChange({ until: (e.target as HTMLInputElement).value })} />
        </div>
        <div class="row" style="margin-top:8px;gap:8px;"><button class="btn" @click=${() => props.onRunTimelineQuery()}>Run Query</button></div>
      </div>
      ${props.error ? html`<div class="callout danger" style="margin-top:10px;">${props.error}</div>` : ""}
    </section>



    <section class="card" style="margin-top: 14px;">
      <div class="card-title">Operating Mode</div>
      <div class="card-sub">Execution philosophy currently in effect.</div>
      ${(() => {
        const mode = (
          props.status as unknown as {
            status?: {
              extra?: { operating_mode?: { name?: string; rules?: string[]; safety?: string } };
            };
          }
        )?.status?.extra?.operating_mode;
        return html`
          <div style="margin-top:10px;"><strong>${mode?.name ?? "Standard"}</strong></div>
          <ul style="margin:8px 0 0 18px;">
            ${
              Array.isArray(mode?.rules) && mode?.rules.length
                ? mode.rules.map((r) => html`<li>${r}</li>`)
                : html`
                    <li>Deliver outcomes with high initiative.</li>
                  `
            }
          </ul>
          <div class="muted" style="margin-top:6px;">Safety: ${mode?.safety ?? "Always respect safety and privacy boundaries."}</div>
        `;
      })()}
    </section>

    <section class="card" style="margin-top: 14px;">
      <div class="card-title">Current Work</div>
      <div class="card-sub">Live implementation status, ETA, and milestones. Auto-refreshes while this tab is open.</div>
      ${(() => {
        const st = (
          props.status as unknown as {
            status?: {
              step?: string;
              extra?: {
                current_task?: string;
                started_at_utc?: string;
                eta_minutes?: number;
                eta_range?: string;
                progress_percent?: number;
                next_milestones?: string[];
              };
            };
          }
        )?.status;
        const ex = st?.extra;
        return html`
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-top:10px;">
            <div class="card" style="margin:0;padding:10px;">
              <div class="muted">Now working on</div>
              <div><strong>${ex?.current_task ?? st?.step ?? "n/a"}</strong></div>
            </div>
            <div class="card" style="margin:0;padding:10px;">
              <div class="muted">ETA</div>
              <div><strong>${ex?.eta_range ?? (typeof ex?.eta_minutes === "number" ? `${ex.eta_minutes} min` : "n/a")}</strong></div>
            </div>
            <div class="card" style="margin:0;padding:10px;">
              <div class="muted">Progress</div>
              <div><strong>${typeof ex?.progress_percent === "number" ? `${ex.progress_percent}%` : "n/a"}</strong></div>
              <div style="margin-top:8px;height:10px;border-radius:999px;background:#1b2647;border:1px solid #2c3b6b;overflow:hidden;">
                <div style=${`height:100%;width:${Math.max(0, Math.min(100, Number(ex?.progress_percent ?? 0)))}%;background:linear-gradient(90deg,#3bb2ff,#2fd07f);transition:width .35s ease;`}></div>
              </div>
            </div>
            <div class="card" style="margin:0;padding:10px;">
              <div class="muted">Started (UTC)</div>
              <div><strong>${ex?.started_at_utc ?? "n/a"}</strong></div>
            </div>
          </div>
          <div class="card" style="margin-top:10px;padding:10px;">
            <div class="muted">Next milestones</div>
            <ul style="margin:8px 0 0 18px;">
              ${
                Array.isArray(ex?.next_milestones) && ex?.next_milestones.length
                  ? ex.next_milestones.map((m) => html`<li>${m}</li>`)
                  : html`
                      <li>n/a</li>
                    `
              }
            </ul>
          </div>
        `;
      })()}
    </section>

    <section class="grid grid-cols-2" style="margin-top: 14px;">
      <div class="card">
        <div class="card-title">Proposal / Standby Board</div>
        <div class="card-sub">Current proposal states.</div>
        <div style="display:grid;gap:8px;margin-top:8px;max-height:300px;overflow:auto;">
          ${(props.proposals?.items ?? []).map((item) => {
            const stateValue = (item.state ?? "n/a").toLowerCase();
            const stateColor =
              stateValue === "approved"
                ? "#2fbf71"
                : stateValue === "in_progress"
                  ? "#4da3ff"
                  : stateValue === "standby"
                    ? "#f5a524"
                    : stateValue === "blocked"
                      ? "#ff5d5d"
                      : "#9aa7c7";
            return html`
            <div style="border:1px solid var(--border-color,#2b375f);border-radius:10px;padding:10px;background:linear-gradient(180deg, rgba(255,255,255,0.01), rgba(255,255,255,0));">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                <div><strong>${item.title ?? item.proposal_key ?? "proposal"}</strong></div>
                <span style="padding:2px 8px;border-radius:999px;background:${stateColor}22;border:1px solid ${stateColor}66;color:${stateColor};font-size:12px;font-weight:700;letter-spacing:.2px;">${stateValue.replace("_", " ").toUpperCase()}</span>
              </div>
              <div class="muted">key: ${item.proposal_key ?? "n/a"}</div>
              <div class="muted">priority: ${(item as { priority?: string }).priority ?? "n/a"} • owner: ${(item as { owner?: string }).owner ?? "n/a"} • eta: ${(item as { eta?: string }).eta ?? "n/a"}</div>
              <div class="muted">notes: ${(item as { notes?: string }).notes ?? "-"}</div>
              <div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap;">
                ${["approved", "in_progress", "standby", "blocked", "done"].map((st) => {
                  const active = st === stateValue;
                  const style = active
                    ? `background:${stateColor};border-color:${stateColor};color:#081225;font-weight:700;`
                    : "";
                  return html`<button class="btn btn-sm" style=${style} @click=${() => item.proposal_key && props.onSetProposalState(item.proposal_key, st as "approved" | "in_progress" | "standby" | "blocked" | "done")}>${st.replace("_", " ")}</button>`;
                })}
              </div>
            </div>
          `;
          })}
        </div>
      </div>
      <div class="card">
        <div class="card-title">Nightly Self-Improvement</div>
        <div class="card-sub">Last night execution + upcoming night plan.</div>
        <div style="display:grid;gap:8px;">
          <div><strong>Last night</strong><pre class="mono" style="max-height:160px;overflow:auto;">${JSON.stringify((props.nightly as { combined?: { last_night?: unknown } } | null)?.combined?.last_night ?? props.nightly?.latest ?? {}, null, 2)}</pre></div>
          <div><strong>Upcoming night</strong><pre class="mono" style="max-height:160px;overflow:auto;">${JSON.stringify((props.nightly as { combined?: { upcoming_night?: unknown }; nextPlan?: unknown } | null)?.combined?.upcoming_night ?? (props.nightly as { nextPlan?: unknown } | null)?.nextPlan ?? {}, null, 2)}</pre></div>
        </div>
      </div>
    </section>


    <section class="grid grid-cols-2" style="margin-top: 14px;">
      <div class="card">
        <div class="card-title">Execution Control</div>
        <div class="card-sub">Lease/watchdog health for active milestone.</div>
        ${(() => {
          const wd =
            (
              props.status as unknown as {
                status?: { extra?: { watchdog?: Record<string, unknown> } };
              }
            )?.status?.extra?.watchdog ?? {};
          return html`
            <div class="muted">State: <strong>${textValue(wd["state"])}</strong></div>
            <div class="muted">Reason: ${textValue(wd["reason"])}</div>
            <div class="muted">Active milestone: ${textValue(wd["active_milestone_key"])}</div>
            <div class="muted">Last code change: ${textValue(wd["last_code_change_ts"])}</div>
            <div class="muted">Last build/test: ${textValue(wd["last_build_or_test_ts"])}</div>
            <div class="muted">Checkpoint due: ${textValue(wd["next_checkpoint_due_ts"])}</div>
          `;
        })()}
      </div>

      <div class="card">
        <div class="card-title">Validation Gate</div>
        <div class="card-sub">Completion readiness before done.</div>
        ${(() => {
          const tasks = (
            ((props.timeline?.timeline ?? []) as Array<Record<string, unknown>>) || []
          ).filter((r) => textValue(r["source"], "").includes("clarity"));
          const hasRecent = tasks.length > 0;
          const st =
            (
              props.status as unknown as {
                status?: { extra?: { watchdog?: Record<string, unknown> } };
              }
            )?.status?.extra?.watchdog?.state ?? "n/a";
          return html`
            <div class="muted">Watchdog healthy: <strong>${st === "running" ? "yes" : "no"}</strong></div>
            <div class="muted">Recent orchestration evidence: <strong>${hasRecent ? "present" : "limited"}</strong></div>
            <div class="muted">Rule: validator signoff required before done.</div>
          `;
        })()}
      </div>
    </section>

    <section class="card" style="margin-top: 14px;">
      <div class="card-title">Recovery Timeline</div>
      <div class="card-sub">Recent reliability-related transitions/events.</div>
      ${(() => {
        const rows = ((props.timeline?.timeline ?? []) as Array<Record<string, unknown>>)
          .filter((r) => {
            const t = textValue(r["summary"], "").toLowerCase();
            const st = textValue(r["status"], "").toLowerCase();
            return t.includes("stalled") || t.includes("recover") || st === "error";
          })
          .slice(0, 20);
        if (!rows.length) {
          return html`
            <div class="muted">No recent recovery events detected in current timeline window.</div>
          `;
        }
        return html`<pre class="mono" style="max-height:220px;overflow:auto;">${JSON.stringify(rows, null, 2)}</pre>`;
      })()}
    </section>


    <section class="card" style="margin-top: 14px;">
      <div class="card-title">Timeline (latest)</div>
      <div class="card-sub">Showing up to ${props.timeline?.limit ?? props.timelineLimit} entries.</div>
      <pre class="mono" style="max-height:360px;overflow:auto;">${JSON.stringify(props.timeline?.timeline ?? [], null, 2)}</pre>
    </section>
  `;
}
