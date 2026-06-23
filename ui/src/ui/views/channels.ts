// Control UI view renders the channels directory screen.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../format.ts";
import { icon } from "../icons.ts";
import type {
  ChannelAccountSnapshot,
  ChannelsStatusSnapshot,
  DiscordStatus,
  GoogleChatStatus,
  IMessageStatus,
  NostrProfile,
  NostrStatus,
  SignalStatus,
  SlackStatus,
  TelegramStatus,
  WhatsAppStatus,
} from "../types.ts";
import { renderChannelLogo } from "./channel-logos.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import { renderDiscordCard } from "./channels.discord.ts";
import { renderGoogleChatCard } from "./channels.googlechat.ts";
import { renderIMessageCard } from "./channels.imessage.ts";
import { renderNostrCard } from "./channels.nostr.ts";
import {
  channelEnabled,
  formatNullableBoolean,
  renderChannelAccountCount,
  resolveChannelDirectoryName,
  resolveChannelDirectorySubtitle,
  resolveChannelDisplayState,
  resolveChannelDotState,
  type ChannelDotState,
} from "./channels.shared.ts";
import { renderSignalCard } from "./channels.signal.ts";
import { renderSlackCard } from "./channels.slack.ts";
import { renderTelegramCard } from "./channels.telegram.ts";
import type {
  ChannelFilter,
  ChannelKey,
  ChannelsChannelData,
  ChannelsProps,
} from "./channels.types.ts";
import { renderWhatsAppCard } from "./channels.whatsapp.ts";

export function renderChannels(props: ChannelsProps) {
  const channels = props.snapshot?.channels as Record<string, unknown> | null;
  const whatsapp = (channels?.whatsapp ?? undefined) as WhatsAppStatus | undefined;
  const telegram = (channels?.telegram ?? undefined) as TelegramStatus | undefined;
  const discord = (channels?.discord ?? null) as DiscordStatus | null;
  const googlechat = (channels?.googlechat ?? null) as GoogleChatStatus | null;
  const slack = (channels?.slack ?? null) as SlackStatus | null;
  const signal = (channels?.signal ?? null) as SignalStatus | null;
  const imessage = (channels?.imessage ?? null) as IMessageStatus | null;
  const nostr = (channels?.nostr ?? null) as NostrStatus | null;
  const channelOrder = resolveChannelOrder(props.snapshot);
  const orderedChannels = channelOrder
    .map((key, index) => ({
      key,
      enabled: channelEnabled(key, props),
      order: index,
    }))
    .toSorted((a, b) => {
      if (a.enabled !== b.enabled) {
        return a.enabled ? -1 : 1;
      }
      return a.order - b.order;
    });

  const data: ChannelsChannelData = {
    whatsapp,
    telegram,
    discord,
    googlechat,
    slack,
    signal,
    imessage,
    nostr,
    channelAccounts: props.snapshot?.channelAccounts ?? null,
  };

  const enabledCount = orderedChannels.filter((channel) => channel.enabled).length;
  const totalCount = orderedChannels.length;
  const filter = props.channelFilter;
  const visibleChannels = orderedChannels.filter((channel) =>
    filter === "enabled" ? channel.enabled : filter === "disabled" ? !channel.enabled : true,
  );

  const filterOptions: ReadonlyArray<{ value: ChannelFilter; label: string; count: number }> = [
    { value: "all", label: t("channels.directory.all"), count: totalCount },
    { value: "enabled", label: t("common.enabled"), count: enabledCount },
    { value: "disabled", label: t("common.disabled"), count: totalCount - enabledCount },
  ];

  return html`
    <section class="channel-directory">
      <div
        class="channel-directory__filters"
        role="group"
        aria-label=${t("channels.directory.filterLabel")}
      >
        ${filterOptions.map((option) => renderFilterButton(props, option))}
      </div>

      ${renderHealthCallouts(props)}

      <div class="channel-directory__list">
        ${visibleChannels.length === 0
          ? html`<div class="channel-directory__empty muted">${t("channels.directory.empty")}</div>`
          : visibleChannels.map((channel) => renderChannelRow(channel.key, props, data))}
      </div>

      ${renderRawSnapshot(props)}
    </section>
  `;
}

function renderFilterButton(
  props: ChannelsProps,
  option: { value: ChannelFilter; label: string; count: number },
) {
  const active = props.channelFilter === option.value;
  return html`
    <button
      class="channel-filter ${active ? "channel-filter--active" : ""}"
      aria-pressed=${active}
      @click=${() => props.onChannelFilterChange(option.value)}
    >
      ${option.label}<span class="channel-filter__count">${option.count}</span>
    </button>
  `;
}

const DOT_CLASS: Record<ChannelDotState, string> = { ok: "ok", warn: "warn", off: "muted" };

function resolveStatusLabel(state: ChannelDotState) {
  return state === "ok"
    ? t("common.connected")
    : state === "warn"
      ? t("channels.directory.needsAttention")
      : t("common.disabled");
}

function renderStatusDot(state: ChannelDotState) {
  return html`<span
    class="statusDot ${DOT_CLASS[state]} channel-row__dot"
    aria-hidden="true"
  ></span>`;
}

function renderChannelRow(key: ChannelKey, props: ChannelsProps, data: ChannelsChannelData) {
  const expanded = props.expandedChannelIds.includes(key);
  const name = resolveChannelDirectoryName(props.snapshot, key);
  const subtitle = resolveChannelDirectorySubtitle(key);
  const dotState = resolveChannelDotState(key, props);
  const statusLabel = resolveStatusLabel(dotState);
  return html`
    <div class="channel-row ${expanded ? "channel-row--open" : ""}">
      <button
        class="channel-row__header"
        aria-expanded=${expanded}
        aria-label=${`${name}. ${subtitle} ${statusLabel}.`}
        @click=${() => props.onChannelToggle(key)}
      >
        ${renderChannelLogo(key)}
        <span class="channel-row__text">
          <span class="channel-row__name">${name}</span>
          <span class="channel-row__sub">${subtitle}</span>
        </span>
        ${renderStatusDot(dotState)}
        <span class="channel-row__chevron">${icon(expanded ? "chevronDown" : "chevronRight")}</span>
      </button>
      ${expanded
        ? html`<div class="channel-row__body" role="region" aria-label=${name}>
            ${renderChannel(key, props, data)}
          </div>`
        : nothing}
    </div>
  `;
}

function renderHealthCallouts(props: ChannelsProps) {
  const showingStaleSnapshot = Boolean(props.loading && props.snapshot && props.lastSuccessAt);
  const partialWarnings = props.snapshot?.warnings?.filter((warning) => warning.trim()) ?? [];
  return html`
    ${showingStaleSnapshot
      ? html`<div class="callout info">
          Refreshing channel status in the background; showing the last successful snapshot.
        </div>`
      : nothing}
    ${props.snapshot?.partial
      ? html`<div class="callout warn">
          Some channel checks did not finish before the UI budget.
          ${partialWarnings.length > 0 ? partialWarnings.slice(0, 3).join("; ") : ""}
        </div>`
      : nothing}
    ${props.lastError ? html`<div class="callout danger">${props.lastError}</div>` : nothing}
  `;
}

function renderRawSnapshot(props: ChannelsProps) {
  const lastSeen = props.lastSuccessAt
    ? formatRelativeTimestamp(props.lastSuccessAt)
    : t("common.na");
  return html`
    <details class="channel-raw">
      <summary>${t("channels.health.title")} · ${lastSeen}</summary>
      <pre class="code-block">
${props.snapshot ? JSON.stringify(props.snapshot, null, 2) : t("channels.health.noSnapshotYet")}
      </pre
      >
    </details>
  `;
}

function resolveChannelOrder(snapshot: ChannelsStatusSnapshot | null): ChannelKey[] {
  if (snapshot?.channelMeta?.length) {
    return snapshot.channelMeta.map((entry) => entry.id);
  }
  if (snapshot?.channelOrder?.length) {
    return snapshot.channelOrder;
  }
  return ["whatsapp", "telegram", "discord", "googlechat", "slack", "signal", "imessage", "nostr"];
}

function renderChannel(key: ChannelKey, props: ChannelsProps, data: ChannelsChannelData) {
  const accountCountLabel = renderChannelAccountCount(key, data.channelAccounts);
  switch (key) {
    case "whatsapp":
      return renderWhatsAppCard({
        props,
        whatsapp: data.whatsapp,
        accountCountLabel,
      });
    case "telegram":
      return renderTelegramCard({
        props,
        telegram: data.telegram,
        telegramAccounts: data.channelAccounts?.telegram ?? [],
        accountCountLabel,
      });
    case "discord":
      return renderDiscordCard({
        props,
        discord: data.discord,
        accountCountLabel,
      });
    case "googlechat":
      return renderGoogleChatCard({
        props,
        googleChat: data.googlechat,
        accountCountLabel,
      });
    case "slack":
      return renderSlackCard({
        props,
        slack: data.slack,
        accountCountLabel,
      });
    case "signal":
      return renderSignalCard({
        props,
        signal: data.signal,
        accountCountLabel,
      });
    case "imessage":
      return renderIMessageCard({
        props,
        imessage: data.imessage,
        accountCountLabel,
      });
    case "nostr": {
      const nostrAccounts = data.channelAccounts?.nostr ?? [];
      const primaryAccount = nostrAccounts[0];
      const accountId = primaryAccount?.accountId ?? "default";
      const profile =
        (primaryAccount as { profile?: NostrProfile | null } | undefined)?.profile ?? null;
      const showForm =
        props.nostrProfileAccountId === accountId ? props.nostrProfileFormState : null;
      const profileFormCallbacks = showForm
        ? {
            onFieldChange: props.onNostrProfileFieldChange,
            onSave: props.onNostrProfileSave,
            onImport: props.onNostrProfileImport,
            onCancel: props.onNostrProfileCancel,
            onToggleAdvanced: props.onNostrProfileToggleAdvanced,
          }
        : null;
      return renderNostrCard({
        props,
        nostr: data.nostr,
        nostrAccounts,
        accountCountLabel,
        profileFormState: showForm,
        profileFormCallbacks,
        onEditProfile: () => props.onNostrProfileEdit(accountId, profile),
      });
    }
    default:
      return renderGenericChannelCard(key, props, data.channelAccounts ?? {});
  }
}

function renderGenericChannelCard(
  key: ChannelKey,
  props: ChannelsProps,
  channelAccounts: Record<string, ChannelAccountSnapshot[]>,
) {
  const displayState = resolveChannelDisplayState(key, props);
  const lastError =
    typeof displayState.status?.lastError === "string" ? displayState.status.lastError : undefined;
  const accounts = channelAccounts[key] ?? [];
  const accountCountLabel = renderChannelAccountCount(key, channelAccounts);

  return html`
    ${accountCountLabel}
    ${accounts.length > 0
      ? html`
          <div class="account-card-list">
            ${accounts.map((account) => renderGenericAccount(account))}
          </div>
        `
      : html`
          <div class="status-list">
            <div>
              <span class="label">${t("common.configured")}</span>
              <span>${formatNullableBoolean(displayState.configured)}</span>
            </div>
            <div>
              <span class="label">${t("common.running")}</span>
              <span>${formatNullableBoolean(displayState.running)}</span>
            </div>
            <div>
              <span class="label">${t("common.connected")}</span>
              <span>${formatNullableBoolean(displayState.connected)}</span>
            </div>
          </div>
        `}
    ${lastError
      ? html`<div class="callout danger" style="margin-top: 12px;">${lastError}</div>`
      : nothing}
    ${renderChannelConfigSection({ channelId: key, props })}
  `;
}

const RECENT_ACTIVITY_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

function hasRecentActivity(account: ChannelAccountSnapshot): boolean {
  if (!account.lastInboundAt) {
    return false;
  }
  return Date.now() - account.lastInboundAt < RECENT_ACTIVITY_THRESHOLD_MS;
}

function deriveRunningStatus(account: ChannelAccountSnapshot): string {
  if (account.running) {
    return t("common.yes");
  }
  // If we have recent inbound activity, the channel is effectively running
  if (hasRecentActivity(account)) {
    return t("common.active");
  }
  return t("common.no");
}

function deriveConnectedStatus(account: ChannelAccountSnapshot): string {
  if (account.connected === true) {
    return t("common.yes");
  }
  if (account.connected === false) {
    return t("common.no");
  }
  // If connected is null/undefined but we have recent activity, show as active
  if (hasRecentActivity(account)) {
    return t("common.active");
  }
  return t("common.na");
}

function renderGenericAccount(account: ChannelAccountSnapshot) {
  const runningStatus = deriveRunningStatus(account);
  const connectedStatus = deriveConnectedStatus(account);

  return html`
    <div class="account-card">
      <div class="account-card-header">
        <div class="account-card-title">${account.name || account.accountId}</div>
        <div class="account-card-id">${account.accountId}</div>
      </div>
      <div class="status-list account-card-status">
        <div>
          <span class="label">${t("common.running")}</span>
          <span>${runningStatus}</span>
        </div>
        <div>
          <span class="label">${t("common.configured")}</span>
          <span>${account.configured ? t("common.yes") : t("common.no")}</span>
        </div>
        <div>
          <span class="label">${t("common.connected")}</span>
          <span>${connectedStatus}</span>
        </div>
        <div>
          <span class="label">${t("common.lastInbound")}</span>
          <span
            >${account.lastInboundAt
              ? formatRelativeTimestamp(account.lastInboundAt)
              : t("common.na")}</span
          >
        </div>
        ${account.lastError
          ? html` <div class="account-card-error">${account.lastError}</div> `
          : nothing}
      </div>
    </div>
  `;
}
