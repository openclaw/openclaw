import { html, nothing } from "lit";
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
    title: "Google Chat",
    subtitle: "Chat API webhook status and channel configuration.",
    accountCountLabel,
    statusRows: [
      { label: "Configured", value: formatNullableBoolean(configured) },
      {
        label: "Running",
        value: googleChat ? (googleChat.running ? "Yes" : "No") : "n/a",
      },
      { label: "Credential", value: googleChat?.credentialSource ?? "n/a" },
      {
        label: "Audience",
        value: googleChat?.audienceType
          ? `${googleChat.audienceType}${googleChat.audience ? ` · ${googleChat.audience}` : ""}`
          : "n/a",
      },
      {
        label: "Last start",
        value: googleChat?.lastStartAt ? formatRelativeTimestamp(googleChat.lastStartAt) : "n/a",
      },
      {
        label: "Last probe",
        value: googleChat?.lastProbeAt ? formatRelativeTimestamp(googleChat.lastProbeAt) : "n/a",
      },
    ],
    lastError: googleChat?.lastError,
    secondaryCallout: googleChat?.probe
      ? html`<div class="callout" style="margin-top: 12px;">
          Probe ${googleChat.probe.ok ? "ok" : "failed"} · ${googleChat.probe.status ?? ""}
          ${googleChat.probe.error ?? ""}
        </div>`
      : nothing,
    configSection: renderChannelConfigSection({ channelId: "googlechat", props }),
    footer: html`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${() => props.onRefresh(true)}>Probe</button>
    </div>`,
  });
}
