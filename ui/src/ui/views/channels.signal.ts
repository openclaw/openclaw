import { html, nothing } from "lit";
import type { SignalStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { t } from "../../i18n/i18n.js";
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
      <div class="card-title">${t("signal.card_title")}</div>
      <div class="card-sub">${t("signal.card_subtitle")}</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">${t("signal.status.configured")}</span>
          <span>${signal?.configured ? t("common.yes") : t("common.no")}</span>
        </div>
        <div>
          <span class="label">${t("signal.status.running")}</span>
          <span>${signal?.running ? t("common.yes") : t("common.no")}</span>
        </div>
        <div>
          <span class="label">${t("signal.status.base_url")}</span>
          <span>${signal?.baseUrl ?? t("common.n_a")}</span>
        </div>
        <div>
          <span class="label">${t("signal.status.last_start")}</span>
          <span>${signal?.lastStartAt ? formatAgo(signal.lastStartAt) : t("common.n_a")}</span>
        </div>
        <div>
          <span class="label">${t("signal.status.last_probe")}</span>
          <span>${signal?.lastProbeAt ? formatAgo(signal.lastProbeAt) : t("common.n_a")}</span>
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
            ${t("signal.button.probe")} ${signal.probe.ok ? "ok" : "failed"} ·
            ${signal.probe.status ?? ""} ${signal.probe.error ?? ""}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({ channelId: "signal", props })}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${() => props.onRefresh(true)}>
          ${t("signal.button.probe")}
        </button>
      </div>
    </div>
  `;
}
