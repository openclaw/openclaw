import { html, nothing } from "lit";

import { formatAgo } from "../format";
import type { SignalStatus } from "../types";
import type { ConnectionsProps } from "./connections.types";

export function renderSignalCard(params: {
  props: ConnectionsProps;
  signal: SignalStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, signal, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">Signal</div>
      <div class="card-sub">REST daemon status and probe details.</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">Configured</span>
          <span>${signal?.configured ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Running</span>
          <span>${signal?.running ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Base URL</span>
          <span>${signal?.baseUrl ?? "n/a"}</span>
        </div>
        <div>
          <span class="label">Last start</span>
          <span>${signal?.lastStartAt ? formatAgo(signal.lastStartAt) : "n/a"}</span>
        </div>
        <div>
          <span class="label">Last probe</span>
          <span>${signal?.lastProbeAt ? formatAgo(signal.lastProbeAt) : "n/a"}</span>
        </div>
      </div>

      ${signal?.lastError
        ? html`<div class="callout danger" style="margin-top: 12px;">
            ${signal.lastError}
          </div>`
        : nothing}

      ${signal?.probe
        ? html`<div class="callout" style="margin-top: 12px;">
            Probe ${signal.probe.ok ? "ok" : "failed"} ·
            ${signal.probe.status ?? ""} ${signal.probe.error ?? ""}
          </div>`
        : nothing}

      <div class="form-grid" style="margin-top: 16px;">
        <label class="field">
          <span>Enabled</span>
          <select
            .value=${props.signalForm.enabled ? "yes" : "no"}
            @change=${(e: Event) =>
              props.onSignalChange({
                enabled: (e.target as HTMLSelectElement).value === "yes",
              })}
          >
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
        <label class="field">
          <span>Account</span>
          <input
            .value=${props.signalForm.account}
            @input=${(e: Event) =>
              props.onSignalChange({
                account: (e.target as HTMLInputElement).value,
              })}
            placeholder="+15551234567"
          />
        </label>
        <label class="field">
          <span>HTTP URL</span>
          <input
            .value=${props.signalForm.httpUrl}
            @input=${(e: Event) =>
              props.onSignalChange({
                httpUrl: (e.target as HTMLInputElement).value,
              })}
            placeholder="http://127.0.0.1:8080"
          />
        </label>
        <label class="field">
          <span>HTTP host</span>
          <input
            .value=${props.signalForm.httpHost}
            @input=${(e: Event) =>
              props.onSignalChange({
                httpHost: (e.target as HTMLInputElement).value,
              })}
            placeholder="127.0.0.1"
          />
        </label>
        <label class="field">
          <span>HTTP port</span>
          <input
            .value=${props.signalForm.httpPort}
            @input=${(e: Event) =>
              props.onSignalChange({
                httpPort: (e.target as HTMLInputElement).value,
              })}
            placeholder="8080"
          />
        </label>
        <label class="field">
          <span>CLI path</span>
          <input
            .value=${props.signalForm.cliPath}
            @input=${(e: Event) =>
              props.onSignalChange({
                cliPath: (e.target as HTMLInputElement).value,
              })}
            placeholder="signal-cli"
          />
        </label>
        <label class="field">
          <span>Auto start</span>
          <select
            .value=${props.signalForm.autoStart ? "yes" : "no"}
            @change=${(e: Event) =>
              props.onSignalChange({
                autoStart: (e.target as HTMLSelectElement).value === "yes",
              })}
          >
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
        <label class="field">
          <span>Receive mode</span>
          <select
            .value=${props.signalForm.receiveMode}
            @change=${(e: Event) =>
              props.onSignalChange({
                receiveMode: (e.target as HTMLSelectElement).value as
                  | "on-start"
                  | "manual"
                  | "",
              })}
          >
            <option value="">Default</option>
            <option value="on-start">on-start</option>
            <option value="manual">manual</option>
          </select>
        </label>
        <label class="field">
          <span>Ignore attachments</span>
          <select
            .value=${props.signalForm.ignoreAttachments ? "yes" : "no"}
            @change=${(e: Event) =>
              props.onSignalChange({
                ignoreAttachments: (e.target as HTMLSelectElement).value === "yes",
              })}
          >
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
        <label class="field">
          <span>Ignore stories</span>
          <select
            .value=${props.signalForm.ignoreStories ? "yes" : "no"}
            @change=${(e: Event) =>
              props.onSignalChange({
                ignoreStories: (e.target as HTMLSelectElement).value === "yes",
              })}
          >
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
        <label class="field">
          <span>Send read receipts</span>
          <select
            .value=${props.signalForm.sendReadReceipts ? "yes" : "no"}
            @change=${(e: Event) =>
              props.onSignalChange({
                sendReadReceipts: (e.target as HTMLSelectElement).value === "yes",
              })}
          >
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
        <label class="field">
          <span>Allow from</span>
          <input
            .value=${props.signalForm.allowFrom}
            @input=${(e: Event) =>
              props.onSignalChange({
                allowFrom: (e.target as HTMLInputElement).value,
              })}
            placeholder="12345, +1555"
          />
        </label>
        <label class="field">
          <span>Media max MB</span>
          <input
            .value=${props.signalForm.mediaMaxMb}
            @input=${(e: Event) =>
              props.onSignalChange({
                mediaMaxMb: (e.target as HTMLInputElement).value,
              })}
            placeholder="8"
          />
        </label>
      </div>

      ${props.signalStatus
        ? html`<div class="callout" style="margin-top: 12px;">
            ${props.signalStatus}
          </div>`
        : nothing}

      <div class="row" style="margin-top: 14px;">
        <button
          class="btn primary"
          ?disabled=${props.signalSaving}
          @click=${() => props.onSignalSave()}
        >
          ${props.signalSaving ? "Saving…" : "Save"}
        </button>
        <button class="btn" @click=${() => props.onRefresh(true)}>Probe</button>
      </div>
    </div>
  `;
}

