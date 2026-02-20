import { html, nothing } from "lit";
import type { DiscordStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { formatRelativeTimestamp, translateUiError } from "../format.ts";
import { t } from "../i18n/index.js";
import { renderChannelConfigSection } from "./channels.config.ts";

export function renderDiscordCard(params: {
  props: ChannelsProps;
  discord?: DiscordStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, discord, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">Discord</div>
      <div class="card-sub">${t("Bot status and channel configuration.")}</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">${t("Configured")}</span>
          <span>${discord?.configured ? t("Yes") : t("No")}</span>
        </div>
        <div>
          <span class="label">${t("Running")}</span>
          <span>${discord?.running ? t("Yes") : t("No")}</span>
        </div>
        <div>
          <span class="label">${t("Last start")}</span>
          <span>${discord?.lastStartAt ? formatRelativeTimestamp(discord.lastStartAt) : "n/a"}</span>
        </div>
        <div>
          <span class="label">${t("Last probe")}</span>
          <span>${discord?.lastProbeAt ? formatRelativeTimestamp(discord.lastProbeAt) : "n/a"}</span>
        </div>
      </div>

      ${
        discord?.lastError
          ? html`<div class="callout danger" style="margin-top: 12px;">
            ${translateUiError(discord.lastError)}
          </div>`
          : nothing
      }

      ${
        discord?.probe
          ? html`<div class="callout" style="margin-top: 12px;">
            ${t("Probe")} ${discord.probe.ok ? t("ok") : t("failed")} ·
            ${discord.probe.status ?? ""} ${discord.probe.error ?? ""}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({ channelId: "discord", props })}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${() => props.onRefresh(true)}>
          ${t("Probe")}
        </button>
      </div>
    </div>
  `;
}
