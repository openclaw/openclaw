import { html, nothing } from "lit";
import { t } from "../../i18n/lib/translate.ts";
import { formatRelativeTimestamp } from "../format.ts";
import type { DiscordStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import {
  formatNullableBoolean,
  renderSingleAccountChannelCard,
  resolveChannelConfigured,
} from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";

export function renderDiscordCard(params: {
  props: ChannelsProps;
  discord?: DiscordStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, discord, accountCountLabel } = params;
  const configured = resolveChannelConfigured("discord", props);

  return renderSingleAccountChannelCard({
    title: t("channels.discordTitle"),
    subtitle: t("channels.discordSubtitle"),
    accountCountLabel,
    statusRows: [
      { label: t("channels.statusConfigured"), value: formatNullableBoolean(configured) },
      { label: t("channels.statusRunning"), value: discord?.running ? t("channels.statusYes") : t("channels.statusNo") },
      {
        label: t("channels.telegramLastStart"),
        value: discord?.lastStartAt ? formatRelativeTimestamp(discord.lastStartAt) : t("channels.statusNa"),
      },
      {
        label: t("channels.telegramLastProbe"),
        value: discord?.lastProbeAt ? formatRelativeTimestamp(discord.lastProbeAt) : t("channels.statusNa"),
      },
    ],
    lastError: discord?.lastError,
    secondaryCallout: discord?.probe
      ? html`<div class="callout" style="margin-top: 12px;">
          ${t("channels.btnProbe")} ${discord.probe.ok ? t("channels.telegramProbeOk") : t("channels.telegramProbeFailed")} ·
          ${discord.probe.status ?? ""} ${discord.probe.error ?? ""}
        </div>`
      : nothing,
    configSection: renderChannelConfigSection({ channelId: "discord", props }),
    footer: html`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${() => props.onRefresh(true)}>
        ${t("channels.btnProbe")}
      </button>
    </div>`,
  });
}
