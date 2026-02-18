import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state.ts";

export function renderDevicePairPrompt(state: AppViewState) {
  const active = state.devicePairingQueue[0];
  if (!active) {
    return nothing;
  }
  const queueCount = state.devicePairingQueue.length;
  const displayName = active.displayName?.trim() || active.deviceId;
  const role = active.role || "operator";
  return html`
    <div class="exec-approval-overlay" role="dialog" aria-live="polite">
      <div class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">Device pairing request</div>
            <div class="exec-approval-sub">A new device is requesting access</div>
          </div>
          ${
            queueCount > 1
              ? html`<div class="exec-approval-queue">${queueCount} pending</div>`
              : nothing
          }
        </div>
        <div class="exec-approval-command mono">${displayName}</div>
        <div class="exec-approval-meta">
          <div class="exec-approval-meta-row"><span>Role</span><span>${role}</span></div>
          ${active.remoteIp ? html`<div class="exec-approval-meta-row"><span>IP</span><span>${active.remoteIp}</span></div>` : nothing}
          ${active.deviceId !== displayName ? html`<div class="exec-approval-meta-row"><span>Device ID</span><span class="mono">${active.deviceId.slice(0, 16)}…</span></div>` : nothing}
        </div>
        ${
          state.devicePairError
            ? html`<div class="exec-approval-error">${state.devicePairError}</div>`
            : nothing
        }
        <div class="exec-approval-actions">
          <button
            class="btn primary"
            ?disabled=${state.devicePairBusy}
            @click=${() => state.handleDevicePairDecision("approve")}
          >
            Approve
          </button>
          <button
            class="btn danger"
            ?disabled=${state.devicePairBusy}
            @click=${() => state.handleDevicePairDecision("reject")}
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  `;
}
