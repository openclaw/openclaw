import { html, nothing, type TemplateResult } from "lit";

import type { ChannelAccountSnapshot } from "../types";
import { icon, type IconName } from "../icons";
import type { ChannelKey, ChannelsProps } from "./channels.types";

export function formatDuration(ms?: number | null) {
  if (!ms && ms !== 0) return "n/a";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  return `${hr}h`;
}

export function channelEnabled(key: ChannelKey, props: ChannelsProps) {
  const snapshot = props.snapshot;
  const channels = snapshot?.channels as Record<string, unknown> | null;
  if (!snapshot || !channels) return false;
  const channelStatus = channels[key] as Record<string, unknown> | undefined;
  const configured = typeof channelStatus?.configured === "boolean" && channelStatus.configured;
  const running = typeof channelStatus?.running === "boolean" && channelStatus.running;
  const connected = typeof channelStatus?.connected === "boolean" && channelStatus.connected;
  const accounts = snapshot.channelAccounts?.[key] ?? [];
  const accountActive = accounts.some(
    (account) => account.configured || account.running || account.connected,
  );
  return configured || running || connected || accountActive;
}

export function getChannelAccountCount(
  key: ChannelKey,
  channelAccounts?: Record<string, ChannelAccountSnapshot[]> | null,
): number {
  return channelAccounts?.[key]?.length ?? 0;
}

export function renderChannelAccountCount(
  key: ChannelKey,
  channelAccounts?: Record<string, ChannelAccountSnapshot[]> | null,
) {
  const count = getChannelAccountCount(key, channelAccounts);
  if (count < 2) return nothing;
  return html`<div class="account-count">Accounts (${count})</div>`;
}

export type ChannelCardVisualState =
  | "connected"
  | "disconnected"
  | "error"
  | "loading";

export type ChannelCardFrame = {
  channelId: ChannelKey;
  title: string;
  subtitle: string;
  iconName: IconName;
  /** Optional, known-safe class suffix for color theming (eg "whatsapp"). */
  colorClass?: string | null;
  state: ChannelCardVisualState;
  stateLabel: string;
  accountsLabel: string;
  hint?: string | null;
};

function resolveStateIcon(state: ChannelCardVisualState): IconName {
  switch (state) {
    case "connected":
      return "check";
    case "error":
      return "alert-triangle";
    case "loading":
      return "clock";
    case "disconnected":
    default:
      return "alert-circle";
  }
}

function resolveDetailsStorageKey(channelId: string): string {
  return `clawdbot:channels:detailsOpen:${encodeURIComponent(channelId)}`;
}

function readStoredDetailsOpen(channelId: string): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(resolveDetailsStorageKey(channelId));
    if (raw === "1") return true;
    if (raw === "0") return false;
    return null;
  } catch {
    return null;
  }
}

function writeStoredDetailsOpen(channelId: string, open: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(resolveDetailsStorageKey(channelId), open ? "1" : "0");
  } catch {
    // ignore
  }
}

export function renderChannelIntegrationCard(params: {
  frame: ChannelCardFrame;
  actions?: TemplateResult | null;
  facts?: TemplateResult | null;
  details?: TemplateResult | null;
  error?: string | null;
  detailsOpen?: boolean;
}) {
  const { frame } = params;
  const stateIcon = resolveStateIcon(frame.state);
  const stateClass = `channel-card__status--${frame.state}`;
  const storedOpen = readStoredDetailsOpen(frame.channelId);
  const resolvedOpen =
    params.error ? true : storedOpen ?? (params.detailsOpen ?? false);
  const colorClass = frame.colorClass ? `channel-card--${frame.colorClass}` : "";

  return html`
    <div
      class="channel-card ${colorClass} channel-card--${frame.state}"
      data-channel-id=${frame.channelId}
    >
      <div class="channel-card__header">
        <div class="channel-card__logo">${icon(frame.iconName, { size: 20 })}</div>
        <div class="channel-card__heading">
          <div class="channel-card__title">${frame.title}</div>
          <div class="channel-card__sub">${frame.subtitle}</div>
        </div>
        <div class="channel-card__status ${stateClass}">
          <span class="channel-card__status-dot" aria-hidden="true"></span>
          <span class="channel-card__status-icon" aria-hidden="true"
            >${icon(stateIcon, { size: 16 })}</span
          >
          <span class="channel-card__status-text">${frame.stateLabel}</span>
        </div>
      </div>

      <div class="channel-card__meta">
        <div class="channel-card__accounts">${frame.accountsLabel}</div>
        ${frame.hint ? html`<div class="channel-card__hint">${frame.hint}</div>` : nothing}
      </div>

      ${params.facts ? html`<div class="channel-card__facts">${params.facts}</div>` : nothing}

      ${params.error
        ? html`
            <div class="channel-card__error">
              <div class="channel-card__error-icon" aria-hidden="true">
                ${icon("alert-triangle", { size: 18 })}
              </div>
              <div class="channel-card__error-body">
                <div class="channel-card__error-title">Needs attention</div>
                <div class="channel-card__error-message">${params.error}</div>
              </div>
            </div>
          `
        : nothing}

      <div class="channel-card__actions">
        ${params.details
          ? html`
              <details
                class="channel-card__config"
                ?open=${resolvedOpen}
                @toggle=${(e: Event) => {
                  writeStoredDetailsOpen(
                    frame.channelId,
                    (e.currentTarget as HTMLDetailsElement).open,
                  );
                }}
              >
                <summary class="btn btn--sm primary channel-card__config-toggle">
                  <span class="channel-card__config-icon" aria-hidden="true">
                    ${icon("settings", { size: 16 })}
                  </span>
                  <span class="channel-card__config-label channel-card__config-label--closed"
                    >Configure</span
                  >
                  <span class="channel-card__config-label channel-card__config-label--open"
                    >Close</span
                  >
                </summary>
                <div class="channel-card__config-body">${params.details}</div>
              </details>
            `
          : nothing}
        ${params.actions ?? nothing}
      </div>
    </div>
  `;
}
