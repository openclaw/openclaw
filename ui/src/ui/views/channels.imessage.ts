import { msg } from "@lit/localize";
import { html, nothing } from "lit";
import type { IMessageStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { formatAgo } from "../format.ts";
import { renderChannelConfigSection } from "./channels.config.ts";

export function renderIMessageCard(params: {
  props: ChannelsProps;
  imessage?: IMessageStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, imessage, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">${msg("iMessage", { id: "channels.imessage.title" })}</div>
      <div class="card-sub">${msg("macOS bridge status and channel configuration.", {
        id: "channels.imessage.sub",
      })}</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">${msg("Configured", { id: "channels.imessage.configured" })}</span>
          <span>${imessage?.configured ? msg("Yes", { id: "channels.imessage.yes" }) : msg("No", { id: "channels.imessage.no" })}</span>
        </div>
        <div>
          <span class="label">${msg("Running", { id: "channels.imessage.running" })}</span>
          <span>${imessage?.running ? msg("Yes", { id: "channels.imessage.yes" }) : msg("No", { id: "channels.imessage.no" })}</span>
        </div>
        <div>
          <span class="label">${msg("Last start", { id: "channels.imessage.lastStart" })}</span>
          <span>${imessage?.lastStartAt ? formatAgo(imessage.lastStartAt) : msg("n/a", { id: "channels.imessage.na" })}</span>
        </div>
        <div>
          <span class="label">${msg("Last probe", { id: "channels.imessage.lastProbe" })}</span>
          <span>${imessage?.lastProbeAt ? formatAgo(imessage.lastProbeAt) : msg("n/a", { id: "channels.imessage.na" })}</span>
        </div>
      </div>

      ${
        imessage?.lastError
          ? html`<div class="callout danger" style="margin-top: 12px;">
            ${imessage.lastError}
          </div>`
          : nothing
      }

      ${
        imessage?.probe
          ? html`<div class="callout" style="margin-top: 12px;">
            ${msg("Probe", { id: "channels.imessage.probe" })} ${imessage.probe.ok ? msg("ok", { id: "channels.imessage.probeOk" }) : msg("failed", { id: "channels.imessage.probeFailed" })} ·
            ${imessage.probe.error ?? ""}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({ channelId: "imessage", props })}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${() => props.onRefresh(true)}>
          ${msg("Probe", { id: "channels.imessage.probeButton" })}
        </button>
      </div>
    </div>
  `;
}
