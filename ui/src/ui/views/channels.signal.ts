import { html, nothing } from "lit";
import type { SignalStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { formatRelativeTimestamp, translateUiError } from "../format.ts";
import { t } from "../i18n/index.js";
import { renderChannelConfigSection } from "./channels.config.ts";

export function renderSignalCard(params: {
  props: ChannelsProps;
  signal?: SignalStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, signal, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">Signal</div>
      <div class="card-sub">${t("signal-cli status and channel configuration.")}</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">${t("Configured")}</span>
          <span>${signal?.configured ? t("Yes") : t("No")}</span>
        </div>
        <div>
          <span class="label">${t("Running")}</span>
          <span>${signal?.running ? t("Yes") : t("No")}</span>
        </div>
        <div>
          <span class="label">${t("Base URL")}</span>
          <span>${signal?.baseUrl ?? "n/a"}</span>
        </div>
        <div>
          <span class="label">${t("Last start")}</span>
          <span>${signal?.lastStartAt ? formatRelativeTimestamp(signal.lastStartAt) : "n/a"}</span>
        </div>
        <div>
          <span class="label">${t("Last probe")}</span>
          <span>${signal?.lastProbeAt ? formatRelativeTimestamp(signal.lastProbeAt) : "n/a"}</span>
        </div>
      </div>

      ${
        signal?.lastError
          ? html`<div class="callout danger" style="margin-top: 12px;">
            ${translateUiError(signal.lastError)}
          </div>`
          : nothing
      }

      ${
        signal?.probe
          ? html`<div class="callout" style="margin-top: 12px;">
            ${t("Probe")} ${signal.probe.ok ? t("ok") : t("failed")} ·
            ${signal.probe.status ?? ""} ${signal.probe.error ?? ""}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({ channelId: "signal", props })}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${() => props.onRefresh(true)}>
          ${t("Probe")}
        </button>
      </div>
    </div>
  `;
}
