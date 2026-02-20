import { html, nothing } from "lit";
import type { SlackStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { formatRelativeTimestamp, translateUiError } from "../format.ts";
import { t } from "../i18n/index.js";
import { renderChannelConfigSection } from "./channels.config.ts";

export function renderSlackCard(params: {
  props: ChannelsProps;
  slack?: SlackStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, slack, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">Slack</div>
      <div class="card-sub">${t("Socket mode status and channel configuration.")}</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">${t("Configured")}</span>
          <span>${slack?.configured ? t("Yes") : t("No")}</span>
        </div>
        <div>
          <span class="label">${t("Running")}</span>
          <span>${slack?.running ? t("Yes") : t("No")}</span>
        </div>
        <div>
          <span class="label">${t("Last start")}</span>
          <span>${slack?.lastStartAt ? formatRelativeTimestamp(slack.lastStartAt) : "n/a"}</span>
        </div>
        <div>
          <span class="label">${t("Last probe")}</span>
          <span>${slack?.lastProbeAt ? formatRelativeTimestamp(slack.lastProbeAt) : "n/a"}</span>
        </div>
      </div>

      ${
        slack?.lastError
          ? html`<div class="callout danger" style="margin-top: 12px;">
            ${translateUiError(slack.lastError)}
          </div>`
          : nothing
      }

      ${
        slack?.probe
          ? html`<div class="callout" style="margin-top: 12px;">
            ${t("Probe")} ${slack.probe.ok ? t("ok") : t("failed")} ·
            ${slack.probe.status ?? ""} ${slack.probe.error ?? ""}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({ channelId: "slack", props })}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${() => props.onRefresh(true)}>
          ${t("Probe")}
        </button>
      </div>
    </div>
  `;
}
