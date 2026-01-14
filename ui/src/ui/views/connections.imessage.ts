import { html, nothing } from "lit";

import { formatAgo } from "../format";
import type { IMessageStatus } from "../types";
import type { ConnectionsProps } from "./connections.types";

export function renderIMessageCard(params: {
  props: ConnectionsProps;
  imessage: IMessageStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, imessage, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">iMessage</div>
      <div class="card-sub">imsg CLI and database availability.</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">Configured</span>
          <span>${imessage?.configured ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Running</span>
          <span>${imessage?.running ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">CLI</span>
          <span>${imessage?.cliPath ?? "n/a"}</span>
        </div>
        <div>
          <span class="label">DB</span>
          <span>${imessage?.dbPath ?? "n/a"}</span>
        </div>
        <div>
          <span class="label">Last start</span>
          <span>
            ${imessage?.lastStartAt ? formatAgo(imessage.lastStartAt) : "n/a"}
          </span>
        </div>
        <div>
          <span class="label">Last probe</span>
          <span>
            ${imessage?.lastProbeAt ? formatAgo(imessage.lastProbeAt) : "n/a"}
          </span>
        </div>
      </div>

      ${imessage?.lastError
        ? html`<div class="callout danger" style="margin-top: 12px;">
            ${imessage.lastError}
          </div>`
        : nothing}

      ${imessage?.probe && !imessage.probe.ok
        ? html`<div class="callout" style="margin-top: 12px;">
            Probe failed · ${imessage.probe.error ?? "unknown error"}
          </div>`
        : nothing}

      <div class="form-grid" style="margin-top: 16px;">
        <label class="field">
          <span>Enabled</span>
          <select
            .value=${props.imessageForm.enabled ? "yes" : "no"}
            @change=${(e: Event) =>
              props.onIMessageChange({
                enabled: (e.target as HTMLSelectElement).value === "yes",
              })}
          >
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
        <label class="field">
          <span>CLI path</span>
          <input
            .value=${props.imessageForm.cliPath}
            @input=${(e: Event) =>
              props.onIMessageChange({
                cliPath: (e.target as HTMLInputElement).value,
              })}
            placeholder="imsg"
          />
        </label>
        <label class="field">
          <span>DB path</span>
          <input
            .value=${props.imessageForm.dbPath}
            @input=${(e: Event) =>
              props.onIMessageChange({
                dbPath: (e.target as HTMLInputElement).value,
              })}
            placeholder="~/Library/Messages/chat.db"
          />
        </label>
        <label class="field">
          <span>Service</span>
          <select
            .value=${props.imessageForm.service}
            @change=${(e: Event) =>
              props.onIMessageChange({
                service: (e.target as HTMLSelectElement).value as
                  | "auto"
                  | "imessage"
                  | "sms",
              })}
          >
            <option value="auto">Auto</option>
            <option value="imessage">iMessage</option>
            <option value="sms">SMS</option>
          </select>
        </label>
        <label class="field">
          <span>Region</span>
          <input
            .value=${props.imessageForm.region}
            @input=${(e: Event) =>
              props.onIMessageChange({
                region: (e.target as HTMLInputElement).value,
              })}
            placeholder="US"
          />
        </label>
        <label class="field">
          <span>Allow from</span>
          <input
            .value=${props.imessageForm.allowFrom}
            @input=${(e: Event) =>
              props.onIMessageChange({
                allowFrom: (e.target as HTMLInputElement).value,
              })}
            placeholder="chat_id:101, +1555"
          />
        </label>
        <label class="field">
          <span>Include attachments</span>
          <select
            .value=${props.imessageForm.includeAttachments ? "yes" : "no"}
            @change=${(e: Event) =>
              props.onIMessageChange({
                includeAttachments:
                  (e.target as HTMLSelectElement).value === "yes",
              })}
          >
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
        <label class="field">
          <span>Media max MB</span>
          <input
            .value=${props.imessageForm.mediaMaxMb}
            @input=${(e: Event) =>
              props.onIMessageChange({
                mediaMaxMb: (e.target as HTMLInputElement).value,
              })}
            placeholder="16"
          />
        </label>
      </div>

      ${props.imessageStatus
        ? html`<div class="callout" style="margin-top: 12px;">
            ${props.imessageStatus}
          </div>`
        : nothing}

      <div class="row" style="margin-top: 14px;">
        <button
          class="btn primary"
          ?disabled=${props.imessageSaving}
          @click=${() => props.onIMessageSave()}
        >
          ${props.imessageSaving ? "Saving…" : "Save"}
        </button>
        <button class="btn" @click=${() => props.onRefresh(true)}>Probe</button>
      </div>
    </div>
  `;
}

