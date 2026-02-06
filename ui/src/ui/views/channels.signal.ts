import { msg } from "@lit/localize";
import { html, nothing } from "lit";
import type { SignalStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { formatAgo } from "../format.ts";
import { renderChannelConfigSection } from "./channels.config.ts";

export function renderSignalCard(params: {
  props: ChannelsProps;
  signal?: SignalStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, signal, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">${msg("Signal", { id: "channels.signal.title" })}</div>
      <div class="card-sub">${msg("signal-cli status and channel configuration.", {
        id: "channels.signal.sub",
      })}</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">${msg("Configured", { id: "channels.signal.configured" })}</span>
          <span>${signal?.configured ? msg("Yes", { id: "channels.signal.yes" }) : msg("No", { id: "channels.signal.no" })}</span>
        </div>
        <div>
          <span class="label">${msg("Running", { id: "channels.signal.running" })}</span>
          <span>${signal?.running ? msg("Yes", { id: "channels.signal.yes" }) : msg("No", { id: "channels.signal.no" })}</span>
        </div>
        <div>
          <span class="label">${msg("Base URL", { id: "channels.signal.baseUrl" })}</span>
          <span>${signal?.baseUrl ?? msg("n/a", { id: "channels.signal.na" })}</span>
        </div>
        <div>
          <span class="label">${msg("Last start", { id: "channels.signal.lastStart" })}</span>
          <span>${signal?.lastStartAt ? formatAgo(signal.lastStartAt) : msg("n/a", { id: "channels.signal.na" })}</span>
        </div>
        <div>
          <span class="label">${msg("Last probe", { id: "channels.signal.lastProbe" })}</span>
          <span>${signal?.lastProbeAt ? formatAgo(signal.lastProbeAt) : msg("n/a", { id: "channels.signal.na" })}</span>
        </div>
      </div>

      ${
        signal?.lastError
          ? html`<div class="callout danger" style="margin-top: 12px;">
            ${signal.lastError}
          </div>`
          : nothing
      }

      ${
        signal?.probe
          ? html`<div class="callout" style="margin-top: 12px;">
            ${msg("Probe", { id: "channels.signal.probe" })} ${signal.probe.ok ? msg("ok", { id: "channels.signal.probeOk" }) : msg("failed", { id: "channels.signal.probeFailed" })} ·
            ${signal.probe.status ?? ""} ${signal.probe.error ?? ""}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({ channelId: "signal", props })}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${() => props.onRefresh(true)}>
          ${msg("Probe", { id: "channels.signal.probeButton" })}
        </button>
      </div>
    </div>
  `;
}
