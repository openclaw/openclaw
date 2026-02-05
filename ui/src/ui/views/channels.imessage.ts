import { html, nothing } from "lit";
import type { IMessageStatus } from "../types";
import type { ChannelsProps } from "./channels.types";
import { t } from "../../i18n/i18n";
import { formatAgo } from "../format";
import { renderChannelConfigSection } from "./channels.config";

export function renderIMessageCard(params: {
  props: ChannelsProps;
  imessage?: IMessageStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, imessage, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">${t("imessage.card_title")}</div>
      <div class="card-sub">${t("imessage.card_subtitle")}</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">${t("imessage.status.configured")}</span>
          <span>${imessage?.configured ? t("common.yes") : t("common.no")}</span>
        </div>
        <div>
          <span class="label">${t("imessage.status.running")}</span>
          <span>${imessage?.running ? t("common.yes") : t("common.no")}</span>
        </div>
        <div>
          <span class="label">${t("imessage.status.last_start")}</span>
          <span>${imessage?.lastStartAt ? formatAgo(imessage.lastStartAt) : t("common.n_a")}</span>
        </div>
        <div>
          <span class="label">${t("imessage.status.last_probe")}</span>
          <span>${imessage?.lastProbeAt ? formatAgo(imessage.lastProbeAt) : t("common.n_a")}</span>
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
            ${t("imessage.button.probe")} ${imessage.probe.ok ? "ok" : "failed"} ·
            ${imessage.probe.error ?? ""}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({ channelId: "imessage", props })}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${() => props.onRefresh(true)}>
          ${t("imessage.button.probe")}
        </button>
      </div>
    </div>
  `;
}
