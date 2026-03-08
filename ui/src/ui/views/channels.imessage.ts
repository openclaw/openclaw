import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { IMessageStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import { formatBool, formatProbeResult, formatRelativeOrNa } from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";

export function renderIMessageCard(params: {
  props: ChannelsProps;
  imessage?: IMessageStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, imessage, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">iMessage</div>
      <div class="card-sub">${t("channelsView.subtitles.imessage")}</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">${t("channelsView.status.configured")}</span>
          <span>${formatBool(imessage?.configured)}</span>
        </div>
        <div>
          <span class="label">${t("channelsView.status.running")}</span>
          <span>${formatBool(imessage?.running)}</span>
        </div>
        <div>
          <span class="label">${t("channelsView.status.lastStart")}</span>
          <span>${formatRelativeOrNa(imessage?.lastStartAt)}</span>
        </div>
        <div>
          <span class="label">${t("channelsView.status.lastProbe")}</span>
          <span>${formatRelativeOrNa(imessage?.lastProbeAt)}</span>
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
            ${formatProbeResult(imessage.probe.ok)} ·
            ${imessage.probe.error ?? ""}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({ channelId: "imessage", props })}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${() => props.onRefresh(true)}>
          ${t("common.probe")}
        </button>
      </div>
    </div>
  `;
}
