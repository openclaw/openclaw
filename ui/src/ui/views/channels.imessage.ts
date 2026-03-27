import { html, nothing } from "lit";
import { t } from "../../i18n/lib/translate.ts";
import { formatRelativeTimestamp } from "../format.ts";
import type { IMessageStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import {
  formatNullableBoolean,
  renderSingleAccountChannelCard,
  resolveChannelConfigured,
} from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";

export function renderIMessageCard(params: {
  props: ChannelsProps;
  imessage?: IMessageStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, imessage, accountCountLabel } = params;
  const configured = resolveChannelConfigured("imessage", props);

  return renderSingleAccountChannelCard({
    title: t("channels.imessageTitle"),
    subtitle: t("channels.imessageSubtitle"),
    accountCountLabel,
    statusRows: [
      { label: t("channels.statusConfigured"), value: formatNullableBoolean(configured) },
      { label: t("channels.statusRunning"), value: imessage?.running ? t("channels.statusYes") : t("channels.statusNo") },
      {
        label: t("channels.telegramLastStart"),
        value: imessage?.lastStartAt ? formatRelativeTimestamp(imessage.lastStartAt) : t("channels.statusNa"),
      },
      {
        label: t("channels.telegramLastProbe"),
        value: imessage?.lastProbeAt ? formatRelativeTimestamp(imessage.lastProbeAt) : t("channels.statusNa"),
      },
    ],
    lastError: imessage?.lastError,
    secondaryCallout: imessage?.probe
      ? html`<div class="callout" style="margin-top: 12px;">
          ${t("channels.btnProbe")} ${imessage.probe.ok ? t("channels.telegramProbeOk") : t("channels.telegramProbeFailed")} ·
          ${imessage.probe.error ?? ""}
        </div>`
      : nothing,
    configSection: renderChannelConfigSection({ channelId: "imessage", props }),
    footer: html`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${() => props.onRefresh(true)}>
        ${t("channels.btnProbe")}
      </button>
    </div>`,
  });
}
