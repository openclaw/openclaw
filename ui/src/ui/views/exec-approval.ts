import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state.ts";
import { t } from "../i18n/index.js";

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

export function renderExecApprovalPrompt(state: AppViewState) {
  const active = state.execApprovalQueue[0];
  if (!active) {
    return nothing;
  }
  const request = active.request;
  const remainingMs = active.expiresAtMs - Date.now();
  const remaining =
    remainingMs > 0 ? `${t("expires in")} ${formatRemaining(remainingMs)}` : t("expired");
  const queueCount = state.execApprovalQueue.length;
  return html`
    <div class="exec-approval-overlay" role="dialog" aria-live="polite">
      <div class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">${t("Exec approval needed")}</div>
            <div class="exec-approval-sub">${remaining}</div>
          </div>
          ${
            queueCount > 1
              ? html`<div class="exec-approval-queue">${queueCount} ${t("pending")}</div>`
              : nothing
          }
        </div>
        <div class="exec-approval-command mono">${request.command}</div>
        <div class="exec-approval-meta">
          ${renderMetaRow(t("Host"), request.host)}
          ${renderMetaRow(t("Agent"), request.agentId)}
          ${renderMetaRow(t("Session"), request.sessionKey)}
          ${renderMetaRow("CWD", request.cwd)}
          ${renderMetaRow(t("Resolved"), request.resolvedPath)}
          ${renderMetaRow(t("Security"), request.security)}
          ${renderMetaRow("Ask", request.ask)}
        </div>
        ${
          state.execApprovalError
            ? html`<div class="exec-approval-error">${state.execApprovalError}</div>`
            : nothing
        }
        <div class="exec-approval-actions">
          <button
            class="btn primary"
            ?disabled=${state.execApprovalBusy}
            @click=${() => state.handleExecApprovalDecision("allow-once")}
          >
            ${t("Allow once")}
          </button>
          <button
            class="btn"
            ?disabled=${state.execApprovalBusy}
            @click=${() => state.handleExecApprovalDecision("allow-always")}
          >
            ${t("Always allow")}
          </button>
          <button
            class="btn danger"
            ?disabled=${state.execApprovalBusy}
            @click=${() => state.handleExecApprovalDecision("deny")}
          >
            ${t("Deny")}
          </button>
        </div>
      </div>
    </div>
  `;
}
