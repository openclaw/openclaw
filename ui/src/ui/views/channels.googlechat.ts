import { html, nothing } from "lit";
import type { GoogleChatStatus } from "../types";
import type { ChannelsProps } from "./channels.types";
import { t } from "../../i18n/i18n";
import { formatAgo } from "../format";
import { renderChannelConfigSection } from "./channels.config";

export function renderGoogleChatCard(params: {
  props: ChannelsProps;
  googleChat?: GoogleChatStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, googleChat, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">${t("googlechat.card_title")}</div>
      <div class="card-sub">${t("googlechat.card_subtitle")}</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">${t("googlechat.status.configured")}</span>
          <span>${googleChat ? (googleChat.configured ? t("common.yes") : t("common.no")) : t("common.n_a")}</span>
        </div>
        <div>
          <span class="label">${t("googlechat.status.running")}</span>
          <span>${googleChat ? (googleChat.running ? t("common.yes") : t("common.no")) : t("common.n_a")}</span>
        </div>
        <div>
          <span class="label">${t("googlechat.status.credential")}</span>
          <span>${googleChat?.credentialSource ?? t("common.n_a")}</span>
        </div>
        <div>
          <span class="label">${t("googlechat.status.audience")}</span>
          <span>
            ${
              googleChat?.audienceType
                ? `${googleChat.audienceType}${googleChat.audience ? ` · ${googleChat.audience}` : ""}`
                : t("common.n_a")
            }
          </span>
        </div>
        <div>
          <span class="label">${t("googlechat.status.last_start")}</span>
          <span>${googleChat?.lastStartAt ? formatAgo(googleChat.lastStartAt) : t("common.n_a")}</span>
        </div>
        <div>
          <span class="label">${t("googlechat.status.last_probe")}</span>
          <span>${googleChat?.lastProbeAt ? formatAgo(googleChat.lastProbeAt) : t("common.n_a")}</span>
        </div>
      </div>

      ${
        googleChat?.lastError
          ? html`<div class="callout danger" style="margin-top: 12px;">
            ${googleChat.lastError}
          </div>`
          : nothing
      }

      ${
        googleChat?.probe
          ? html`<div class="callout" style="margin-top: 12px;">
            ${t("googlechat.button.probe")} ${googleChat.probe.ok ? "ok" : "failed"} ·
            ${googleChat.probe.status ?? ""} ${googleChat.probe.error ?? ""}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({ channelId: "googlechat", props })}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${() => props.onRefresh(true)}>
          ${t("googlechat.button.probe")}
        </button>
      </div>
    </div>
  `;
}
