import { msg } from "@lit/localize";
import { html, nothing } from "lit";
import type { SlackStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
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
      <div class="card-title">${msg("Slack", { id: "channels.slack.title" })}</div>
      <div class="card-sub">${msg("Socket mode status and channel configuration.", {
        id: "channels.slack.sub",
      })}</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">${msg("Configured", { id: "channels.slack.configured" })}</span>
          <span>${slack?.configured ? msg("Yes", { id: "channels.slack.yes" }) : msg("No", { id: "channels.slack.no" })}</span>
        </div>
        <div>
          <span class="label">${msg("Running", { id: "channels.slack.running" })}</span>
          <span>${slack?.running ? msg("Yes", { id: "channels.slack.yes" }) : msg("No", { id: "channels.slack.no" })}</span>
        </div>
        <div>
          <span class="label">${msg("Last start", { id: "channels.slack.lastStart" })}</span>
          <span>${slack?.lastStartAt ? formatAgo(slack.lastStartAt) : msg("n/a", { id: "channels.slack.na" })}</span>
        </div>
        <div>
          <span class="label">${msg("Last probe", { id: "channels.slack.lastProbe" })}</span>
          <span>${slack?.lastProbeAt ? formatAgo(slack.lastProbeAt) : msg("n/a", { id: "channels.slack.na" })}</span>
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
            ${msg("Probe", { id: "channels.slack.probe" })} ${slack.probe.ok ? msg("ok", { id: "channels.slack.probeOk" }) : msg("failed", { id: "channels.slack.probeFailed" })} ·
            ${slack.probe.status ?? ""} ${slack.probe.error ?? ""}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({ channelId: "slack", props })}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${() => props.onRefresh(true)}>
          ${msg("Probe", { id: "channels.slack.probeButton" })}
        </button>
      </div>
    </div>
  `;
}
