import { html, nothing } from "lit";
import type {
  ClawArtifactEntry,
  ClawAuditEntry,
  ClawDecisionAction,
  ClawControlState,
  ClawInboxItem,
  ClawMissionDetail,
  ClawMissionSummary,
  ClawPendingDecision,
  ClawPreflightCheck,
} from "../../../../src/shared/claw-types.js";

export type ClawAuditFilters = {
  role: string;
  toolName: string;
  sideEffectClass: string;
  outcome: string;
};

export type ClawViewProps = {
  loading: boolean;
  error: string | null;
  createBusy: boolean;
  actionBusy: boolean;
  goalDraft: string;
  missions: ClawMissionSummary[];
  mission: ClawMissionDetail | null;
  selectedMissionId: string | null;
  control: ClawControlState | null;
  inbox: ClawInboxItem[];
  auditLoading: boolean;
  auditEntries: ClawAuditEntry[];
  auditFilters: ClawAuditFilters;
  artifactsLoading: boolean;
  artifacts: ClawArtifactEntry[];
  onGoalDraftChange: (value: string) => void;
  onCreateMission: () => void;
  onSelectMission: (missionId: string) => void;
  onApproveMission: (missionId: string) => void;
  onPauseMission: (missionId: string) => void;
  onResumeMission: (missionId: string) => void;
  onCancelMission: (missionId: string) => void;
  onRerunPreflight: (missionId: string) => void;
  onReplyDecision: (missionId: string, decisionId: string, action: ClawDecisionAction) => void;
  onPauseAll: () => void;
  onSetAuditFilter: (key: keyof ClawAuditFilters, value: string) => void;
  onStopAllNow: () => void;
  onSetAutonomy: (enabled: boolean) => void;
  onRefresh: () => void;
};

function formatDate(value?: string | null): string {
  if (!value) {
    return "n/a";
  }
  return new Date(value).toLocaleString();
}

function resolveDecisionActions(decision: ClawPendingDecision): ClawDecisionAction[] {
  switch (decision.kind) {
    case "start_approval":
      return ["approve", "cancel"];
    case "preflight_blocker":
      return [];
    case "recovery_uncertain":
      return ["continue", "pause", "cancel"];
    default:
      return ["continue", "pause", "cancel"];
  }
}

function formatDecisionAction(action: ClawDecisionAction): string {
  switch (action) {
    case "approve":
      return "Approve";
    case "reject":
      return "Reject";
    case "pause":
      return "Pause";
    case "cancel":
      return "Cancel";
    case "continue":
      return "Continue";
    default:
      return action;
  }
}

function renderDecision(
  missionId: string,
  decision: ClawPendingDecision,
  actionBusy: boolean,
  onReplyDecision: (missionId: string, decisionId: string, action: ClawDecisionAction) => void,
) {
  return html`
    <li>
      <strong>${decision.title}</strong> (${decision.status})
      <div class="card-sub">${decision.summary}</div>
      ${decision.status === "pending"
        ? html`
            <div class="row" style="gap: 8px; flex-wrap: wrap; margin-top: 8px;">
              ${resolveDecisionActions(decision).map(
                (action) => html`
                  <button
                    class="btn ${action === "cancel" ? "btn--danger" : "btn--subtle"}"
                    ?disabled=${actionBusy}
                    @click=${() => onReplyDecision(missionId, decision.id, action)}
                  >
                    ${formatDecisionAction(action)}
                  </button>
                `,
              )}
            </div>
          `
        : nothing}
    </li>
  `;
}

function renderPreflight(check: ClawPreflightCheck) {
  return html`
    <li>
      <strong>${check.title}</strong> (${check.status})
      <div class="card-sub">${check.summary}</div>
      ${check.detail ? html`<div class="card-sub">${check.detail}</div>` : nothing}
    </li>
  `;
}

function renderAuditEntry(entry: ClawAuditEntry) {
  const metadata = [
    entry.role ?? null,
    entry.phase ?? null,
    entry.sideEffectClass ?? null,
    entry.outcome ?? null,
    entry.toolName ? `tool:${entry.toolName}` : null,
  ].filter((value): value is string => Boolean(value));

  return html`
    <li>
      <strong>${entry.summary}</strong>
      <div class="card-sub">${entry.type} | ${formatDate(entry.at)}</div>
      ${metadata.length > 0 ? html`<div class="card-sub">${metadata.join(" | ")}</div>` : nothing}
      ${entry.detail ? html`<div class="card-sub">${entry.detail}</div>` : nothing}
    </li>
  `;
}

function renderArtifact(entry: ClawArtifactEntry) {
  return html`
    <li>
      <strong>${entry.name}</strong>
      <div class="card-sub">
        ${entry.kind}${entry.updatedAt ? html` | ${formatDate(entry.updatedAt)}` : nothing}
        ${typeof entry.sizeBytes === "number" ? html` | ${entry.sizeBytes} bytes` : nothing}
      </div>
      <div class="card-sub">${entry.path}</div>
    </li>
  `;
}

function resolveAuditFilterOptions(
  entries: readonly ClawAuditEntry[],
  key: keyof Pick<ClawAuditEntry, "role" | "toolName" | "sideEffectClass" | "outcome">,
): string[] {
  return [
    ...new Set(
      entries.map((entry) => entry[key]).filter((value): value is string => Boolean(value)),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}

function renderTextList(items: readonly string[]) {
  return html`
    <ul style="padding-left: 18px;">
      ${items.map((item) => html`<li>${item}</li>`)}
    </ul>
  `;
}

export function renderClaw(props: ClawViewProps) {
  const mission = props.mission;
  const hasPendingRecoveryUncertain =
    mission?.decisions.some(
      (decision) => decision.kind === "recovery_uncertain" && decision.status === "pending",
    ) ?? false;
  const canApprove = mission?.status === "awaiting_approval";
  const canPause =
    mission != null &&
    ["queued", "running", "recovering", "verifying", "blocked"].includes(mission.status);
  const canResume =
    mission != null &&
    ["paused", "blocked"].includes(mission.status) &&
    !hasPendingRecoveryUncertain;
  const canCancel = mission != null && !["done", "failed", "cancelled"].includes(mission.status);
  const canRerunPreflight =
    mission != null &&
    ["awaiting_setup", "awaiting_approval", "paused", "blocked"].includes(mission.status);

  const filteredAuditEntries = props.auditEntries.filter((entry) => {
    if (props.auditFilters.role && entry.role !== props.auditFilters.role) {
      return false;
    }
    if (props.auditFilters.toolName && entry.toolName !== props.auditFilters.toolName) {
      return false;
    }
    if (
      props.auditFilters.sideEffectClass &&
      entry.sideEffectClass !== props.auditFilters.sideEffectClass
    ) {
      return false;
    }
    if (props.auditFilters.outcome && entry.outcome !== props.auditFilters.outcome) {
      return false;
    }
    return true;
  });

  const auditRoleOptions = resolveAuditFilterOptions(props.auditEntries, "role");
  const auditToolOptions = resolveAuditFilterOptions(props.auditEntries, "toolName");
  const auditSideEffectOptions = resolveAuditFilterOptions(props.auditEntries, "sideEffectClass");
  const auditOutcomeOptions = resolveAuditFilterOptions(props.auditEntries, "outcome");

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; margin-bottom: 12px;">
        <div>
          <div class="card-title">Claw Missions</div>
          <div class="card-sub">
            Goal-oriented mission intake, preflight, unattended-continuation approval, and
            continuous execution state.
          </div>
        </div>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      <div class="grid" style="grid-template-columns: 1.1fr 1.4fr; gap: 16px;">
        <div class="stack" style="gap: 16px;">
          <section class="panel">
            <div class="card-title">New Goal</div>
            <textarea
              class="input"
              rows="6"
              placeholder="Describe the goal you want Claw to execute."
              .value=${props.goalDraft}
              @input=${(event: Event) =>
                props.onGoalDraftChange((event.target as HTMLTextAreaElement).value)}
            ></textarea>
            <div class="row" style="justify-content: flex-end; margin-top: 12px;">
              <button
                class="btn"
                ?disabled=${props.createBusy || !props.goalDraft.trim()}
                @click=${props.onCreateMission}
              >
                ${props.createBusy ? "Creating..." : "Create Mission"}
              </button>
            </div>
          </section>

          <section class="panel">
            <div class="card-title">Controls</div>
            <div class="card-sub">
              Autonomy: ${props.control?.autonomyEnabled ? "enabled" : "disabled"} | Pause all:
              ${props.control?.pauseAll ? "on" : "off"}
            </div>
            ${props.control?.stopAllNowRequestedAt
              ? html`
                  <div class="card-sub" style="margin-top: 8px;">
                    Emergency stop requested at ${formatDate(props.control.stopAllNowRequestedAt)}.
                  </div>
                `
              : nothing}
            <div class="row" style="gap: 8px; flex-wrap: wrap; margin-top: 12px;">
              <button
                class="btn btn--subtle"
                ?disabled=${props.actionBusy}
                @click=${props.onPauseAll}
              >
                ${props.control?.pauseAll ? "Resume All" : "Pause All"}
              </button>
              <button
                class="btn btn--danger"
                ?disabled=${props.actionBusy}
                @click=${props.onStopAllNow}
              >
                Stop All Now
              </button>
              <button
                class="btn btn--subtle"
                ?disabled=${props.actionBusy}
                @click=${() => props.onSetAutonomy(!(props.control?.autonomyEnabled ?? true))}
              >
                ${props.control?.autonomyEnabled ? "Autonomy Off" : "Autonomy On"}
              </button>
            </div>
          </section>

          <section class="panel">
            <div class="card-title">Inbox</div>
            ${props.inbox.length === 0
              ? html`<div class="card-sub">No pending operator items.</div>`
              : html`
                  <ul class="stack" style="gap: 10px; padding-left: 18px;">
                    ${props.inbox.map(
                      (item) => html`
                        <li>
                          <strong>${item.title}</strong>
                          <div class="card-sub">${item.missionTitle}: ${item.summary}</div>
                        </li>
                      `,
                    )}
                  </ul>
                `}
          </section>

          <section class="panel">
            <div class="card-title">Mission List</div>
            ${props.missions.length === 0
              ? html`<div class="card-sub">No missions yet.</div>`
              : html`
                  <div class="stack" style="gap: 8px;">
                    ${props.missions.map(
                      (entry) => html`
                        <button
                          class="btn btn--subtle"
                          style="justify-content: space-between; width: 100%; text-align: left;"
                          data-selected=${entry.id === props.selectedMissionId}
                          @click=${() => props.onSelectMission(entry.id)}
                        >
                          <span>
                            <strong>${entry.title}</strong>
                            <div class="card-sub">
                              ${entry.status}${entry.continuationPhase
                                ? html` | phase: ${entry.continuationPhase}`
                                : nothing}
                            </div>
                          </span>
                          ${entry.requiresAttention ? html`<span>Needs Attention</span>` : nothing}
                        </button>
                      `,
                    )}
                  </div>
                `}
          </section>
        </div>

        <div class="stack" style="gap: 16px;">
          <section class="panel">
            <div class="card-title">${mission?.title ?? "Mission Detail"}</div>
            ${props.error
              ? html`<div class="card-sub" style="color: var(--danger, #d14);">${props.error}</div>`
              : nothing}
            ${!mission
              ? html`<div class="card-sub">
                  Select a mission to inspect its packet, readiness, and continuation controls.
                </div>`
              : html`
                  <div class="stack" style="gap: 12px;">
                    <div class="card-sub">${mission.goal}</div>
                    ${mission.status === "awaiting_approval"
                      ? html`
                          <div class="card-sub">
                            Packet planning and preflight may already have inspected or changed
                            state. Approval lets Claw continue autonomously without routine
                            check-ins.
                          </div>
                        `
                      : nothing}
                    <div class="grid" style="grid-template-columns: 1fr 1fr; gap: 10px;">
                      <div><strong>Status:</strong> ${mission.status}</div>
                      <div>
                        <strong>Continuation Phase:</strong>
                        ${mission.continuationPhase ?? "n/a"}
                      </div>
                      <div><strong>Current Step:</strong> ${mission.currentStep ?? "n/a"}</div>
                      <div><strong>Created:</strong> ${formatDate(mission.createdAt)}</div>
                      <div><strong>Updated:</strong> ${formatDate(mission.updatedAt)}</div>
                      <div><strong>Workspace:</strong> ${mission.workspaceDir}</div>
                      <div><strong>Mission Dir:</strong> ${mission.missionDir}</div>
                      <div><strong>Packet Source:</strong> ${mission.packet.source}</div>
                    </div>

                    <div class="row" style="gap: 8px; flex-wrap: wrap;">
                      <button
                        class="btn"
                        ?disabled=${props.actionBusy || !canApprove}
                        @click=${() => props.onApproveMission(mission.id)}
                      >
                        Approve Continuation
                      </button>
                      <button
                        class="btn btn--subtle"
                        ?disabled=${props.actionBusy || !canPause}
                        @click=${() => props.onPauseMission(mission.id)}
                      >
                        Pause
                      </button>
                      <button
                        class="btn btn--subtle"
                        ?disabled=${props.actionBusy || !canResume}
                        @click=${() => props.onResumeMission(mission.id)}
                      >
                        Resume
                      </button>
                      <button
                        class="btn btn--danger"
                        ?disabled=${props.actionBusy || !canCancel}
                        @click=${() => props.onCancelMission(mission.id)}
                      >
                        Cancel
                      </button>
                      <button
                        class="btn btn--subtle"
                        ?disabled=${props.actionBusy || !canRerunPreflight}
                        @click=${() => props.onRerunPreflight(mission.id)}
                      >
                        Rerun Preflight
                      </button>
                    </div>

                    <div class="grid" style="grid-template-columns: 1fr 1fr; gap: 16px;">
                      <section class="panel">
                        <div class="card-title">Scope & Plan</div>
                        <div class="card-sub">${mission.packet.summary}</div>
                        <div class="card-sub" style="margin-top: 8px;">
                          ${mission.packet.lifecycleNote}
                        </div>
                        <div style="margin-top: 12px;">
                          <strong>In Scope</strong>
                          ${renderTextList(mission.packet.scopeIn)}
                        </div>
                        <div style="margin-top: 12px;">
                          <strong>Out of Scope</strong>
                          ${renderTextList(mission.packet.scopeOut)}
                        </div>
                        <div style="margin-top: 12px;">
                          <strong>Planned Phases</strong>
                          <ol style="padding-left: 18px;">
                            ${mission.packet.phases.map((item) => html`<li>${item}</li>`)}
                          </ol>
                        </div>
                      </section>
                      <section class="panel">
                        <div class="card-title">Tasks & Verification</div>
                        <div><strong>Current Step:</strong> ${mission.currentStep ?? "n/a"}</div>
                        <div style="margin-top: 12px;">
                          <strong>Mission Tasks</strong>
                          ${renderTextList(mission.packet.tasks)}
                        </div>
                        <div style="margin-top: 12px;">
                          <strong>Done Criteria</strong>
                          ${renderTextList(mission.packet.doneCriteria)}
                        </div>
                      </section>
                    </div>

                    <div class="grid" style="grid-template-columns: 1fr 1fr; gap: 16px;">
                      <section class="panel">
                        <div class="card-title">Logs & Files</div>
                        <div class="card-sub">Logs directory: ${mission.logsDir}</div>
                        <div class="card-sub">Audit log: ${mission.auditLogPath}</div>
                        <div class="card-sub">Artifacts directory: ${mission.artifactsDir}</div>
                        <div style="margin-top: 12px;">
                          <strong>Mission Files</strong>
                          <ul style="padding-left: 18px;">
                            ${mission.files.map(
                              (entry) => html`<li>${entry.name} (${entry.kind})</li>`,
                            )}
                          </ul>
                        </div>
                      </section>
                      <section class="panel">
                        <div class="card-title">Decisions</div>
                        ${mission.decisions.length === 0
                          ? html`<div class="card-sub">No decisions recorded.</div>`
                          : html`
                              <ul style="padding-left: 18px;">
                                ${mission.decisions.map((decision) =>
                                  renderDecision(
                                    mission.id,
                                    decision,
                                    props.actionBusy,
                                    props.onReplyDecision,
                                  ),
                                )}
                              </ul>
                            `}
                      </section>
                    </div>

                    <div class="grid" style="grid-template-columns: 1fr 1fr; gap: 16px;">
                      <section class="panel">
                        <div class="card-title">Preflight</div>
                        <ul style="padding-left: 18px;">
                          ${mission.preflight.map(renderPreflight)}
                        </ul>
                      </section>
                      <section class="panel">
                        <div class="card-title">Artifacts</div>
                        ${props.artifactsLoading
                          ? html`<div class="card-sub">Loading artifacts...</div>`
                          : props.artifacts.length === 0
                            ? html`<div class="card-sub">No artifacts recorded yet.</div>`
                            : html`
                                <ul style="padding-left: 18px;">
                                  ${props.artifacts.map(renderArtifact)}
                                </ul>
                              `}
                      </section>
                    </div>

                    <section class="panel">
                      <div class="card-title">Audit</div>
                      <div
                        class="grid"
                        style="grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px;"
                      >
                        <label class="card-sub">
                          Role
                          <select
                            class="input"
                            .value=${props.auditFilters.role}
                            @change=${(event: Event) =>
                              props.onSetAuditFilter(
                                "role",
                                (event.target as HTMLSelectElement).value,
                              )}
                          >
                            <option value="">All</option>
                            ${auditRoleOptions.map(
                              (value) => html`<option value=${value}>${value}</option>`,
                            )}
                          </select>
                        </label>
                        <label class="card-sub">
                          Outcome
                          <select
                            class="input"
                            .value=${props.auditFilters.outcome}
                            @change=${(event: Event) =>
                              props.onSetAuditFilter(
                                "outcome",
                                (event.target as HTMLSelectElement).value,
                              )}
                          >
                            <option value="">All</option>
                            ${auditOutcomeOptions.map(
                              (value) => html`<option value=${value}>${value}</option>`,
                            )}
                          </select>
                        </label>
                        <label class="card-sub">
                          Side Effect
                          <select
                            class="input"
                            .value=${props.auditFilters.sideEffectClass}
                            @change=${(event: Event) =>
                              props.onSetAuditFilter(
                                "sideEffectClass",
                                (event.target as HTMLSelectElement).value,
                              )}
                          >
                            <option value="">All</option>
                            ${auditSideEffectOptions.map(
                              (value) => html`<option value=${value}>${value}</option>`,
                            )}
                          </select>
                        </label>
                        <label class="card-sub">
                          Tool
                          <select
                            class="input"
                            .value=${props.auditFilters.toolName}
                            @change=${(event: Event) =>
                              props.onSetAuditFilter(
                                "toolName",
                                (event.target as HTMLSelectElement).value,
                              )}
                          >
                            <option value="">All</option>
                            ${auditToolOptions.map(
                              (value) => html`<option value=${value}>${value}</option>`,
                            )}
                          </select>
                        </label>
                      </div>
                      ${props.auditLoading
                        ? html`<div class="card-sub">Loading audit...</div>`
                        : filteredAuditEntries.length === 0
                          ? html`<div class="card-sub">No audit entries yet.</div>`
                          : html`
                              <ul style="padding-left: 18px;">
                                ${filteredAuditEntries.map(renderAuditEntry)}
                              </ul>
                            `}
                    </section>
                  </div>
                `}
          </section>
        </div>
      </div>
    </section>
  `;
}
