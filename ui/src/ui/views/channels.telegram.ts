import { html, nothing } from "lit";
import type { ChannelAccountSnapshot, TelegramStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { t } from "../../i18n/i18n.js";
import { formatAgo } from "../format.ts";
import { renderChannelConfigSection } from "./channels.config.ts";

export function renderTelegramCard(params: {
  props: ChannelsProps;
  telegram?: TelegramStatus;
  telegramAccounts: ChannelAccountSnapshot[];
  accountCountLabel: unknown;
}) {
  const { props, telegram, telegramAccounts, accountCountLabel } = params;
  const hasMultipleAccounts = telegramAccounts.length > 1;

  const renderAccountCard = (account: ChannelAccountSnapshot) => {
    const probe = account.probe as { bot?: { username?: string } } | undefined;
    const botUsername = probe?.bot?.username;
    const label = account.name || account.accountId;
    return html`
      <div class="account-card">
        <div class="account-card-header">
          <div class="account-card-title">
            ${botUsername ? `@${botUsername}` : label}
          </div>
          <div class="account-card-id">${account.accountId}</div>
        </div>
        <div class="status-list account-card-status">
          <div>
            <span class="label">Running</span>
            <span>${account.running ? "Yes" : "No"}</span>
          </div>
          <div>
            <span class="label">Configured</span>
            <span>${account.configured ? "Yes" : "No"}</span>
          </div>
          <div>
            <span class="label">Last inbound</span>
            <span>${account.lastInboundAt ? formatAgo(account.lastInboundAt) : "n/a"}</span>
          </div>
          ${
            account.lastError
              ? html`
                <div class="account-card-error">
                  ${account.lastError}
                </div>
              `
              : nothing
          }
        </div>
      </div>
    `;
  };

  return html`
    <div class="card">
      <div class="card-title">${t("telegram.card_title")}</div>
      <div class="card-sub">${t("telegram.card_subtitle")}</div>
      ${accountCountLabel}

      ${
        hasMultipleAccounts
          ? html`
            <div class="account-card-list">
              ${telegramAccounts.map((account) => renderAccountCard(account))}
            </div>
          `
          : html`
            <div class="status-list" style="margin-top: 16px;">
              <div>
                <span class="label">${t("telegram.status.configured")}</span>
                <span>${telegram?.configured ? t("common.yes") : t("common.no")}</span>
              </div>
              <div>
                <span class="label">${t("telegram.status.running")}</span>
                <span>${telegram?.running ? t("common.yes") : t("common.no")}</span>
              </div>
              <div>
                <span class="label">${t("telegram.status.mode")}</span>
                <span>${telegram?.mode ?? t("common.n_a")}</span>
              </div>
              <div>
                <span class="label">${t("telegram.status.last_start")}</span>
                <span>${telegram?.lastStartAt ? formatAgo(telegram.lastStartAt) : t("common.n_a")}</span>
              </div>
              <div>
                <span class="label">${t("telegram.status.last_probe")}</span>
                <span>${telegram?.lastProbeAt ? formatAgo(telegram.lastProbeAt) : t("common.n_a")}</span>
              </div>
            </div>
          `
      }

      ${
        telegram?.lastError
          ? html`<div class="callout danger" style="margin-top: 12px;">
            ${telegram.lastError}
          </div>`
          : nothing
      }

      ${
        telegram?.probe
          ? html`<div class="callout" style="margin-top: 12px;">
            ${t("telegram.button.probe")} ${telegram.probe.ok ? "ok" : "failed"} ·
            ${telegram.probe.status ?? ""} ${telegram.probe.error ?? ""}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({ channelId: "telegram", props })}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${() => props.onRefresh(true)}>
          ${t("telegram.button.probe")}
        </button>
      </div>
    </div>
  `;
}
