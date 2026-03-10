import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { SignalStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import { formatBool, formatProbeResult, formatRelativeOrNa } from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";

export function renderSignalCard(params: {
  props: ChannelsProps;
  signal?: SignalStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, signal, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">Signal</div>
      <div class="card-sub">${t("channelsView.subtitles.signal")}</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">${t("channelsView.status.configured")}</span>
          <span>${formatBool(signal?.configured)}</span>
        </div>
        <div>
          <span class="label">${t("channelsView.status.running")}</span>
          <span>${formatBool(signal?.running)}</span>
        </div>
        <div>
          <span class="label">${t("channelsView.status.baseUrl")}</span>
          <span>${signal?.baseUrl ?? t("common.na")}</span>
        </div>
        <div>
          <span class="label">${t("channelsView.status.lastStart")}</span>
          <span>${formatRelativeOrNa(signal?.lastStartAt)}</span>
        </div>
        <div>
          <span class="label">${t("channelsView.status.lastProbe")}</span>
          <span>${formatRelativeOrNa(signal?.lastProbeAt)}</span>
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
            ${formatProbeResult(signal.probe.ok)} ·
            ${signal.probe.status ?? ""} ${signal.probe.error ?? ""}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({ channelId: "signal", props })}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${() => props.onRefresh(true)}>
          ${t("common.probe")}
        </button>
      </div>
    </div>
  `;
}
