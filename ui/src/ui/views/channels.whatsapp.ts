import { html, nothing } from "lit";
import type { WhatsAppStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { formatRelativeTimestamp, formatDurationHuman, translateUiError } from "../format.ts";
import { t } from "../i18n/index.js";
import { renderChannelConfigSection } from "./channels.config.ts";

export function renderWhatsAppCard(params: {
  props: ChannelsProps;
  whatsapp?: WhatsAppStatus;
  accountCountLabel: unknown;
}) {
  const { props, whatsapp, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">WhatsApp</div>
      <div class="card-sub">${t("Link WhatsApp Web and monitor connection health.")}</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">${t("Configured")}</span>
          <span>${whatsapp?.configured ? t("Yes") : t("No")}</span>
        </div>
        <div>
          <span class="label">${t("Linked")}</span>
          <span>${whatsapp?.linked ? t("Yes") : t("No")}</span>
        </div>
        <div>
          <span class="label">${t("Running")}</span>
          <span>${whatsapp?.running ? t("Yes") : t("No")}</span>
        </div>
        <div>
          <span class="label">${t("Connected")}</span>
          <span>${whatsapp?.connected ? t("Yes") : t("No")}</span>
        </div>
        <div>
          <span class="label">${t("Last connect")}</span>
          <span>
            ${whatsapp?.lastConnectedAt ? formatRelativeTimestamp(whatsapp.lastConnectedAt) : "n/a"}
          </span>
        </div>
        <div>
          <span class="label">${t("Last message")}</span>
          <span>
            ${whatsapp?.lastMessageAt ? formatRelativeTimestamp(whatsapp.lastMessageAt) : "n/a"}
          </span>
        </div>
        <div>
          <span class="label">${t("Auth age")}</span>
          <span>
            ${whatsapp?.authAgeMs != null ? formatDurationHuman(whatsapp.authAgeMs) : "n/a"}
          </span>
        </div>
      </div>

      ${
        whatsapp?.lastError
          ? html`<div class="callout danger" style="margin-top: 12px;">
            ${translateUiError(whatsapp.lastError)}
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
          ${props.whatsappBusy ? t("Working…") : t("Show QR")}
        </button>
        <button
          class="btn"
          ?disabled=${props.whatsappBusy}
          @click=${() => props.onWhatsAppStart(true)}
        >
          ${t("Relink")}
        </button>
        <button
          class="btn"
          ?disabled=${props.whatsappBusy}
          @click=${() => props.onWhatsAppWait()}
        >
          ${t("Wait for scan")}
        </button>
        <button
          class="btn danger"
          ?disabled=${props.whatsappBusy}
          @click=${() => props.onWhatsAppLogout()}
        >
          ${t("Logout")}
        </button>
        <button class="btn" @click=${() => props.onRefresh(true)}>
          ${t("Refresh")}
        </button>
      </div>

      ${renderChannelConfigSection({ channelId: "whatsapp", props })}
    </div>
  `;
}
