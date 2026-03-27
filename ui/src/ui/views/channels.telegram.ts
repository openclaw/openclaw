import { html, nothing } from "lit";
import { t } from "../../i18n/lib/translate.ts";
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
          <div class="account-card-title">
            ${botUsername ? `@${botUsername}` : label}
          </div>
          <div class="account-card-id">${account.accountId}</div>
        </div>
        <div class="status-list account-card-status">
          <div>
            <span class="label">${t("channels.telegramRunning")}</span>
            <span>${account.running ? t("channels.statusYes") : t("channels.statusNo")}</span>
          </div>
          <div>
            <span class="label">${t("channels.statusConfigured")}</span>
            <span>${account.configured ? t("channels.statusYes") : t("channels.statusNo")}</span>
          </div>
          <div>
            <span class="label">${t("channels.telegramLastInbound")}</span>
            <span>${account.lastInboundAt ? formatRelativeTimestamp(account.lastInboundAt) : t("channels.statusNa")}</span>
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

  if (hasMultipleAccounts) {
    return html`
      <div class="card">
        <div class="card-title">${t("channels.telegramTitle")}</div>
        <div class="card-sub">${t("channels.telegramSubtitle")}</div>
        ${accountCountLabel}

        <div class="account-card-list">
          ${telegramAccounts.map((account) => renderAccountCard(account))}
        </div>

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
              ${t("channels.telegramProbe")} ${telegram.probe.ok ? t("channels.telegramProbeOk") : t("channels.telegramProbeFailed")} ·
              ${telegram.probe.status ?? ""} ${telegram.probe.error ?? ""}
            </div>`
            : nothing
        }

        ${renderChannelConfigSection({ channelId: "telegram", props })}

        <div class="row" style="margin-top: 12px;">
          <button class="btn" @click=${() => props.onRefresh(true)}>
            ${t("channels.telegramProbe")}
          </button>
        </div>
      </div>
    `;
  }

  return renderSingleAccountChannelCard({
    title: t("channels.telegramTitle"),
    subtitle: t("channels.telegramSubtitle"),
    accountCountLabel,
    statusRows: [
      { label: t("channels.statusConfigured"), value: formatNullableBoolean(configured) },
      { label: t("channels.telegramRunning"), value: telegram?.running ? t("channels.statusYes") : t("channels.statusNo") },
      { label: t("channels.telegramMode"), value: telegram?.mode ?? t("channels.statusNa") },
      {
        label: t("channels.telegramLastStart"),
        value: telegram?.lastStartAt ? formatRelativeTimestamp(telegram.lastStartAt) : t("channels.statusNa"),
      },
      {
        label: t("channels.telegramLastProbe"),
        value: telegram?.lastProbeAt ? formatRelativeTimestamp(telegram.lastProbeAt) : t("channels.statusNa"),
      },
    ],
    lastError: telegram?.lastError,
    secondaryCallout: telegram?.probe
      ? html`<div class="callout" style="margin-top: 12px;">
          ${t("channels.telegramProbe")} ${telegram.probe.ok ? t("channels.telegramProbeOk") : t("channels.telegramProbeFailed")} ·
          ${telegram.probe.status ?? ""} ${telegram.probe.error ?? ""}
        </div>`
      : nothing,
    configSection: renderChannelConfigSection({ channelId: "telegram", props }),
    footer: html`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${() => props.onRefresh(true)}>
        ${t("channels.telegramProbe")}
      </button>
    </div>`,
  });
}
