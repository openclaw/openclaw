import { html, nothing } from "lit";
import type {
  ClawControlState,
  ClawInboxItem,
  ClawMissionDetail,
  ClawMissionSummary,
  ClawPendingDecision,
  ClawPreflightCheck,
} from "../../../../src/shared/claw-types.js";

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
  onGoalDraftChange: (value: string) => void;
  onCreateMission: () => void;
  onSelectMission: (missionId: string) => void;
  onApproveMission: (missionId: string) => void;
  onPauseMission: (missionId: string) => void;
  onResumeMission: (missionId: string) => void;
  onCancelMission: (missionId: string) => void;
  onRerunPreflight: (missionId: string) => void;
  onPauseAll: () => void;
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

function renderDecision(decision: ClawPendingDecision) {
  return html`
    <li>
      <strong>${decision.title}</strong> (${decision.status})
      <div class="card-sub">${decision.summary}</div>
    </li>
  `;
}

function renderPreflight(check: ClawPreflightCheck) {
  return html`
    <li>
      <strong>${check.title}</strong> (${check.status})
      <div class="card-sub">${check.summary}</div>
    </li>
  `;
}

export function renderClaw(props: ClawViewProps) {
  const mission = props.mission;
  const canApprove = mission?.status === "awaiting_approval";
  const canPause =
    mission != null &&
    ["queued", "running", "recovering", "verifying", "blocked"].includes(mission.status);
  const canResume = mission != null && ["paused", "blocked"].includes(mission.status);
  const canCancel = mission != null && !["done", "failed", "cancelled"].includes(mission.status);
  const canRerunPreflight =
    mission != null &&
    ["awaiting_setup", "awaiting_approval", "paused", "blocked"].includes(mission.status);
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; margin-bottom: 12px;">
        <div>
          <div class="card-title">Claw Missions</div>
          <div class="card-sub">
            Goal-oriented mission intake, approval, and continuous execution state.
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
              <button class="btn btn--subtle" ?disabled=${props.actionBusy} @click=${props.onPauseAll}>
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
                            <div class="card-sub">${entry.status}</div>
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
            ${props.error ? html`<div class="card-sub" style="color: var(--danger, #d14);">${props.error}</div>` : nothing}
            ${!mission
              ? html`<div class="card-sub">Select a mission to inspect its packet and controls.</div>`
              : html`
                  <div class="stack" style="gap: 12px;">
                    <div class="card-sub">${mission.goal}</div>
                    <div class="grid" style="grid-template-columns: 1fr 1fr; gap: 10px;">
                      <div><strong>Status:</strong> ${mission.status}</div>
                      <div><strong>Current Step:</strong> ${mission.currentStep ?? "n/a"}</div>
                      <div><strong>Created:</strong> ${formatDate(mission.createdAt)}</div>
                      <div><strong>Updated:</strong> ${formatDate(mission.updatedAt)}</div>
                      <div><strong>Workspace:</strong> ${mission.workspaceDir}</div>
                      <div><strong>Mission Dir:</strong> ${mission.missionDir}</div>
                    </div>

                    <div class="row" style="gap: 8px; flex-wrap: wrap;">
                      <button
                        class="btn"
                        ?disabled=${props.actionBusy || !canApprove}
                        @click=${() => props.onApproveMission(mission.id)}
                      >
                        Approve Start
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
                        <div class="card-title">Decisions</div>
                        ${mission.decisions.length === 0
                          ? html`<div class="card-sub">No decisions recorded.</div>`
                          : html`<ul style="padding-left: 18px;">${mission.decisions.map(renderDecision)}</ul>`}
                      </section>
                      <section class="panel">
                        <div class="card-title">Preflight</div>
                        <ul style="padding-left: 18px;">${mission.preflight.map(renderPreflight)}</ul>
                      </section>
                    </div>
                  </div>
                `}
          </section>
        </div>
      </div>
    </section>
  `;
}
