import { html, nothing } from "lit";
import type { DiscordStatus } from "../types";
import type { ChannelsProps } from "./channels.types";
import { t } from "../../i18n/i18n";
import { formatAgo } from "../format";
import { renderChannelConfigSection } from "./channels.config";

export function renderDiscordCard(params: {
  props: ChannelsProps;
  discord?: DiscordStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, discord, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">${t("discord.card_title")}</div>
      <div class="card-sub">${t("discord.card_subtitle")}</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">${t("discord.status.configured")}</span>
          <span>${discord?.configured ? t("common.yes") : t("common.no")}</span>
        </div>
        <div>
          <span class="label">${t("discord.status.running")}</span>
          <span>${discord?.running ? t("common.yes") : t("common.no")}</span>
        </div>
        <div>
          <span class="label">${t("discord.status.last_start")}</span>
          <span>${discord?.lastStartAt ? formatAgo(discord.lastStartAt) : t("common.n_a")}</span>
        </div>
        <div>
          <span class="label">${t("discord.status.last_probe")}</span>
          <span>${discord?.lastProbeAt ? formatAgo(discord.lastProbeAt) : t("common.n_a")}</span>
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
            ${t("discord.button.probe")} ${discord.probe.ok ? "ok" : "failed"} ·
            ${discord.probe.status ?? ""} ${discord.probe.error ?? ""}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({ channelId: "discord", props })}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${() => props.onRefresh(true)}>
          ${t("discord.button.probe")}
        </button>
      </div>
    </div>
  `;
}
