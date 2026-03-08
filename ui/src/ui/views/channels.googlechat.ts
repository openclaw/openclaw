import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { GoogleChatStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import { formatBool, formatProbeResult, formatRelativeOrNa } from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";

export function renderGoogleChatCard(params: {
  props: ChannelsProps;
  googleChat?: GoogleChatStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, googleChat, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">Google Chat</div>
      <div class="card-sub">${t("channelsView.subtitles.googleChat")}</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">${t("channelsView.status.configured")}</span>
          <span>${googleChat ? formatBool(googleChat.configured) : t("common.na")}</span>
        </div>
        <div>
          <span class="label">${t("channelsView.status.running")}</span>
          <span>${googleChat ? formatBool(googleChat.running) : t("common.na")}</span>
        </div>
        <div>
          <span class="label">${t("channelsView.status.credential")}</span>
          <span>${googleChat?.credentialSource ?? t("common.na")}</span>
        </div>
        <div>
          <span class="label">${t("channelsView.status.audience")}</span>
          <span>
            ${
              googleChat?.audienceType
                ? `${googleChat.audienceType}${googleChat.audience ? ` · ${googleChat.audience}` : ""}`
                : t("common.na")
            }
          </span>
        </div>
        <div>
          <span class="label">${t("channelsView.status.lastStart")}</span>
          <span>${formatRelativeOrNa(googleChat?.lastStartAt)}</span>
        </div>
        <div>
          <span class="label">${t("channelsView.status.lastProbe")}</span>
          <span>${formatRelativeOrNa(googleChat?.lastProbeAt)}</span>
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
            ${formatProbeResult(googleChat.probe.ok)} ·
            ${googleChat.probe.status ?? ""} ${googleChat.probe.error ?? ""}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({ channelId: "googlechat", props })}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${() => props.onRefresh(true)}>
          ${t("common.probe")}
        </button>
      </div>
    </div>
  `;
}
