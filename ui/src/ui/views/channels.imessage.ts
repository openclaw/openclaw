import { html, nothing } from "lit";
import type { IMessageStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { formatRelativeTimestamp, translateUiError } from "../format.ts";
import { t } from "../i18n/index.js";
import { renderChannelConfigSection } from "./channels.config.ts";

export function renderIMessageCard(params: {
  props: ChannelsProps;
  imessage?: IMessageStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, imessage, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">iMessage</div>
      <div class="card-sub">${t("macOS bridge status and channel configuration.")}</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">${t("Configured")}</span>
          <span>${imessage?.configured ? t("Yes") : t("No")}</span>
        </div>
        <div>
          <span class="label">${t("Running")}</span>
          <span>${imessage?.running ? t("Yes") : t("No")}</span>
        </div>
        <div>
          <span class="label">${t("Last start")}</span>
          <span>${imessage?.lastStartAt ? formatRelativeTimestamp(imessage.lastStartAt) : "n/a"}</span>
        </div>
        <div>
          <span class="label">${t("Last probe")}</span>
          <span>${imessage?.lastProbeAt ? formatRelativeTimestamp(imessage.lastProbeAt) : "n/a"}</span>
        </div>
      </div>

      ${
        imessage?.lastError
          ? html`<div class="callout danger" style="margin-top: 12px;">
            ${translateUiError(imessage.lastError)}
          </div>`
          : nothing
      }

      ${
        imessage?.probe
          ? html`<div class="callout" style="margin-top: 12px;">
            ${t("Probe")} ${imessage.probe.ok ? t("ok") : t("failed")} ·
            ${imessage.probe.error ?? ""}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({ channelId: "imessage", props })}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${() => props.onRefresh(true)}>
          ${t("Probe")}
        </button>
      </div>
    </div>
  `;
}
