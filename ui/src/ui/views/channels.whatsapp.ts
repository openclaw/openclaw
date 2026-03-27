import { html, nothing } from "lit";
import { t } from "../../i18n/lib/translate.ts";
import { formatRelativeTimestamp, formatDurationHuman } from "../format.ts";
import type { WhatsAppStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import {
  formatNullableBoolean,
  renderSingleAccountChannelCard,
  resolveChannelConfigured,
} from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";

export function renderWhatsAppCard(params: {
  props: ChannelsProps;
  whatsapp?: WhatsAppStatus;
  accountCountLabel: unknown;
}) {
  const { props, whatsapp, accountCountLabel } = params;
  const configured = resolveChannelConfigured("whatsapp", props);

  return renderSingleAccountChannelCard({
    title: t("channels.whatsappTitle"),
    subtitle: t("channels.whatsappSubtitle"),
    accountCountLabel,
    statusRows: [
      { label: t("channels.whatsappConfigured"), value: formatNullableBoolean(configured) },
      { label: t("channels.whatsappLinked"), value: whatsapp?.linked ? t("channels.statusYes") : t("channels.statusNo") },
      { label: t("channels.whatsappRunning"), value: whatsapp?.running ? t("channels.statusYes") : t("channels.statusNo") },
      { label: t("channels.whatsappConnected"), value: whatsapp?.connected ? t("channels.statusYes") : t("channels.statusNo") },
      {
        label: t("channels.whatsappLastConnect"),
        value: whatsapp?.lastConnectedAt
          ? formatRelativeTimestamp(whatsapp.lastConnectedAt)
          : t("channels.statusNa"),
      },
      {
        label: t("channels.whatsappLastMessage"),
        value: whatsapp?.lastMessageAt ? formatRelativeTimestamp(whatsapp.lastMessageAt) : t("channels.statusNa"),
      },
      {
        label: t("channels.whatsappAuthAge"),
        value: whatsapp?.authAgeMs != null ? formatDurationHuman(whatsapp.authAgeMs) : t("channels.statusNa"),
      },
    ],
    lastError: whatsapp?.lastError,
    extraContent: html`
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
              <img src=${props.whatsappQrDataUrl} alt=${t("channels.whatsappTitle")} />
            </div>`
          : nothing
      }
    `,
    configSection: renderChannelConfigSection({ channelId: "whatsapp", props }),
    footer: html`<div class="row" style="margin-top: 14px; flex-wrap: wrap;">
      <button
        class="btn primary"
        ?disabled=${props.whatsappBusy}
        @click=${() => props.onWhatsAppStart(false)}
      >
        ${props.whatsappBusy ? t("channels.whatsappWorking") : t("channels.whatsappShowQr")}
      </button>
      <button
        class="btn"
        ?disabled=${props.whatsappBusy}
        @click=${() => props.onWhatsAppStart(true)}
      >
        ${t("channels.whatsappRelink")}
      </button>
      <button
        class="btn"
        ?disabled=${props.whatsappBusy}
        @click=${() => props.onWhatsAppWait()}
      >
        ${t("channels.whatsappWaitForScan")}
      </button>
      <button
        class="btn danger"
        ?disabled=${props.whatsappBusy}
        @click=${() => props.onWhatsAppLogout()}
      >
        ${t("channels.whatsappLogout")}
      </button>
      <button class="btn" @click=${() => props.onRefresh(true)}>
        ${t("channels.whatsappRefresh")}
      </button>
    </div>`,
  });
}
