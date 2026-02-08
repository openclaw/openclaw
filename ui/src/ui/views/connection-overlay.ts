import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state";

export function renderConnectionOverlay(state: AppViewState) {
  const gate = state.connectionGate;
  if (!gate) {
    return nothing;
  }

  const title = gate.kind === "pairing_required" ? "Pairing required" : "Disconnected";
  const sub =
    gate.kind === "pairing_required"
      ? html`
          To use this Control UI, connect through Tailscale (your private network). We’ll retry automatically.
        `
      : html`
          The connection to the gateway was lost. You can retry or reload.
        `;

  const primaryAction = (() => {
    if (gate.kind === "pairing_required") {
      return html`
        <button class="btn primary" @click=${() => state.handleConnectionOpenTailscale()}>
          Open Tailscale
        </button>
      `;
    }
    return html`
      <button class="btn primary" @click=${() => state.handleConnectionRetryNow()}>
        Retry now
      </button>
    `;
  })();

  const qr =
    gate.kind === "pairing_required" && state.connectionQrDataUrl
      ? html`<div class="qr-wrap" style="margin-top: 12px;">
          <img src=${state.connectionQrDataUrl} alt="Gateway URL QR" />
        </div>`
      : nothing;

  const secondary = (() => {
    if (gate.kind !== "pairing_required") {
      return html`
        <button class="btn" @click=${() => state.handleConnectionReload()}>Reload</button>
      `;
    }
    return html`
      <button class="btn" @click=${() => state.handleConnectionToggleQr()}>
        ${state.connectionShowQr ? "Hide QR" : "Show QR"}
      </button>
      <button class="btn" @click=${() => state.handleConnectionCopyLink()}>
        Copy link
      </button>
      <button class="btn" @click=${() => state.handleConnectionRetryNow()}>Retry now</button>
    `;
  })();

  const manual =
    gate.kind === "pairing_required"
      ? html`
          <details style="margin-top: 12px">
            <summary class="muted">Manual steps</summary>
            <div class="muted" style="margin-top: 8px; line-height: 1.45">
              <ol style="margin: 0 0 0 18px; padding: 0">
                <li>Open Tailscale and sign in (if needed).</li>
                <li>Ensure this device is connected to the same tailnet as the gateway.</li>
                <li>Return here — we’ll reconnect automatically.</li>
              </ol>
            </div>
          </details>
        `
      : nothing;

  const retryLine = (() => {
    if (!gate.retry) {
      return nothing;
    }
    const status = gate.retry.stopped ? "Retry paused" : `Retrying… attempt ${gate.retry.attempt}`;
    return html`
      <div class="muted" style="margin-top: 10px;">
        ${status}
        ${
          gate.retry.stopped
            ? html`<button class="btn" style="margin-left: 10px;" @click=${() => state.handleConnectionRetryNow()}>
                Resume
              </button>`
            : html`<button class="btn" style="margin-left: 10px;" @click=${() => state.handleConnectionStopRetrying()}>
                Stop retrying
              </button>`
        }
      </div>
    `;
  })();

  const diagnostics = html`
    <details style="margin-top: 14px;">
      <summary class="muted">Diagnostics</summary>
      <div class="muted" style="margin-top: 8px; line-height: 1.45;">
        <div>Last close code: <span class="mono">${gate.diagnostics.lastCloseCode ?? "n/a"}</span></div>
        <div>
          Reason category:
          <span class="mono">${gate.diagnostics.reasonCategory ?? "n/a"}</span>
        </div>
        <div>
          Last close at:
          <span class="mono">${gate.diagnostics.lastCloseAtMs ? new Date(gate.diagnostics.lastCloseAtMs).toISOString() : "n/a"}</span>
        </div>
      </div>
    </details>
  `;

  return html`
    <div class="exec-approval-overlay" role="dialog" aria-modal="true" aria-live="polite">
      <div class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">${title}</div>
            <div class="exec-approval-sub">${sub}</div>
          </div>
        </div>

        ${qr}

        <div class="exec-approval-actions" style="margin-top: 14px; flex-wrap: wrap;">
          ${primaryAction} ${secondary}
        </div>

        ${manual} ${retryLine} ${diagnostics}
      </div>
    </div>
  `;
}
