import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { DiscordStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import { formatBool, formatProbeResult, formatRelativeOrNa } from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";

export function renderDiscordCard(params: {
  props: ChannelsProps;
  discord?: DiscordStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, discord, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">Discord</div>
      <div class="card-sub">${t("channelsView.subtitles.botConfig")}</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">${t("channelsView.status.configured")}</span>
          <span>${formatBool(discord?.configured)}</span>
        </div>
        <div>
          <span class="label">${t("channelsView.status.running")}</span>
          <span>${formatBool(discord?.running)}</span>
        </div>
        <div>
          <span class="label">${t("channelsView.status.lastStart")}</span>
          <span>${formatRelativeOrNa(discord?.lastStartAt)}</span>
        </div>
        <div>
          <span class="label">${t("channelsView.status.lastProbe")}</span>
          <span>${formatRelativeOrNa(discord?.lastProbeAt)}</span>
        </div>
      </div>

      ${
        discord?.lastError
          ? html`<div class="callout danger" style="margin-top: 12px;">
            ${discord.lastError}
          </div>`
          : nothing
      }

      ${
        discord?.probe
          ? html`<div class="callout" style="margin-top: 12px;">
            ${formatProbeResult(discord.probe.ok)} ·
            ${discord.probe.status ?? ""} ${discord.probe.error ?? ""}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({ channelId: "discord", props })}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${() => props.onRefresh(true)}>
          ${t("common.probe")}
        </button>
      </div>
    </div>
  `;
}
