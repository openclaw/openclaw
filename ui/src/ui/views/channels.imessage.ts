import { html, nothing } from "lit";
import type { IMessageStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { formatRelativeTimestamp } from "../format.ts";
import { icons } from "../icons.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import { statusChip } from "./channels.shared.ts";

export function renderIMessageCard(params: {
  props: ChannelsProps;
  imessage?: IMessageStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, imessage, accountCountLabel } = params;

  return html`
    <div class="card" style="padding: 0;">
      <div style="padding: 12px 14px; border-bottom: 1px solid var(--border);">
        <div class="card-title" style="margin: 0; display: flex; align-items: center; gap: 8px;">
          <span class="icon" style="width: 16px; height: 16px;">${icons.messageSquare}</span>
          iMessage
        </div>
        <div class="card-sub" style="margin: 0;">macOS bridge status and channel configuration.</div>
        ${accountCountLabel}
      </div>

      <div style="padding: 12px 14px;">
        <div class="status-list">
          <div>
            <span class="label">Configured</span>
            ${statusChip(imessage?.configured)}
          </div>
          <div>
            <span class="label">Running</span>
            ${statusChip(imessage?.running)}
          </div>
          <div>
            <span class="label">Last start</span>
            <span>${imessage?.lastStartAt ? formatRelativeTimestamp(imessage.lastStartAt) : "n/a"}</span>
          </div>
          <div>
            <span class="label">Last probe</span>
            <span>${imessage?.lastProbeAt ? formatRelativeTimestamp(imessage.lastProbeAt) : "n/a"}</span>
          </div>
        </div>

        ${
          imessage?.lastError
            ? html`<div class="callout danger" style="margin-top: 12px;">
              ${imessage.lastError}
            </div>`
            : nothing
        }

        ${
          imessage?.probe
            ? html`<div class="callout" style="margin-top: 12px;">
              Probe ${imessage.probe.ok ? "ok" : "failed"} ·
              ${imessage.probe.error ?? ""}
            </div>`
            : nothing
        }

        ${renderChannelConfigSection({ channelId: "imessage", props })}

        <div class="row" style="margin-top: 12px;">
          <button class="btn" @click=${() => props.onRefresh(true)}>
            Probe
          </button>
        </div>
      </div>
    </div>
  `;
}
