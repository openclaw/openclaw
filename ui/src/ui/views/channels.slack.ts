import { html, nothing } from "lit";
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
		title: "Slack",
		subtitle: "Socket mode status and channel configuration.",
		accountCountLabel,
		statusRows: [
			{ label: "Configured", value: formatNullableBoolean(configured) },
			{ label: "Running", value: slack?.running ? "Yes" : "No" },
			{
				label: "Last start",
				value: slack?.lastStartAt
					? formatRelativeTimestamp(slack.lastStartAt)
					: "n/a",
			},
			{
				label: "Last probe",
				value: slack?.lastProbeAt
					? formatRelativeTimestamp(slack.lastProbeAt)
					: "n/a",
			},
		],
		lastError: slack?.lastError,
		secondaryCallout: slack?.probe
			? html`<div class="callout" style="margin-top: 12px;">
          Probe ${slack.probe.ok ? "ok" : "failed"} · ${slack.probe.status ?? ""}
          ${slack.probe.error ?? ""}
        </div>`
			: nothing,
		configSection: renderChannelConfigSection({ channelId: "slack", props }),
		footer: html`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${() => props.onRefresh(true)}>Probe</button>
    </div>`,
	});
}
