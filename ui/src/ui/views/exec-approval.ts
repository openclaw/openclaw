import { msg } from "@lit/localize";
import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state.ts";

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
    remainingMs > 0
      ? msg("expires in {time}", {
          id: "execApproval.expiresIn",
          args: { time: formatRemaining(remainingMs) },
        })
      : msg("expired", { id: "execApproval.expired" });
  const queueCount = state.execApprovalQueue.length;
  return html`
    <div class="exec-approval-overlay" role="dialog" aria-live="polite">
      <div class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">${msg("Exec approval needed", { id: "execApproval.title" })}</div>
            <div class="exec-approval-sub">${remaining}</div>
          </div>
          ${
            queueCount > 1
              ? html`<div class="exec-approval-queue">${msg("{count} pending", {
                  id: "execApproval.pending",
                  args: { count: queueCount },
                })}</div>`
              : nothing
          }
        </div>
        <div class="exec-approval-command mono">${request.command}</div>
        <div class="exec-approval-meta">
          ${renderMetaRow(msg("Host", { id: "execApproval.host" }), request.host)}
          ${renderMetaRow(msg("Agent", { id: "execApproval.agent" }), request.agentId)}
          ${renderMetaRow(msg("Session", { id: "execApproval.session" }), request.sessionKey)}
          ${renderMetaRow(msg("CWD", { id: "execApproval.cwd" }), request.cwd)}
          ${renderMetaRow(msg("Resolved", { id: "execApproval.resolved" }), request.resolvedPath)}
          ${renderMetaRow(msg("Security", { id: "execApproval.security" }), request.security)}
          ${renderMetaRow(msg("Ask", { id: "execApproval.ask" }), request.ask)}
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
            ${msg("Allow once", { id: "execApproval.allowOnce" })}
          </button>
          <button
            class="btn"
            ?disabled=${state.execApprovalBusy}
            @click=${() => state.handleExecApprovalDecision("allow-always")}
          >
            ${msg("Always allow", { id: "execApproval.allowAlways" })}
          </button>
          <button
            class="btn danger"
            ?disabled=${state.execApprovalBusy}
            @click=${() => state.handleExecApprovalDecision("deny")}
          >
            ${msg("Deny", { id: "execApproval.deny" })}
          </button>
        </div>
      </div>
    </div>
  `;
}
