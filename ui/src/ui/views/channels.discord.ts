import { msg } from "@lit/localize";
import { html, nothing } from "lit";
import type { DiscordStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { formatAgo } from "../format.ts";
import { renderChannelConfigSection } from "./channels.config.ts";

export function renderDiscordCard(params: {
  props: ChannelsProps;
  discord?: DiscordStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, discord, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">${msg("Discord", { id: "channels.discord.title" })}</div>
      <div class="card-sub">${msg("Bot status and channel configuration.", {
        id: "channels.discord.sub",
      })}</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">${msg("Configured", { id: "channels.discord.configured" })}</span>
          <span>${discord?.configured ? msg("Yes", { id: "channels.discord.yes" }) : msg("No", { id: "channels.discord.no" })}</span>
        </div>
        <div>
          <span class="label">${msg("Running", { id: "channels.discord.running" })}</span>
          <span>${discord?.running ? msg("Yes", { id: "channels.discord.yes" }) : msg("No", { id: "channels.discord.no" })}</span>
        </div>
        <div>
          <span class="label">${msg("Last start", { id: "channels.discord.lastStart" })}</span>
          <span>${discord?.lastStartAt ? formatAgo(discord.lastStartAt) : msg("n/a", { id: "channels.discord.na" })}</span>
        </div>
        <div>
          <span class="label">${msg("Last probe", { id: "channels.discord.lastProbe" })}</span>
          <span>${discord?.lastProbeAt ? formatAgo(discord.lastProbeAt) : msg("n/a", { id: "channels.discord.na" })}</span>
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
            ${msg("Probe", { id: "channels.discord.probe" })} ${discord.probe.ok ? msg("ok", { id: "channels.discord.probeOk" }) : msg("failed", { id: "channels.discord.probeFailed" })} ·
            ${discord.probe.status ?? ""} ${discord.probe.error ?? ""}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({ channelId: "discord", props })}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${() => props.onRefresh(true)}>
          ${msg("Probe", { id: "channels.discord.probeButton" })}
        </button>
      </div>
    </div>
  `;
}
