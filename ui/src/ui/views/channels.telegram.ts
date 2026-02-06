import { msg } from "@lit/localize";
import { html, nothing } from "lit";
import type { ChannelAccountSnapshot, TelegramStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
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
            <span class="label">${msg("Running", { id: "channels.telegram.account.running" })}</span>
            <span>${account.running ? msg("Yes", { id: "channels.telegram.account.yes" }) : msg("No", { id: "channels.telegram.account.no" })}</span>
          </div>
          <div>
            <span class="label">${msg("Configured", { id: "channels.telegram.account.configured" })}</span>
            <span>${account.configured ? msg("Yes", { id: "channels.telegram.account.yes" }) : msg("No", { id: "channels.telegram.account.no" })}</span>
          </div>
          <div>
            <span class="label">${msg("Last inbound", { id: "channels.telegram.account.lastInbound" })}</span>
            <span>${account.lastInboundAt ? formatAgo(account.lastInboundAt) : msg("n/a", { id: "channels.telegram.account.na" })}</span>
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
      <div class="card-title">${msg("Telegram", { id: "channels.telegram.title" })}</div>
      <div class="card-sub">${msg("Bot status and channel configuration.", {
        id: "channels.telegram.sub",
      })}</div>
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
                <span class="label">${msg("Configured", { id: "channels.telegram.configured" })}</span>
                <span>${telegram?.configured ? msg("Yes", { id: "channels.telegram.yes" }) : msg("No", { id: "channels.telegram.no" })}</span>
              </div>
              <div>
                <span class="label">${msg("Running", { id: "channels.telegram.running" })}</span>
                <span>${telegram?.running ? msg("Yes", { id: "channels.telegram.yes" }) : msg("No", { id: "channels.telegram.no" })}</span>
              </div>
              <div>
                <span class="label">${msg("Mode", { id: "channels.telegram.mode" })}</span>
                <span>${telegram?.mode ?? msg("n/a", { id: "channels.telegram.na" })}</span>
              </div>
              <div>
                <span class="label">${msg("Last start", { id: "channels.telegram.lastStart" })}</span>
                <span>${telegram?.lastStartAt ? formatAgo(telegram.lastStartAt) : msg("n/a", { id: "channels.telegram.na" })}</span>
              </div>
              <div>
                <span class="label">${msg("Last probe", { id: "channels.telegram.lastProbe" })}</span>
                <span>${telegram?.lastProbeAt ? formatAgo(telegram.lastProbeAt) : msg("n/a", { id: "channels.telegram.na" })}</span>
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
            ${msg("Probe", { id: "channels.telegram.probe" })} ${telegram.probe.ok ? msg("ok", { id: "channels.telegram.probeOk" }) : msg("failed", { id: "channels.telegram.probeFailed" })} ·
            ${telegram.probe.status ?? ""} ${telegram.probe.error ?? ""}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({ channelId: "telegram", props })}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${() => props.onRefresh(true)}>
          ${msg("Probe", { id: "channels.telegram.probeButton" })}
        </button>
      </div>
    </div>
  `;
}
