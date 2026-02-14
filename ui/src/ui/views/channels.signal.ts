import { html, nothing } from "lit";
import type { SignalStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { formatRelativeTimestamp } from "../format.ts";
import { icons } from "../icons.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import { statusChip } from "./channels.shared.ts";

export function renderSignalCard(params: {
  props: ChannelsProps;
  signal?: SignalStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, signal, accountCountLabel } = params;

  return html`
    <div class="card" style="padding: 0;">
      <div style="padding: 12px 14px; border-bottom: 1px solid var(--border);">
        <div class="card-title" style="margin: 0; display: flex; align-items: center; gap: 8px;">
          <span class="icon" style="width: 16px; height: 16px;">${icons.messageSquare}</span>
          Signal
        </div>
        <div class="card-sub" style="margin: 0;">signal-cli status and channel configuration.</div>
        ${accountCountLabel}
      </div>

      <div style="padding: 12px 14px;">
        <div class="status-list">
          <div>
            <span class="label">Configured</span>
            ${statusChip(signal?.configured)}
          </div>
          <div>
            <span class="label">Running</span>
            ${statusChip(signal?.running)}
          </div>
          <div>
            <span class="label">Base URL</span>
            <span>${signal?.baseUrl ?? "n/a"}</span>
          </div>
          <div>
            <span class="label">Last start</span>
            <span>${signal?.lastStartAt ? formatRelativeTimestamp(signal.lastStartAt) : "n/a"}</span>
          </div>
          <div>
            <span class="label">Last probe</span>
            <span>${signal?.lastProbeAt ? formatRelativeTimestamp(signal.lastProbeAt) : "n/a"}</span>
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
              Probe ${signal.probe.ok ? "ok" : "failed"} ·
              ${signal.probe.status ?? ""} ${signal.probe.error ?? ""}
            </div>`
            : nothing
        }

        ${renderChannelConfigSection({ channelId: "signal", props })}

        <div class="row" style="margin-top: 12px;">
          <button class="btn" @click=${() => props.onRefresh(true)}>
            Probe
          </button>
        </div>
      </div>
    </div>
  `;
}
