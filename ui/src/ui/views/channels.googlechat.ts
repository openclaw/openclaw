import { html, nothing } from "lit";
import { t } from "../../i18n/lib/translate.ts";
import { formatRelativeTimestamp } from "../format.ts";
import type { GoogleChatStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import {
  formatNullableBoolean,
  renderSingleAccountChannelCard,
  resolveChannelConfigured,
} from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";

export function renderGoogleChatCard(params: {
  props: ChannelsProps;
  googleChat?: GoogleChatStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, googleChat, accountCountLabel } = params;
  const configured = resolveChannelConfigured("googlechat", props);

  return renderSingleAccountChannelCard({
    title: t("channels.googlechatTitle"),
    subtitle: t("channels.googlechatSubtitle"),
    accountCountLabel,
    statusRows: [
      { label: t("channels.statusConfigured"), value: formatNullableBoolean(configured) },
      {
        label: t("channels.statusRunning"),
        value: googleChat ? (googleChat.running ? t("channels.statusYes") : t("channels.statusNo")) : t("channels.statusNa"),
      },
      { label: t("channels.googlechatCredential"), value: googleChat?.credentialSource ?? t("channels.statusNa") },
      {
        label: t("channels.googlechatAudience"),
        value: googleChat?.audienceType
          ? `${googleChat.audienceType}${googleChat.audience ? ` · ${googleChat.audience}` : ""}`
          : t("channels.statusNa"),
      },
      {
        label: t("channels.telegramLastStart"),
        value: googleChat?.lastStartAt ? formatRelativeTimestamp(googleChat.lastStartAt) : t("channels.statusNa"),
      },
      {
        label: t("channels.telegramLastProbe"),
        value: googleChat?.lastProbeAt ? formatRelativeTimestamp(googleChat.lastProbeAt) : t("channels.statusNa"),
      },
    ],
    lastError: googleChat?.lastError,
    secondaryCallout: googleChat?.probe
      ? html`<div class="callout" style="margin-top: 12px;">
          ${t("channels.btnProbe")} ${googleChat.probe.ok ? t("channels.telegramProbeOk") : t("channels.telegramProbeFailed")} ·
          ${googleChat.probe.status ?? ""} ${googleChat.probe.error ?? ""}
        </div>`
      : nothing,
    configSection: renderChannelConfigSection({ channelId: "googlechat", props }),
    footer: html`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${() => props.onRefresh(true)}>
        ${t("channels.btnProbe")}
      </button>
    </div>`,
  });
}
