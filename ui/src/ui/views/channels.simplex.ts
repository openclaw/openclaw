import { html, nothing } from "lit";
import type { ChannelAccountSnapshot, SimplexStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { formatAgo } from "../format.ts";
import { renderChannelConfigSection } from "./channels.config.ts";

export function renderSimplexCard(params: {
  props: ChannelsProps;
  simplex?: SimplexStatus | null;
  simplexAccounts: ChannelAccountSnapshot[];
  accountCountLabel: unknown;
}) {
  const { props, simplex, simplexAccounts, accountCountLabel } = params;
  const hasMultipleAccounts = simplexAccounts.length > 1;

  const renderAccountCard = (account: ChannelAccountSnapshot) => {
    const label = account.name || account.accountId;
    const wsUrl = (account as { wsUrl?: string | null }).wsUrl ?? null;
    return html`
      <div class="account-card">
        <div class="account-card-header">
          <div class="account-card-title">${label}</div>
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
            <span class="label">Mode</span>
            <span>${account.mode ?? "n/a"}</span>
          </div>
          <div>
            <span class="label">Endpoint</span>
            <span title=${wsUrl ?? ""}>${wsUrl ?? "n/a"}</span>
          </div>
          <div>
            <span class="label">Last inbound</span>
            <span>${account.lastInboundAt ? formatAgo(account.lastInboundAt) : "n/a"}</span>
          </div>
          <div>
            <span class="label">Last outbound</span>
            <span>${account.lastOutboundAt ? formatAgo(account.lastOutboundAt) : "n/a"}</span>
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
      <div class="card-title">SimpleX</div>
      <div class="card-sub">SimpleX Chat via local CLI WebSocket API.</div>
      ${accountCountLabel}

      ${
        hasMultipleAccounts
          ? html`
            <div class="account-card-list">
              ${simplexAccounts.map((account) => renderAccountCard(account))}
            </div>
          `
          : html`
            <div class="status-list" style="margin-top: 16px;">
              <div>
                <span class="label">Configured</span>
                <span>${simplex?.configured ? "Yes" : "No"}</span>
              </div>
              <div>
                <span class="label">Running</span>
                <span>${simplex?.running ? "Yes" : "No"}</span>
              </div>
              <div>
                <span class="label">Mode</span>
                <span>${simplex?.mode ?? "n/a"}</span>
              </div>
              <div>
                <span class="label">Endpoint</span>
                <span title=${simplex?.wsUrl ?? ""}>${simplex?.wsUrl ?? "n/a"}</span>
              </div>
              <div>
                <span class="label">Last start</span>
                <span>${simplex?.lastStartAt ? formatAgo(simplex.lastStartAt) : "n/a"}</span>
              </div>
              <div>
                <span class="label">Last inbound</span>
                <span>${simplexAccounts[0]?.lastInboundAt ? formatAgo(simplexAccounts[0].lastInboundAt) : "n/a"}</span>
              </div>
              <div>
                <span class="label">Last outbound</span>
                <span>${simplexAccounts[0]?.lastOutboundAt ? formatAgo(simplexAccounts[0].lastOutboundAt) : "n/a"}</span>
              </div>
            </div>
          `
      }

      ${
        simplex?.lastError
          ? html`<div class="callout danger" style="margin-top: 12px;">
            ${simplex.lastError}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({ channelId: "simplex", props })}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${() => props.onRefresh(true)}>
          Refresh
        </button>
      </div>
    </div>
  `;
}
