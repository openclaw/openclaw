import { html, nothing } from "lit";
import { icons } from "../icons.ts";
import type {
  CodexCompatibilityRecord,
  CodexEventRecord,
  CodexNativeStatus,
  CodexProposalExecutionResult,
  CodexProposalRecord,
  CodexRouteSummary,
  CodexRuntimeEvent,
  CodexSessionRecord,
} from "../types.ts";

export type CodexProps = {
  loading: boolean;
  error: string | null;
  status: CodexNativeStatus | null;
  doctor: CodexCompatibilityRecord | null;
  eventsLoading: boolean;
  eventsSessionKey: string | null;
  events: CodexEventRecord[];
  busyProposalId: string | null;
  executionResult: CodexProposalExecutionResult | null;
  exportText: string | null;
  onRefresh: () => void;
  onDoctor: () => void;
  onLoadEvents: (sessionKey: string) => void;
  onProposalStatus: (id: string, status: CodexProposalRecord["status"]) => void;
  onExecuteProposal: (id: string, route?: string) => void;
  onExportSession: (sessionKey: string, format: "json" | "markdown") => void;
  onClearExport: () => void;
};

export function renderCodex(props: CodexProps) {
  const status = props.status;
  const newProposals = status?.inbox.filter((proposal) => proposal.status === "new").length ?? 0;
  const selectedSession =
    props.eventsSessionKey ??
    status?.sessions[0]?.sessionKey ??
    props.executionResult?.sessionKey ??
    null;

  return html`
    <section class="grid grid-cols-3">
      ${renderStatCard("Backend", status?.backend ?? "codex-sdk")}
      ${renderStatCard("Health", status?.healthy ? "Ready" : "Unprobed", status?.healthy ? "ok" : "")}
      ${renderStatCard("Routes", String(status?.routes.length ?? 0))}
      ${renderStatCard(
        "Backchannel",
        status?.backchannel?.enabled ? "MCP" : "Off",
        status?.backchannel?.enabled ? "ok" : "",
      )}
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="row" style="justify-content: space-between; gap: 12px;">
        <div>
          <div class="card-title">Native Codex SDK</div>
          <div class="card-sub">
            ${
              status
                ? `Default route ${status.defaultRoute}; ${status.sessions.length} recent sessions; ${newProposals} new proposals.`
                : "Plugin status is waiting on the gateway."
            }
          </div>
        </div>
        <div class="row" style="gap: 8px;">
          <button class="btn btn--sm" title="Run doctor" ?disabled=${props.loading} @click=${props.onDoctor}>
            ${icons.terminal} Doctor
          </button>
          <button class="btn btn--sm primary" title="Refresh Codex status" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${icons.refresh} ${props.loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>
      ${props.error ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>` : nothing}
      ${status?.backchannel ? renderBackchannel(status.backchannel) : nothing}
      ${props.doctor ? renderDoctor(props.doctor) : nothing}
    </section>

    <section class="grid grid-cols-2" style="margin-top: 18px;">
      ${renderRoutes(status?.routes ?? [])}
      ${renderInbox(props, status?.inbox ?? [])}
    </section>

    <section class="grid grid-cols-2" style="margin-top: 18px;">
      ${renderSessions(props, status?.sessions ?? [], selectedSession)}
      ${renderReplay(props, selectedSession)}
    </section>
  `;
}

function renderStatCard(label: string, value: string, tone: "" | "ok" | "warn" = "") {
  return html`
    <div class="stat">
      <div class="stat-label">${label}</div>
      <div class="stat-value ${tone}">${value}</div>
    </div>
  `;
}

function renderDoctor(record: CodexCompatibilityRecord) {
  return html`
    <div class="callout ${record.ok ? "success" : "danger"}" style="margin-top: 12px;">
      ${record.sdkPackage}@${record.sdkVersion} ${record.ok ? "passed" : "failed"} at
      ${formatDate(record.checkedAt)}.
    </div>
    <div class="list" style="margin-top: 12px;">
      ${record.checks.map(
        (check) => html`
          <div class="list-item">
            <div class="list-main">
              <div class="list-title">${check.id}</div>
              <div class="list-sub">${check.message}</div>
            </div>
            <div class="list-meta">${check.status}</div>
          </div>
        `,
      )}
    </div>
  `;
}

function renderBackchannel(backchannel: CodexNativeStatus["backchannel"]) {
  const details = [
    backchannel.gatewayUrlConfigured ? "gateway URL configured" : "default gateway URL",
    backchannel.stateDirConfigured ? "state fallback ready" : "state fallback unavailable",
    backchannel.requireWriteToken ? `write token ${backchannel.writeTokenEnv}` : "writes ungated",
  ];
  return html`
    <div class="callout ${backchannel.enabled ? "success" : ""}" style="margin-top: 12px;">
      Backchannel ${backchannel.enabled ? "enabled" : "disabled"} via
      <span class="mono">${backchannel.server}</span>. ${details.join("; ")}.
      ${
        backchannel.safeWriteMethods.length
          ? html`Safe writes: <span class="mono">${backchannel.safeWriteMethods.join(", ")}</span>.`
          : nothing
      }
    </div>
  `;
}

function renderRoutes(routes: CodexRouteSummary[]) {
  return html`
    <div class="card">
      <div class="card-title">Routes</div>
      <div class="card-sub">SDK personalities available to OpenClaw ACP sessions.</div>
      ${
        routes.length === 0
          ? html`
              <div class="muted" style="margin-top: 12px">No routes reported.</div>
            `
          : html`
              <div class="list" style="margin-top: 12px;">
                ${routes.map(renderRoute)}
              </div>
            `
      }
    </div>
  `;
}

function renderRoute(route: CodexRouteSummary) {
  const details = [
    ...formatModelDetails(route),
    route.sandboxMode ? `sandbox ${route.sandboxMode}` : "",
    route.approvalPolicy ? `approval ${route.approvalPolicy}` : "",
    route.webSearchMode ? `web ${route.webSearchMode}` : "",
  ].filter(Boolean);
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${route.label}</div>
        <div class="list-sub">${route.aliases.join(", ")}</div>
      </div>
      <div class="list-meta">${details.join(" / ") || "default"}</div>
    </div>
  `;
}

function renderInbox(props: CodexProps, proposals: CodexProposalRecord[]) {
  return html`
    <div class="card">
      <div class="card-title">Proposal Inbox</div>
      <div class="card-sub">Follow-up work emitted by Codex as openclaw-proposal blocks.</div>
      ${
        props.executionResult
          ? html`<div class="callout success" style="margin-top: 12px;">
              Executed ${props.executionResult.proposal.title} in
              <span class="mono">${props.executionResult.sessionKey}</span>.
            </div>`
          : nothing
      }
      ${
        proposals.length === 0
          ? html`
              <div class="muted" style="margin-top: 12px">No proposals recorded.</div>
            `
          : html`
              <div class="list" style="margin-top: 12px;">
                ${proposals.map((proposal) => renderProposal(props, proposal))}
              </div>
            `
      }
    </div>
  `;
}

function renderProposal(props: CodexProps, proposal: CodexProposalRecord) {
  const busy = props.busyProposalId === proposal.id;
  const route = proposal.executionRouteId ?? proposal.routeId;
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${proposal.title}</div>
        <div class="list-sub">
          ${proposal.status} / ${proposal.routeLabel} / ${formatDate(proposal.updatedAt ?? proposal.at)}
        </div>
        ${proposal.summary ? html`<div class="list-sub" style="margin-top: 4px;">${proposal.summary}</div>` : nothing}
        ${
          proposal.actions?.length
            ? html`<div class="list-sub" style="margin-top: 4px;">${proposal.actions.join("; ")}</div>`
            : nothing
        }
        ${
          proposal.executedSessionKey
            ? html`<div class="list-sub" style="margin-top: 4px;">
                session <span class="mono">${proposal.executedSessionKey}</span>
              </div>`
            : nothing
        }
        ${
          proposal.lastExecutionError
            ? html`<div class="callout danger" style="margin-top: 8px;">${proposal.lastExecutionError}</div>`
            : nothing
        }
      </div>
      <div class="list-meta" style="display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end;">
        <button
          class="btn btn--sm"
          title="Accept proposal"
          ?disabled=${busy || proposal.status === "accepted"}
          @click=${() => props.onProposalStatus(proposal.id, "accepted")}
        >
          ${icons.check} Accept
        </button>
        <button
          class="btn btn--sm"
          title="Dismiss proposal"
          ?disabled=${busy || proposal.status === "dismissed"}
          @click=${() => props.onProposalStatus(proposal.id, "dismissed")}
        >
          ${icons.x} Dismiss
        </button>
        <button
          class="btn btn--sm primary"
          title="Execute proposal"
          ?disabled=${busy}
          @click=${() => props.onExecuteProposal(proposal.id, route)}
        >
          ${icons.send} ${busy ? "Running..." : "Execute"}
        </button>
      </div>
    </div>
  `;
}

function renderSessions(
  props: CodexProps,
  sessions: CodexSessionRecord[],
  selectedSession: string | null,
) {
  return html`
    <div class="card">
      <div class="card-title">Sessions</div>
      <div class="card-sub">Recorded Codex SDK threads and ACP session keys.</div>
      ${
        sessions.length === 0
          ? html`
              <div class="muted" style="margin-top: 12px">No sessions recorded.</div>
            `
          : html`
              <div class="list" style="margin-top: 12px;">
                ${sessions.map((session) => renderSession(props, session, selectedSession))}
              </div>
            `
      }
      ${
        props.exportText
          ? html`
              <div class="row" style="justify-content: space-between; margin-top: 14px;">
                <div class="card-title">Export</div>
                <button class="btn btn--sm" title="Clear export" @click=${props.onClearExport}>
                  ${icons.x} Clear
                </button>
              </div>
              <pre class="code-block" style="margin-top: 10px; max-height: 360px; overflow: auto;">${props.exportText}</pre>
            `
          : nothing
      }
    </div>
  `;
}

function renderSession(
  props: CodexProps,
  session: CodexSessionRecord,
  selectedSession: string | null,
) {
  const selected = session.sessionKey === selectedSession;
  const details = [
    ...formatModelDetails(session),
    session.routeLabel,
    session.status,
    `turns ${session.turnCount}`,
    formatDate(session.updatedAt),
  ];
  return html`
    <div class="list-item ${selected ? "list-item-selected" : ""}">
      <div class="list-main">
        <div class="list-title mono">${session.sessionKey}</div>
        <div class="list-sub">${details.join(" / ")}</div>
        ${session.threadId ? html`<div class="list-sub mono">${session.threadId}</div>` : nothing}
      </div>
      <div class="list-meta" style="display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end;">
        <button
          class="btn btn--sm"
          title="Replay events"
          ?disabled=${props.eventsLoading}
          @click=${() => props.onLoadEvents(session.sessionKey)}
        >
          ${icons.fileText} Replay
        </button>
        <button
          class="btn btn--sm"
          title="Export Markdown"
          @click=${() => props.onExportSession(session.sessionKey, "markdown")}
        >
          ${icons.download} MD
        </button>
        <button
          class="btn btn--sm"
          title="Export JSON"
          @click=${() => props.onExportSession(session.sessionKey, "json")}
        >
          ${icons.download} JSON
        </button>
      </div>
    </div>
  `;
}

function formatModelDetails(value: { model?: string; modelReasoningEffort?: string }): string[] {
  return [
    value.model ? `model ${value.model}` : "",
    value.modelReasoningEffort ? `reasoning ${value.modelReasoningEffort}` : "",
  ].filter(Boolean);
}

function renderReplay(props: CodexProps, selectedSession: string | null) {
  return html`
    <div class="card">
      <div class="card-title">Replay</div>
      <div class="card-sub">
        ${selectedSession ? html`<span class="mono">${selectedSession}</span>` : "No session selected."}
      </div>
      ${
        props.eventsLoading
          ? html`
              <div class="muted" style="margin-top: 12px">Loading events...</div>
            `
          : props.events.length === 0
            ? html`
                <div class="muted" style="margin-top: 12px">No events loaded.</div>
              `
            : html`
                <div class="list" style="margin-top: 12px;">
                  ${props.events.map(renderEvent)}
                </div>
              `
      }
    </div>
  `;
}

function renderEvent(event: CodexEventRecord) {
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${event.sdkEventType}</div>
        <div class="list-sub">${formatDate(event.at)} / ${event.routeLabel}</div>
        <div style="display: grid; gap: 6px; margin-top: 8px;">
          ${event.mappedEvents.map(renderRuntimeEvent)}
        </div>
      </div>
    </div>
  `;
}

function renderRuntimeEvent(event: CodexRuntimeEvent) {
  if (event.type === "text_delta") {
    return html`<div class="code-block" style="white-space: pre-wrap;">${event.text}</div>`;
  }
  if (event.type === "status") {
    return html`<div class="muted">${event.text}</div>`;
  }
  if (event.type === "tool_call") {
    return html`<div class="muted">${event.title ?? "tool"}: ${event.text}</div>`;
  }
  if (event.type === "error") {
    return html`<div class="callout danger">${event.message}</div>`;
  }
  return html`<div class="muted">done: ${event.stopReason ?? "end_turn"}</div>`;
}

function formatDate(value: string | undefined): string {
  if (!value) {
    return "n/a";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}
