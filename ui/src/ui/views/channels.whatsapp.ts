import { html, nothing } from "lit";
import type { WhatsAppStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { t } from "../../i18n/i18n.js";
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
      <div class="card-title">${t("whatsapp.card_title")}</div>
      <div class="card-sub">${t("whatsapp.card_subtitle")}</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">${t("whatsapp.status.configured")}</span>
          <span>${whatsapp?.configured ? t("common.yes") : t("common.no")}</span>
        </div>
        <div>
          <span class="label">${t("whatsapp.status.linked")}</span>
          <span>${whatsapp?.linked ? t("common.yes") : t("common.no")}</span>
        </div>
        <div>
          <span class="label">${t("whatsapp.status.running")}</span>
          <span>${whatsapp?.running ? t("common.yes") : t("common.no")}</span>
        </div>
        <div>
          <span class="label">${t("whatsapp.status.connected")}</span>
          <span>${whatsapp?.connected ? t("common.yes") : t("common.no")}</span>
        </div>
        <div>
          <span class="label">${t("whatsapp.status.last_connect")}</span>
          <span>
            ${whatsapp?.lastConnectedAt ? formatAgo(whatsapp.lastConnectedAt) : t("common.n_a")}
          </span>
        </div>
        <div>
          <span class="label">${t("whatsapp.status.last_message")}</span>
          <span>
            ${whatsapp?.lastMessageAt ? formatAgo(whatsapp.lastMessageAt) : t("common.n_a")}
          </span>
        </div>
        <div>
          <span class="label">${t("whatsapp.status.auth_age")}</span>
          <span>
            ${whatsapp?.authAgeMs != null ? formatDuration(whatsapp.authAgeMs) : t("common.n_a")}
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
            <img src=${props.whatsappQrDataUrl} alt="${t("whatsapp.card_title")} QR" />
          </div>`
          : nothing
      }

      <div class="row" style="margin-top: 14px; flex-wrap: wrap;">
        <button
          class="btn primary"
          ?disabled=${props.whatsappBusy}
          @click=${() => props.onWhatsAppStart(false)}
        >
          ${props.whatsappBusy ? t("whatsapp.button.working") : t("whatsapp.button.show_qr")}
        </button>
        <button
          class="btn"
          ?disabled=${props.whatsappBusy}
          @click=${() => props.onWhatsAppStart(true)}
        >
          ${t("whatsapp.button.relink")}
        </button>
        <button
          class="btn"
          ?disabled=${props.whatsappBusy}
          @click=${() => props.onWhatsAppWait()}
        >
          ${t("whatsapp.button.wait_scan")}
        </button>
        <button
          class="btn danger"
          ?disabled=${props.whatsappBusy}
          @click=${() => props.onWhatsAppLogout()}
        >
          ${t("whatsapp.button.logout")}
        </button>
        <button class="btn" @click=${() => props.onRefresh(true)}>
          ${t("common.refresh")}
        </button>
      </div>

      ${renderChannelConfigSection({ channelId: "whatsapp", props })}
    </div>
  `;
}
