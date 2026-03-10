import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { WhatsAppStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import { formatBool, formatDurationOrNa, formatRelativeOrNa } from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";

export function renderWhatsAppCard(params: {
  props: ChannelsProps;
  whatsapp?: WhatsAppStatus;
  accountCountLabel: unknown;
}) {
  const { props, whatsapp, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">WhatsApp</div>
      <div class="card-sub">${t("channelsView.subtitles.whatsapp")}</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">${t("channelsView.status.configured")}</span>
          <span>${formatBool(whatsapp?.configured)}</span>
        </div>
        <div>
          <span class="label">${t("channelsView.status.linked")}</span>
          <span>${formatBool(whatsapp?.linked)}</span>
        </div>
        <div>
          <span class="label">${t("channelsView.status.running")}</span>
          <span>${formatBool(whatsapp?.running)}</span>
        </div>
        <div>
          <span class="label">${t("channelsView.status.connected")}</span>
          <span>${formatBool(whatsapp?.connected)}</span>
        </div>
        <div>
          <span class="label">${t("channelsView.status.lastConnect")}</span>
          <span>${formatRelativeOrNa(whatsapp?.lastConnectedAt)}</span>
        </div>
        <div>
          <span class="label">${t("channelsView.status.lastMessage")}</span>
          <span>${formatRelativeOrNa(whatsapp?.lastMessageAt)}</span>
        </div>
        <div>
          <span class="label">${t("channelsView.status.authAge")}</span>
          <span>${formatDurationOrNa(whatsapp?.authAgeMs)}</span>
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
          ${props.whatsappBusy ? t("common.working") : t("channelsView.actions.showQr")}
        </button>
        <button
          class="btn"
          ?disabled=${props.whatsappBusy}
          @click=${() => props.onWhatsAppStart(true)}
        >
          ${t("channelsView.actions.relink")}
        </button>
        <button
          class="btn"
          ?disabled=${props.whatsappBusy}
          @click=${() => props.onWhatsAppWait()}
        >
          ${t("channelsView.actions.waitForScan")}
        </button>
        <button
          class="btn danger"
          ?disabled=${props.whatsappBusy}
          @click=${() => props.onWhatsAppLogout()}
        >
          ${t("channelsView.actions.logout")}
        </button>
        <button class="btn" @click=${() => props.onRefresh(true)}>
          ${t("common.refresh")}
        </button>
      </div>

      ${renderChannelConfigSection({ channelId: "whatsapp", props })}
    </div>
  `;
}
