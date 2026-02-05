import { html, nothing } from "lit";
import type { SlackStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { t } from "../../i18n/i18n.js";
import { formatAgo } from "../format.ts";
import { renderChannelConfigSection } from "./channels.config.ts";

export function renderSlackCard(params: {
  props: ChannelsProps;
  slack?: SlackStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, slack, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">${t("slack.card_title")}</div>
      <div class="card-sub">${t("slack.card_subtitle")}</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">${t("slack.status.configured")}</span>
          <span>${slack?.configured ? t("common.yes") : t("common.no")}</span>
        </div>
        <div>
          <span class="label">${t("slack.status.running")}</span>
          <span>${slack?.running ? t("common.yes") : t("common.no")}</span>
        </div>
        <div>
          <span class="label">${t("slack.status.last_start")}</span>
          <span>${slack?.lastStartAt ? formatAgo(slack.lastStartAt) : t("common.n_a")}</span>
        </div>
        <div>
          <span class="label">${t("slack.status.last_probe")}</span>
          <span>${slack?.lastProbeAt ? formatAgo(slack.lastProbeAt) : t("common.n_a")}</span>
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
            ${t("slack.button.probe")} ${slack.probe.ok ? "ok" : "failed"} ·
            ${slack.probe.status ?? ""} ${slack.probe.error ?? ""}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({ channelId: "slack", props })}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${() => props.onRefresh(true)}>
          ${t("slack.button.probe")}
        </button>
      </div>
    </div>
  `;
}
