import { html, nothing } from "lit";
import { formatRelativeTimestamp } from "../format.ts";
import type { ChannelAccountSnapshot, TelegramStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import {
  formatNullableBoolean,
  renderSingleAccountChannelCard,
  resolveChannelConfigured,
} from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";

export function renderTelegramCard(params: {
  props: ChannelsProps;
  telegram?: TelegramStatus;
  telegramAccounts: ChannelAccountSnapshot[];
  accountCountLabel: unknown;
}) {
  const { props, telegram, telegramAccounts, accountCountLabel } = params;
  const hasMultipleAccounts = telegramAccounts.length > 1;
  const configured = resolveChannelConfigured("telegram", props);

  const renderAccountCard = (account: ChannelAccountSnapshot) => {
    const probe = account.probe as { bot?: { username?: string } } | undefined;
    const botUsername = probe?.bot?.username;
    const label = account.name || account.accountId;
    return html`
      <div class="account-card">
        <div class="account-card-header">
          <div class="account-card-title">${botUsername ? `@${botUsername}` : label}</div>
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
            <span
              >${
                account.lastInboundAt ? formatRelativeTimestamp(account.lastInboundAt) : "n/a"
              }</span
            >
          </div>
          ${
            account.lastError
              ? html` <div class="account-card-error">${account.lastError}</div> `
              : nothing
          }
        </div>
      </div>
    `;
  };

  if (hasMultipleAccounts) {
    return html`
      <div class="card">
        <div class="card-title">Telegram</div>
        <div class="card-sub">Bot status and channel configuration.</div>
        ${accountCountLabel}

        <div class="account-card-list">
          ${telegramAccounts.map((account) => renderAccountCard(account))}
        </div>

        ${
          telegram?.lastError
            ? html`<div class="callout danger" style="margin-top: 12px;">${telegram.lastError}</div>`
            : nothing
        }
        ${
          telegram?.probe
            ? html`<div class="callout" style="margin-top: 12px;">
              Probe ${telegram.probe.ok ? "ok" : "failed"} · ${telegram.probe.status ?? ""}
              ${telegram.probe.error ?? ""}
            </div>`
            : nothing
        }
        ${renderChannelConfigSection({ channelId: "telegram", props })}

        <div class="row" style="margin-top: 12px;">
          <button class="btn" @click=${() => props.onRefresh(true)}>Probe</button>
        </div>
      </div>
    `;
  }

  return renderSingleAccountChannelCard({
    title: "Telegram",
    subtitle: "Bot status and channel configuration.",
    accountCountLabel,
    statusRows: [
      { label: "Configured", value: formatNullableBoolean(configured) },
      { label: "Running", value: telegram?.running ? "Yes" : "No" },
      { label: "Mode", value: telegram?.mode ?? "n/a" },
      {
        label: "Last start",
        value: telegram?.lastStartAt ? formatRelativeTimestamp(telegram.lastStartAt) : "n/a",
      },
      {
        label: "Last probe",
        value: telegram?.lastProbeAt ? formatRelativeTimestamp(telegram.lastProbeAt) : "n/a",
      },
    ],
    lastError: telegram?.lastError,
    secondaryCallout: telegram?.probe
      ? html`<div class="callout" style="margin-top: 12px;">
          Probe ${telegram.probe.ok ? "ok" : "failed"} · ${telegram.probe.status ?? ""}
          ${telegram.probe.error ?? ""}
        </div>`
      : nothing,
    configSection: renderChannelConfigSection({ channelId: "telegram", props }),
    footer: html`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${() => props.onRefresh(true)}>Probe</button>
    </div>`,
  });
}
