import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { SlackStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import { formatBool, formatProbeResult, formatRelativeOrNa } from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";

export function renderSlackCard(params: {
  props: ChannelsProps;
  slack?: SlackStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, slack, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">Slack</div>
      <div class="card-sub">${t("channelsView.subtitles.slack")}</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">${t("channelsView.status.configured")}</span>
          <span>${formatBool(slack?.configured)}</span>
        </div>
        <div>
          <span class="label">${t("channelsView.status.running")}</span>
          <span>${formatBool(slack?.running)}</span>
        </div>
        <div>
          <span class="label">${t("channelsView.status.lastStart")}</span>
          <span>${formatRelativeOrNa(slack?.lastStartAt)}</span>
        </div>
        <div>
          <span class="label">${t("channelsView.status.lastProbe")}</span>
          <span>${formatRelativeOrNa(slack?.lastProbeAt)}</span>
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
            ${formatProbeResult(slack.probe.ok)} ·
            ${slack.probe.status ?? ""} ${slack.probe.error ?? ""}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({ channelId: "slack", props })}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${() => props.onRefresh(true)}>
          ${t("common.probe")}
        </button>
      </div>
    </div>
  `;
}
