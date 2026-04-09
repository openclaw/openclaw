import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state.ts";
import type {
  ExecApprovalRequest,
  ExecApprovalRequestPayload,
} from "../controllers/exec-approval.ts";

function renderPluginRouteSemantics(entry: AppViewState["execApprovalQueue"][number]) {
  if (entry.kind !== "plugin") {
    return nothing;
  }

  const route = entry.routeStatus;
  const recoverability = entry.recoverability;
  if (!route && !recoverability) {
    return nothing;
  }

  let routeText: string | null = null;
  if (route === "delivery-failed") {
    routeText = "Delivery failed";
  } else if (route === "pending-route") {
    routeText = "Waiting for route";
  } else if (route === "no-route") {
    routeText = "No approval route";
  } else if (route === "delivered") {
    routeText = "Delivered";
  }

  const recoverabilityText =
    recoverability === "reconnect-recoverable"
      ? "reconnect-recoverable"
      : recoverability === "terminal"
        ? "terminal"
        : null;

  const parts = [routeText, recoverabilityText].filter((value): value is string => Boolean(value));
  if (parts.length === 0) {
    return nothing;
  }

  return html`<div class="exec-approval-sub">${parts.join(" • ")}</div>`;
}

function formatRemaining(ms: number): string {
  const remaining = Math.max(0, ms);
  const totalSeconds = Math.floor(remaining / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function renderMetaRow(label: string, value?: string | null) {
  if (!value) {
    return nothing;
  }
  return html`<div class="exec-approval-meta-row"><span>${label}</span><span>${value}</span></div>`;
}

function renderExecBody(request: ExecApprovalRequestPayload) {
  return html`
    <div class="exec-approval-command mono">${request.command}</div>
    <div class="exec-approval-meta">
      ${renderMetaRow("Host", request.host)} ${renderMetaRow("Agent", request.agentId)}
      ${renderMetaRow("Session", request.sessionKey)} ${renderMetaRow("CWD", request.cwd)}
      ${renderMetaRow("Resolved", request.resolvedPath)}
      ${renderMetaRow("Security", request.security)} ${renderMetaRow("Ask", request.ask)}
    </div>
  `;
}

function renderPluginBody(active: ExecApprovalRequest) {
  return html`
    ${active.pluginDescription
      ? html`<pre class="exec-approval-command mono" style="white-space:pre-wrap">
${active.pluginDescription}</pre
        >`
      : nothing}
    <div class="exec-approval-meta">
      ${renderMetaRow("Severity", active.pluginSeverity)}
      ${renderMetaRow("Plugin", active.pluginId)} ${renderMetaRow("Agent", active.request.agentId)}
      ${renderMetaRow("Session", active.request.sessionKey)}
    </div>
  `;
}

export function renderExecApprovalPrompt(state: AppViewState) {
  const active = state.execApprovalQueue[0];
  if (!active) {
    return nothing;
  }
  const request = active.request;
  const remainingMs = active.expiresAtMs - Date.now();
  const remaining = remainingMs > 0 ? `expires in ${formatRemaining(remainingMs)}` : "expired";
  const queueCount = state.execApprovalQueue.length;
  const isPlugin = active.kind === "plugin";
  const title = isPlugin
    ? (active.pluginTitle ?? "Plugin approval needed")
    : "Exec approval needed";
  return html`
    <div class="exec-approval-overlay" role="dialog" aria-live="polite">
      <div class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">${title}</div>
            <div class="exec-approval-sub">${remaining}</div>
            ${renderPluginRouteSemantics(active)}
          </div>
          ${queueCount > 1
            ? html`<div class="exec-approval-queue">${queueCount} pending</div>`
            : nothing}
        </div>
        ${isPlugin ? renderPluginBody(active) : renderExecBody(request)}
        ${state.execApprovalError
          ? html`<div class="exec-approval-error">${state.execApprovalError}</div>`
          : nothing}
        <div class="exec-approval-actions">
          <button
            class="btn primary"
            ?disabled=${state.execApprovalBusy}
            @click=${() => state.handleExecApprovalDecision("allow-once")}
          >
            Allow once
          </button>
          <button
            class="btn"
            ?disabled=${state.execApprovalBusy}
            @click=${() => state.handleExecApprovalDecision("allow-always")}
          >
            Always allow
          </button>
          <button
            class="btn danger"
            ?disabled=${state.execApprovalBusy}
            @click=${() => state.handleExecApprovalDecision("deny")}
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  `;
}
