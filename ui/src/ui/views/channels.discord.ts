import { html, nothing } from "lit";
import type { DiscordStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { formatRelativeTimestamp } from "../format.ts";
import { icons } from "../icons.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import { statusChip } from "./channels.shared.ts";

export function renderDiscordCard(params: {
  props: ChannelsProps;
  discord?: DiscordStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, discord, accountCountLabel } = params;

  return html`
    <div class="card" style="padding: 0;">
      <div style="padding: 12px 14px; border-bottom: 1px solid var(--border);">
        <div class="card-title" style="margin: 0; display: flex; align-items: center; gap: 8px;">
          <span class="icon" style="width: 16px; height: 16px;">${icons.messageSquare}</span>
          Discord
        </div>
        <div class="card-sub" style="margin: 0;">Bot status and channel configuration.</div>
        ${accountCountLabel}
      </div>

      <div style="padding: 12px 14px;">
        <div class="status-list">
          <div>
            <span class="label">Configured</span>
            ${statusChip(discord?.configured)}
          </div>
          <div>
            <span class="label">Running</span>
            ${statusChip(discord?.running)}
          </div>
          <div>
            <span class="label">Last start</span>
            <span>${discord?.lastStartAt ? formatRelativeTimestamp(discord.lastStartAt) : "n/a"}</span>
          </div>
          <div>
            <span class="label">Last probe</span>
            <span>${discord?.lastProbeAt ? formatRelativeTimestamp(discord.lastProbeAt) : "n/a"}</span>
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
              Probe ${discord.probe.ok ? "ok" : "failed"} ·
              ${discord.probe.status ?? ""} ${discord.probe.error ?? ""}
            </div>`
            : nothing
        }

        ${renderChannelConfigSection({ channelId: "discord", props })}

        <div class="row" style="margin-top: 12px;">
          <button class="btn" @click=${() => props.onRefresh(true)}>
            Probe
          </button>
        </div>
      </div>
    </div>
  `;
}
