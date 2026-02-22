import { html, nothing } from "lit";
import { formatRelativeTimestamp } from "../format.ts";
import type { ChannelAccountSnapshot, SimplexStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import type { ChannelsProps } from "./channels.types.ts";

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

  const copyText = async (value: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      }
    } catch {
      // Ignore clipboard errors in readonly dashboard mode.
    }
  };

  const renderLinkField = (params: {
    label: string;
    link: string;
    qrDataUrl?: string | null;
    onDelete?: () => void;
    deleteBusy?: boolean;
  }) => {
    const { label, link, qrDataUrl, onDelete, deleteBusy = false } = params;
    return html`
      <div
        style="margin-top: 12px; border: 1px solid var(--border-color); border-radius: 8px; padding: 12px;"
      >
        <div class="row" style="justify-content: space-between; gap: 12px; align-items: center;">
          <div class="muted">${label}</div>
          <div class="row" style="gap: 8px;">
            <button class="btn btn--sm" @click=${() => void copyText(link)}>Copy</button>
            ${
              onDelete
                ? html`<button class="btn btn--sm danger" ?disabled=${deleteBusy} @click=${onDelete}>
                    ${deleteBusy ? "Deleting..." : "Delete"}
                  </button>`
                : nothing
            }
          </div>
        </div>
        <pre class="code-block" style="margin-top: 8px;">${link}</pre>
        ${
          qrDataUrl
            ? html`<div class="qr-wrap" style="margin-top: 10px;">
              <img src=${qrDataUrl} alt="${label} QR" />
            </div>`
            : nothing
        }
      </div>
    `;
  };

  const renderSimplexControls = (accountId: string) => {
    const state = props.simplexControlByAccount[accountId];
    const account = simplexAccounts.find((entry) => entry.accountId === accountId);
    const hydratedAddressLink = (() => {
      const app = account?.application;
      if (!app || typeof app !== "object") {
        return null;
      }
      const candidate = (app as { addressLink?: unknown }).addressLink;
      return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
    })();
    const busyCreate = state?.busyCreate ?? false;
    const busyRevoke = state?.busyRevoke ?? false;
    const addressExists = Boolean(state?.addressLink?.trim() || hydratedAddressLink);
    return html`
      ${
        state?.message
          ? html`<div class="callout" style="margin-top: 12px;">
            ${state.message}
          </div>`
          : nothing
      }
      ${
        state?.error
          ? html`<div class="callout danger" style="margin-top: 12px;">
            ${state.error}
          </div>`
          : nothing
      }
      <div class="row" style="margin-top: 12px; flex-wrap: wrap;">
        <button
          class="btn primary"
          ?disabled=${busyCreate}
          @click=${() => props.onSimplexOneTimeLinkCreate(accountId)}
        >
          ${busyCreate ? "Working..." : "Create 1-time Link"}
        </button>
        <button
          class="btn"
          ?disabled=${busyCreate}
          @click=${() => props.onSimplexAddressShowOrCreate(accountId)}
        >
          ${addressExists ? "Show Address" : "Create Address"}
        </button>
      </div>
      ${(() => {
        const latestLink = state?.latestOneTimeInviteLink?.trim();
        if (!latestLink) {
          return nothing;
        }
        return renderLinkField({
          label: "1-time Link",
          link: latestLink,
          qrDataUrl: state?.latestOneTimeInviteQrDataUrl ?? null,
        });
      })()}
      ${
        state?.addressLink
          ? renderLinkField({
              label: "Address",
              link: state.addressLink,
              qrDataUrl: state.addressQrDataUrl,
              onDelete: () => props.onSimplexInviteRevoke(accountId),
              deleteBusy: busyRevoke,
            })
          : nothing
      }
      ${
        busyRevoke
          ? html`
              <div class="muted" style="margin-top: 8px">Deleting address...</div>
            `
          : nothing
      }
    `;
  };

  const renderAccountCard = (account: ChannelAccountSnapshot) => {
    const label = account.name || account.accountId;
    const wsUrl = (() => {
      const app = account.application;
      if (!app || typeof app !== "object") {
        return null;
      }
      const value = (app as { wsUrl?: unknown }).wsUrl;
      if (typeof value !== "string") {
        return null;
      }
      const trimmed = value.trim();
      return trimmed ? trimmed : null;
    })();
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
            <span>
              ${account.lastInboundAt ? formatRelativeTimestamp(account.lastInboundAt) : "n/a"}
            </span>
          </div>
          <div>
            <span class="label">Last outbound</span>
            <span>
              ${account.lastOutboundAt ? formatRelativeTimestamp(account.lastOutboundAt) : "n/a"}
            </span>
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
                <span>
                  ${simplex?.lastStartAt ? formatRelativeTimestamp(simplex.lastStartAt) : "n/a"}
                </span>
              </div>
              <div>
                <span class="label">Last inbound</span>
                <span>
                  ${
                    simplexAccounts[0]?.lastInboundAt
                      ? formatRelativeTimestamp(simplexAccounts[0].lastInboundAt)
                      : "n/a"
                  }
                </span>
              </div>
              <div>
                <span class="label">Last outbound</span>
                <span>
                  ${
                    simplexAccounts[0]?.lastOutboundAt
                      ? formatRelativeTimestamp(simplexAccounts[0].lastOutboundAt)
                      : "n/a"
                  }
                </span>
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
