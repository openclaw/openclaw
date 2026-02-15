import { html, nothing } from "lit";
import type { ChannelAccountSnapshot, TelegramStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { formatRelativeTimestamp } from "../format.ts";
import { icons } from "../icons.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import { statusChip } from "./channels.shared.ts";

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
            ${statusChip(account.running)}
          </div>
          <div>
            <span class="label">Configured</span>
            ${statusChip(account.configured)}
          </div>
          <div>
            <span class="label">Last inbound</span>
            <span>${account.lastInboundAt ? formatRelativeTimestamp(account.lastInboundAt) : "n/a"}</span>
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
    <div class="card" style="padding: 0;">
      <div style="padding: 12px 14px; border-bottom: 1px solid var(--border);">
        <div class="card-title" style="margin: 0; display: flex; align-items: center; gap: 8px;">
          <span class="icon" style="width: 16px; height: 16px;">${icons.messageSquare}</span>
          Telegram
        </div>
        <div class="card-sub" style="margin: 0;">Bot status and channel configuration.</div>
        ${accountCountLabel}
      </div>

      <div style="padding: 12px 14px;">
        ${
          hasMultipleAccounts
            ? html`
              <div class="account-card-list">
                ${telegramAccounts.map((account) => renderAccountCard(account))}
              </div>
            `
            : html`
              <div class="status-list">
                <div>
                  <span class="label">Configured</span>
                  ${statusChip(telegram?.configured)}
                </div>
                <div>
                  <span class="label">Running</span>
                  ${statusChip(telegram?.running)}
                </div>
                <div>
                  <span class="label">Mode</span>
                  <span>${telegram?.mode ?? "n/a"}</span>
                </div>
                <div>
                  <span class="label">Last start</span>
                  <span>${telegram?.lastStartAt ? formatRelativeTimestamp(telegram.lastStartAt) : "n/a"}</span>
                </div>
                <div>
                  <span class="label">Last probe</span>
                  <span>${telegram?.lastProbeAt ? formatRelativeTimestamp(telegram.lastProbeAt) : "n/a"}</span>
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
              Probe ${telegram.probe.ok ? "ok" : "failed"} ·
              ${telegram.probe.status ?? ""} ${telegram.probe.error ?? ""}
            </div>`
            : nothing
        }

        ${renderChannelConfigSection({ channelId: "telegram", props })}

        <div class="row" style="margin-top: 12px;">
          <button class="btn" @click=${() => props.onRefresh(true)}>
            Probe
          </button>
        </div>
      </div>
    </div>
  `;
}
