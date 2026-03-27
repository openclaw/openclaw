import { html, nothing } from "lit";
import { t } from "../../i18n/lib/translate.ts";
import { formatRelativeTimestamp } from "../format.ts";
import type { SignalStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import {
  formatNullableBoolean,
  renderSingleAccountChannelCard,
  resolveChannelConfigured,
} from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";

export function renderSignalCard(params: {
  props: ChannelsProps;
  signal?: SignalStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, signal, accountCountLabel } = params;
  const configured = resolveChannelConfigured("signal", props);

  return renderSingleAccountChannelCard({
    title: t("channels.signalTitle"),
    subtitle: t("channels.signalSubtitle"),
    accountCountLabel,
    statusRows: [
      { label: t("channels.statusConfigured"), value: formatNullableBoolean(configured) },
      { label: t("channels.statusRunning"), value: signal?.running ? t("channels.statusYes") : t("channels.statusNo") },
      { label: t("channels.signalBaseUrl"), value: signal?.baseUrl ?? t("channels.statusNa") },
      {
        label: t("channels.telegramLastStart"),
        value: signal?.lastStartAt ? formatRelativeTimestamp(signal.lastStartAt) : t("channels.statusNa"),
      },
      {
        label: t("channels.telegramLastProbe"),
        value: signal?.lastProbeAt ? formatRelativeTimestamp(signal.lastProbeAt) : t("channels.statusNa"),
      },
    ],
    lastError: signal?.lastError,
    secondaryCallout: signal?.probe
      ? html`<div class="callout" style="margin-top: 12px;">
          ${t("channels.btnProbe")} ${signal.probe.ok ? t("channels.telegramProbeOk") : t("channels.telegramProbeFailed")} ·
          ${signal.probe.status ?? ""} ${signal.probe.error ?? ""}
        </div>`
      : nothing,
    configSection: renderChannelConfigSection({ channelId: "signal", props }),
    footer: html`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${() => props.onRefresh(true)}>
        ${t("channels.btnProbe")}
      </button>
    </div>`,
  });
}
