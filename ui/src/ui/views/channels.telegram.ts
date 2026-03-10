import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { ChannelAccountSnapshot, TelegramStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import { formatBool, formatProbeResult, formatRelativeOrNa } from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";

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
            <span class="label">${t("channelsView.status.running")}</span>
            <span>${formatBool(account.running)}</span>
          </div>
          <div>
            <span class="label">${t("channelsView.status.configured")}</span>
            <span>${formatBool(account.configured)}</span>
          </div>
          <div>
            <span class="label">${t("channelsView.status.lastInbound")}</span>
            <span>${formatRelativeOrNa(account.lastInboundAt)}</span>
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
      <div class="card-title">Telegram</div>
      <div class="card-sub">${t("channelsView.subtitles.botConfig")}</div>
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
                <span class="label">${t("channelsView.status.configured")}</span>
                <span>${formatBool(telegram?.configured)}</span>
              </div>
              <div>
                <span class="label">${t("channelsView.status.running")}</span>
                <span>${formatBool(telegram?.running)}</span>
              </div>
              <div>
                <span class="label">${t("channelsView.status.mode")}</span>
                <span>${telegram?.mode ?? t("common.na")}</span>
              </div>
              <div>
                <span class="label">${t("channelsView.status.lastStart")}</span>
                <span>${formatRelativeOrNa(telegram?.lastStartAt)}</span>
              </div>
              <div>
                <span class="label">${t("channelsView.status.lastProbe")}</span>
                <span>${formatRelativeOrNa(telegram?.lastProbeAt)}</span>
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
            ${formatProbeResult(telegram.probe.ok)} ·
            ${telegram.probe.status ?? ""} ${telegram.probe.error ?? ""}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({ channelId: "telegram", props })}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${() => props.onRefresh(true)}>
          ${t("common.probe")}
        </button>
      </div>
    </div>
  `;
}
