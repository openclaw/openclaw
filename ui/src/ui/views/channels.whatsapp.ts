import { html, nothing } from "lit";
import type { WhatsAppStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { formatRelativeTimestamp, formatDurationHuman } from "../format.ts";
import { icons } from "../icons.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import { statusChip } from "./channels.shared.ts";

export function renderWhatsAppCard(params: {
  props: ChannelsProps;
  whatsapp?: WhatsAppStatus;
  accountCountLabel: unknown;
}) {
  const { props, whatsapp, accountCountLabel } = params;

  return html`
    <div class="card" style="padding: 0;">
      <div style="padding: 12px 14px; border-bottom: 1px solid var(--border);">
        <div class="card-title" style="margin: 0; display: flex; align-items: center; gap: 8px;">
          <span class="icon" style="width: 16px; height: 16px;">${icons.smartphone}</span>
          WhatsApp
        </div>
        <div class="card-sub" style="margin: 0;">Link WhatsApp Web and monitor connection health.</div>
        ${accountCountLabel}
      </div>

      <div style="padding: 12px 14px;">
        <div class="status-list">
          <div>
            <span class="label">Configured</span>
            ${statusChip(whatsapp?.configured)}
          </div>
          <div>
            <span class="label">Linked</span>
            ${statusChip(whatsapp?.linked)}
          </div>
          <div>
            <span class="label">Running</span>
            ${statusChip(whatsapp?.running)}
          </div>
          <div>
            <span class="label">Connected</span>
            ${statusChip(whatsapp?.connected)}
          </div>
          <div>
            <span class="label">Last connect</span>
            <span>
              ${whatsapp?.lastConnectedAt ? formatRelativeTimestamp(whatsapp.lastConnectedAt) : "n/a"}
            </span>
          </div>
          <div>
            <span class="label">Last message</span>
            <span>
              ${whatsapp?.lastMessageAt ? formatRelativeTimestamp(whatsapp.lastMessageAt) : "n/a"}
            </span>
          </div>
          <div>
            <span class="label">Auth age</span>
            <span>
              ${whatsapp?.authAgeMs != null ? formatDurationHuman(whatsapp.authAgeMs) : "n/a"}
            </span>
          </div>
        </div>

        ${
          whatsapp?.lastError
            ? html`<div class="callout danger" style="margin-top: 12px;">
              ${whatsapp.lastError}
            </div>`
            : nothing
        }

        ${
          props.whatsappMessage
            ? html`<div class="callout" style="margin-top: 12px;">
              ${props.whatsappMessage}
            </div>`
            : nothing
        }

        ${
          props.whatsappQrDataUrl
            ? html`<div class="qr-wrap">
              <img src=${props.whatsappQrDataUrl} alt="WhatsApp QR" />
            </div>`
            : nothing
        }

        <div class="row" style="margin-top: 14px; flex-wrap: wrap;">
          <button
            class="btn primary"
            ?disabled=${props.whatsappBusy}
            @click=${() => props.onWhatsAppStart(false)}
          >
            ${props.whatsappBusy ? "Working…" : "Show QR"}
          </button>
          <button
            class="btn"
            ?disabled=${props.whatsappBusy}
            @click=${() => props.onWhatsAppStart(true)}
          >
            Relink
          </button>
          <button
            class="btn"
            ?disabled=${props.whatsappBusy}
            @click=${() => props.onWhatsAppWait()}
          >
            Wait for scan
          </button>
          <button
            class="btn danger"
            ?disabled=${props.whatsappBusy}
            @click=${() => props.onWhatsAppLogout()}
          >
            Logout
          </button>
          <button class="btn" @click=${() => props.onRefresh(true)}>
            Refresh
          </button>
        </div>

        ${renderChannelConfigSection({ channelId: "whatsapp", props })}
      </div>
    </div>
  `;
}
