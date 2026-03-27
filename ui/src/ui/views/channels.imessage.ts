import { html, nothing } from "lit";
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
    title: "iMessage",
    subtitle: "macOS bridge status and channel configuration.",
    accountCountLabel,
    statusRows: [
      { label: "Configured", value: formatNullableBoolean(configured) },
      { label: "Running", value: imessage?.running ? "Yes" : "No" },
      {
        label: "Last start",
        value: imessage?.lastStartAt ? formatRelativeTimestamp(imessage.lastStartAt) : "n/a",
      },
      {
        label: "Last probe",
        value: imessage?.lastProbeAt ? formatRelativeTimestamp(imessage.lastProbeAt) : "n/a",
      },
    ],
    lastError: imessage?.lastError,
    secondaryCallout: imessage?.probe
      ? html`<div class="callout" style="margin-top: 12px;">
          Probe ${imessage.probe.ok ? "ok" : "failed"} ·
          ${imessage.probe.error ?? ""}
        </div>`
      : nothing,
    configSection: renderChannelConfigSection({ channelId: "imessage", props }),
    footer: html`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${() => props.onRefresh(true)}>
        Probe
      </button>
    </div>`,
  });
}
