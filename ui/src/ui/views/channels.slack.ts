import { html, nothing } from "lit";
import { t } from "../../i18n/lib/translate.ts";
import { formatRelativeTimestamp } from "../format.ts";
import type { SlackStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import {
  formatNullableBoolean,
  renderSingleAccountChannelCard,
  resolveChannelConfigured,
} from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";

export function renderSlackCard(params: {
  props: ChannelsProps;
  slack?: SlackStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, slack, accountCountLabel } = params;
  const configured = resolveChannelConfigured("slack", props);

  return renderSingleAccountChannelCard({
    title: t("channels.slackTitle"),
    subtitle: t("channels.slackSubtitle"),
    accountCountLabel,
    statusRows: [
      { label: t("channels.statusConfigured"), value: formatNullableBoolean(configured) },
      { label: t("channels.statusRunning"), value: slack?.running ? t("channels.statusYes") : t("channels.statusNo") },
      {
        label: t("channels.telegramLastStart"),
        value: slack?.lastStartAt ? formatRelativeTimestamp(slack.lastStartAt) : t("channels.statusNa"),
      },
      {
        label: t("channels.telegramLastProbe"),
        value: slack?.lastProbeAt ? formatRelativeTimestamp(slack.lastProbeAt) : t("channels.statusNa"),
      },
    ],
    lastError: slack?.lastError,
    secondaryCallout: slack?.probe
      ? html`<div class="callout" style="margin-top: 12px;">
          ${t("channels.btnProbe")} ${slack.probe.ok ? t("channels.telegramProbeOk") : t("channels.telegramProbeFailed")} ·
          ${slack.probe.status ?? ""} ${slack.probe.error ?? ""}
        </div>`
      : nothing,
    configSection: renderChannelConfigSection({ channelId: "slack", props }),
    footer: html`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${() => props.onRefresh(true)}>
        ${t("channels.btnProbe")}
      </button>
    </div>`,
  });
}
