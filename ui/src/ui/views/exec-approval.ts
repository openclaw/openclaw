import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { AppViewState } from "../app-view-state.ts";
import type {
  ExecApprovalRequest,
  ExecApprovalRequestPayload,
} from "../controllers/exec-approval.ts";

function localizeRouteStatus(route?: string | null): string | null {
  switch (route) {
    case "delivery-failed":
      return t("execApprovalPrompt.route.deliveryFailed");
    case "pending-route":
      return t("execApprovalPrompt.route.pendingRoute");
    case "no-route":
      return t("execApprovalPrompt.route.noRoute");
    case "delivered":
      return t("execApprovalPrompt.route.delivered");
    default:
      return null;
  }
}

function localizeRecoverability(recoverability?: string | null): string | null {
  switch (recoverability) {
    case "reconnect-recoverable":
      return t("execApprovalPrompt.recoverability.reconnectRecoverable");
    case "terminal":
      return t("execApprovalPrompt.recoverability.terminal");
    default:
      return null;
  }
}

function localizeSecurity(value?: string | null): string | null {
  switch (value) {
    case "deny":
      return t("dashboard.binding.execApprovals.securityOptions.deny");
    case "allowlist":
      return t("dashboard.binding.execApprovals.securityOptions.allowlist");
    case "full":
      return t("dashboard.binding.execApprovals.securityOptions.full");
    default:
      return value ?? null;
  }
}

function localizeAsk(value?: string | null): string | null {
  switch (value) {
    case "off":
      return t("dashboard.binding.execApprovals.askOptions.off");
    case "on-miss":
      return t("dashboard.binding.execApprovals.askOptions.onMiss");
    case "always":
      return t("dashboard.binding.execApprovals.askOptions.always");
    default:
      return value ?? null;
  }
}

function renderPluginRouteSemantics(entry: AppViewState["execApprovalQueue"][number]) {
  if (entry.kind !== "plugin") {
    return nothing;
  }

  const route = entry.routeStatus;
  const recoverability = entry.recoverability;
  if (!route && !recoverability) {
    return nothing;
  }

  const routeText = localizeRouteStatus(route);
  const recoverabilityText = localizeRecoverability(recoverability);

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
      ${renderMetaRow(t("execApprovalPrompt.meta.host"), request.host)}
      ${renderMetaRow(t("execApprovalPrompt.meta.agent"), request.agentId)}
      ${renderMetaRow(t("execApprovalPrompt.meta.session"), request.sessionKey)}
      ${renderMetaRow(t("execApprovalPrompt.meta.cwd"), request.cwd)}
      ${renderMetaRow(t("execApprovalPrompt.meta.resolved"), request.resolvedPath)}
      ${renderMetaRow(t("execApprovalPrompt.meta.security"), localizeSecurity(request.security))}
      ${renderMetaRow(t("execApprovalPrompt.meta.ask"), localizeAsk(request.ask))}
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
      ${renderMetaRow(t("execApprovalPrompt.meta.severity"), active.pluginSeverity)}
      ${renderMetaRow(t("execApprovalPrompt.meta.plugin"), active.pluginId)}
      ${renderMetaRow(t("execApprovalPrompt.meta.agent"), active.request.agentId)}
      ${renderMetaRow(t("execApprovalPrompt.meta.session"), active.request.sessionKey)}
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
  const remaining =
    remainingMs > 0
      ? t("execApprovalPrompt.expiresIn", { value: formatRemaining(remainingMs) })
      : t("execApprovalPrompt.expired");
  const queueCount = state.execApprovalQueue.length;
  const isPlugin = active.kind === "plugin";
  const title = isPlugin
    ? (active.pluginTitle ?? t("execApprovalPrompt.pluginApprovalNeeded"))
    : t("execApprovalPrompt.execApprovalNeeded");
  return html`
    <div class="exec-approval-overlay" role="dialog" aria-live="polite">
      <div class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">${title}</div>
            <div class="exec-approval-sub">${remaining}</div>
          </div>
          ${queueCount > 1
            ? html`<div class="exec-approval-queue">
                ${t("execApprovalPrompt.pendingCount", { count: String(queueCount) })}
              </div>`
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
            ${t("execApprovalPrompt.allowOnce")}
          </button>
          <button
            class="btn"
            ?disabled=${state.execApprovalBusy}
            @click=${() => state.handleExecApprovalDecision("allow-always")}
          >
            ${t("execApprovalPrompt.allowAlways")}
          </button>
          <button
            class="btn danger"
            ?disabled=${state.execApprovalBusy}
            @click=${() => state.handleExecApprovalDecision("deny")}
          >
            ${t("execApprovalPrompt.deny")}
          </button>
        </div>
      </div>
    </div>
  `;
}
