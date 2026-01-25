import { html, nothing, type TemplateResult } from "lit";

import { formatAgo } from "../format";
import type { ChannelAccountSnapshot, TelegramStatus } from "../types";
import { renderChannelIntegrationCard, type ChannelCardFrame } from "./channels.shared";

export function renderTelegramCard(params: {
  telegram?: TelegramStatus;
  telegramAccounts: ChannelAccountSnapshot[];
  frame: ChannelCardFrame;
  actions: TemplateResult;
  facts: TemplateResult;
  error: string | null;
}) {
  const { telegram, telegramAccounts, frame, actions, facts, error } = params;
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
          ${account.lastError
            ? html`
                <div class="account-card-error">
                  ${account.lastError}
                </div>
              `
            : nothing}
        </div>
      </div>
    `;
  };

  const details = html`
    ${hasMultipleAccounts
      ? html`
          <div class="account-card-list">
            ${telegramAccounts.map((account) => renderAccountCard(account))}
          </div>
        `
      : html`
          <div class="status-list" style="margin-top: 16px;">
            <div>
              <span class="label">Configured</span>
              <span>${telegram?.configured ? "Yes" : "No"}</span>
            </div>
            <div>
              <span class="label">Running</span>
              <span>${telegram?.running ? "Yes" : "No"}</span>
            </div>
            <div>
              <span class="label">Mode</span>
              <span>${telegram?.mode ?? "n/a"}</span>
            </div>
            <div>
              <span class="label">Last start</span>
              <span>${telegram?.lastStartAt ? formatAgo(telegram.lastStartAt) : "n/a"}</span>
            </div>
            <div>
              <span class="label">Last probe</span>
              <span>${telegram?.lastProbeAt ? formatAgo(telegram.lastProbeAt) : "n/a"}</span>
            </div>
          </div>
        `}

    ${telegram?.probe
      ? html`<div class="callout callout--info" style="margin-top: 12px;">
          Probe ${telegram.probe.ok ? "ok" : "failed"} · ${telegram.probe.status ?? ""}
          ${telegram.probe.error ?? ""}
        </div>`
      : nothing}
  `;

  return renderChannelIntegrationCard({
    frame,
    actions,
    facts,
    details,
    error: error ?? null,
  });
}
