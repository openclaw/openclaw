import { html, nothing } from "lit";
import type { SlackStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { formatRelativeTimestamp } from "../format.ts";
import { icons } from "../icons.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import { statusChip } from "./channels.shared.ts";

export function renderSlackCard(params: {
  props: ChannelsProps;
  slack?: SlackStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, slack, accountCountLabel } = params;

  return html`
    <div class="card" style="padding: 0;">
      <div style="padding: 12px 14px; border-bottom: 1px solid var(--border);">
        <div class="card-title" style="margin: 0; display: flex; align-items: center; gap: 8px;">
          <span class="icon" style="width: 16px; height: 16px;">${icons.messageSquare}</span>
          Slack
        </div>
        <div class="card-sub" style="margin: 0;">Socket mode status and channel configuration.</div>
        ${accountCountLabel}
      </div>

      <div style="padding: 12px 14px;">
        <div class="status-list">
          <div>
            <span class="label">Configured</span>
            ${statusChip(slack?.configured)}
          </div>
          <div>
            <span class="label">Running</span>
            ${statusChip(slack?.running)}
          </div>
          <div>
            <span class="label">Last start</span>
            <span>${slack?.lastStartAt ? formatRelativeTimestamp(slack.lastStartAt) : "n/a"}</span>
          </div>
          <div>
            <span class="label">Last probe</span>
            <span>${slack?.lastProbeAt ? formatRelativeTimestamp(slack.lastProbeAt) : "n/a"}</span>
          </div>
        </div>

        ${
          slack?.lastError
            ? html`<div class="callout danger" style="margin-top: 12px;">
              ${slack.lastError}
            </div>`
            : nothing
        }

        ${
          slack?.probe
            ? html`<div class="callout" style="margin-top: 12px;">
              Probe ${slack.probe.ok ? "ok" : "failed"} ·
              ${slack.probe.status ?? ""} ${slack.probe.error ?? ""}
            </div>`
            : nothing
        }

        ${renderChannelConfigSection({ channelId: "slack", props })}

        <div class="row" style="margin-top: 12px;">
          <button class="btn" @click=${() => props.onRefresh(true)}>
            Probe
          </button>
        </div>
      </div>
    </div>
  `;
}
