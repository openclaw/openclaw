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
  const primaryAccountId = simplexAccounts[0]?.accountId ?? "default";

  const formatEndpoint = (value: string | null | undefined) => {
    const endpoint = value?.trim();
    return endpoint ? endpoint : "n/a";
  };

  const renderSimplexControls = (accountId: string) => {
    const state = props.simplexControlByAccount[accountId];
    const busyCreate = state?.busyCreate ?? false;
    const busyPending = state?.busyPending ?? false;
    const busyRevoke = state?.busyRevoke ?? false;
    return html`
      ${
        state?.error
          ? html`<div class="callout danger" style="margin-top: 12px;">
            ${state.error}
          </div>`
          : nothing
      }
      ${
        state?.message
          ? html`<div class="callout" style="margin-top: 12px;">
            ${state.message}
          </div>`
          : nothing
      }
      ${
        state?.link
          ? html`<div class="status-list" style="margin-top: 12px;">
            <div>
              <span class="label">Address link</span>
              <span title=${state.link}>${state.link}</span>
            </div>
          </div>`
          : nothing
      }
      ${
        state?.qrDataUrl
          ? html`<div class="qr-wrap">
            <img src=${state.qrDataUrl} alt="SimpleX link QR" />
          </div>`
          : nothing
      }
      ${
        state?.pendingHints && state.pendingHints.length > 0
          ? html`<div class="status-list" style="margin-top: 12px;">
            ${state.pendingHints.map(
              (entry) => html`
                <div>
                  <span class="label">Pending</span>
                  <span>${entry}</span>
                </div>
              `,
            )}
          </div>`
          : nothing
      }
      <div class="row" style="margin-top: 12px; flex-wrap: wrap;">
        <button
          class="btn primary"
          ?disabled=${busyCreate}
          @click=${() => props.onSimplexInviteCreate(accountId, "connect")}
        >
          ${busyCreate ? "Working..." : "Create invite"}
        </button>
        <button
          class="btn"
          ?disabled=${busyCreate}
          @click=${() => props.onSimplexInviteCreate(accountId, "address")}
        >
          Create address
        </button>
        <button
          class="btn"
          ?disabled=${busyPending}
          @click=${() => props.onSimplexInviteList(accountId)}
        >
          ${busyPending ? "Loading..." : "Pending"}
        </button>
        <button
          class="btn danger"
          ?disabled=${busyRevoke}
          @click=${() => props.onSimplexInviteRevoke(accountId)}
        >
          ${busyRevoke ? "Revoking..." : "Revoke address"}
        </button>
      </div>
    `;
  };

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
            <span title=${formatEndpoint(wsUrl)}>${formatEndpoint(wsUrl)}</span>
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
        ${renderSimplexControls(account.accountId)}
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
                <span title=${formatEndpoint(simplex?.wsUrl)}>${formatEndpoint(simplex?.wsUrl)}</span>
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
      ${hasMultipleAccounts ? nothing : renderSimplexControls(primaryAccountId)}

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
