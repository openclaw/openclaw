import { html, nothing } from "lit";
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
		title: "Signal",
		subtitle: "signal-cli status and channel configuration.",
		accountCountLabel,
		statusRows: [
			{ label: "Configured", value: formatNullableBoolean(configured) },
			{ label: "Running", value: signal?.running ? "Yes" : "No" },
			{ label: "Base URL", value: signal?.baseUrl ?? "n/a" },
			{
				label: "Last start",
				value: signal?.lastStartAt
					? formatRelativeTimestamp(signal.lastStartAt)
					: "n/a",
			},
			{
				label: "Last probe",
				value: signal?.lastProbeAt
					? formatRelativeTimestamp(signal.lastProbeAt)
					: "n/a",
			},
		],
		lastError: signal?.lastError,
		secondaryCallout: signal?.probe
			? html`<div class="callout" style="margin-top: 12px;">
          Probe ${signal.probe.ok ? "ok" : "failed"} · ${signal.probe.status ?? ""}
          ${signal.probe.error ?? ""}
        </div>`
			: nothing,
		configSection: renderChannelConfigSection({ channelId: "signal", props }),
		footer: html`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${() => props.onRefresh(true)}>Probe</button>
    </div>`,
	});
}
