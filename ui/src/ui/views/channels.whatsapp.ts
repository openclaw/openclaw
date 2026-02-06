import { msg } from "@lit/localize";
import { html, nothing } from "lit";
import type { WhatsAppStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { formatAgo } from "../format.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import { formatDuration } from "./channels.shared.ts";

export function renderWhatsAppCard(params: {
  props: ChannelsProps;
  whatsapp?: WhatsAppStatus;
  accountCountLabel: unknown;
}) {
  const { props, whatsapp, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">${msg("WhatsApp", { id: "channels.whatsapp.title" })}</div>
      <div class="card-sub">${msg("Link WhatsApp Web and monitor connection health.", {
        id: "channels.whatsapp.sub",
      })}</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">${msg("Configured", { id: "channels.whatsapp.configured" })}</span>
          <span>${whatsapp?.configured ? msg("Yes", { id: "channels.whatsapp.yes" }) : msg("No", { id: "channels.whatsapp.no" })}</span>
        </div>
        <div>
          <span class="label">${msg("Linked", { id: "channels.whatsapp.linked" })}</span>
          <span>${whatsapp?.linked ? msg("Yes", { id: "channels.whatsapp.yes" }) : msg("No", { id: "channels.whatsapp.no" })}</span>
        </div>
        <div>
          <span class="label">${msg("Running", { id: "channels.whatsapp.running" })}</span>
          <span>${whatsapp?.running ? msg("Yes", { id: "channels.whatsapp.yes" }) : msg("No", { id: "channels.whatsapp.no" })}</span>
        </div>
        <div>
          <span class="label">${msg("Connected", { id: "channels.whatsapp.connected" })}</span>
          <span>${whatsapp?.connected ? msg("Yes", { id: "channels.whatsapp.yes" }) : msg("No", { id: "channels.whatsapp.no" })}</span>
        </div>
        <div>
          <span class="label">${msg("Last connect", { id: "channels.whatsapp.lastConnect" })}</span>
          <span>
            ${whatsapp?.lastConnectedAt ? formatAgo(whatsapp.lastConnectedAt) : msg("n/a", { id: "channels.whatsapp.na" })}
          </span>
        </div>
        <div>
          <span class="label">${msg("Last message", { id: "channels.whatsapp.lastMessage" })}</span>
          <span>
            ${whatsapp?.lastMessageAt ? formatAgo(whatsapp.lastMessageAt) : msg("n/a", { id: "channels.whatsapp.na" })}
          </span>
        </div>
        <div>
          <span class="label">${msg("Auth age", { id: "channels.whatsapp.authAge" })}</span>
          <span>
            ${whatsapp?.authAgeMs != null ? formatDuration(whatsapp.authAgeMs) : msg("n/a", { id: "channels.whatsapp.na" })}
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
            <img src=${props.whatsappQrDataUrl} alt=${msg("WhatsApp QR", { id: "channels.whatsapp.qrAlt" })} />
          </div>`
          : nothing
      }

      <div class="row" style="margin-top: 14px; flex-wrap: wrap;">
        <button
          class="btn primary"
          ?disabled=${props.whatsappBusy}
          @click=${() => props.onWhatsAppStart(false)}
        >
          ${
            props.whatsappBusy
              ? msg("Working…", { id: "channels.whatsapp.working" })
              : msg("Show QR", { id: "channels.whatsapp.showQr" })
          }
        </button>
        <button
          class="btn"
          ?disabled=${props.whatsappBusy}
          @click=${() => props.onWhatsAppStart(true)}
        >
          ${msg("Relink", { id: "channels.whatsapp.relink" })}
        </button>
        <button
          class="btn"
          ?disabled=${props.whatsappBusy}
          @click=${() => props.onWhatsAppWait()}
        >
          ${msg("Wait for scan", { id: "channels.whatsapp.waitScan" })}
        </button>
        <button
          class="btn danger"
          ?disabled=${props.whatsappBusy}
          @click=${() => props.onWhatsAppLogout()}
        >
          ${msg("Logout", { id: "channels.whatsapp.logout" })}
        </button>
        <button class="btn" @click=${() => props.onRefresh(true)}>
          ${msg("Refresh", { id: "channels.whatsapp.refresh" })}
        </button>
      </div>

      ${renderChannelConfigSection({ channelId: "whatsapp", props })}
    </div>
  `;
}
