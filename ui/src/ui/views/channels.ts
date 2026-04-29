import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../format.ts";
import type {
  ChannelAccountSnapshot,
  ChannelUiMetaEntry,
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
import { renderChannelConfigSection } from "./channels.config.ts";
import { renderDiscordCard } from "./channels.discord.ts";
import { renderGoogleChatCard } from "./channels.googlechat.ts";
import { renderIMessageCard } from "./channels.imessage.ts";
import { renderNostrCard } from "./channels.nostr.ts";
import {
  channelEnabled,
  formatNullableBoolean,
  renderChannelAccountCount,
  resolveChannelDisplayState,
} from "./channels.shared.ts";
import { renderSignalCard } from "./channels.signal.ts";
import { renderSlackCard } from "./channels.slack.ts";
import { renderTelegramCard } from "./channels.telegram.ts";
import type { ChannelKey, ChannelsChannelData, ChannelsProps } from "./channels.types.ts";
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
  const healthSummary = resolveChannelHealthSummary(props.snapshot);
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

  return html`
    <section class="grid grid-cols-2">
      ${orderedChannels.map((channel) =>
        renderChannel(channel.key, props, {
          whatsapp,
          telegram,
          discord,
          googlechat,
          slack,
          signal,
          imessage,
          nostr,
          channelAccounts: props.snapshot?.channelAccounts ?? null,
        }),
      )}
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">${t("channels.health.title")}</div>
          <div class="card-sub">${t("channels.health.subtitle")}</div>
        </div>
        <div class="muted">
          ${props.lastSuccessAt ? formatRelativeTimestamp(props.lastSuccessAt) : t("common.na")}
        </div>
      </div>
      ${props.lastError
        ? html`<div class="callout danger" style="margin-top: 12px;">${props.lastError}</div>`
        : nothing}
      ${renderChannelHealthSummary(healthSummary)}
      <pre class="code-block" style="margin-top: 12px;">
${props.snapshot ? JSON.stringify(props.snapshot, null, 2) : t("channels.health.noSnapshotYet")}
      </pre
      >
    </section>
  `;
}

type ChannelHealthSummary = {
  configured: number;
  running: number;
  connected: number;
  warnings: string[];
};

const STALE_CHANNEL_ACTIVITY_MS = 10 * 60 * 1000;

function renderChannelHealthSummary(summary: ChannelHealthSummary) {
  return html`
    <div class="grid grid-cols-3" style="margin-top: 12px;">
      ${renderHealthMetric(t("channels.health.metrics.configured"), summary.configured)}
      ${renderHealthMetric(t("channels.health.metrics.running"), summary.running)}
      ${renderHealthMetric(t("channels.health.metrics.connected"), summary.connected)}
    </div>
    ${summary.warnings.length
      ? html`
          <div class="stack" style="margin-top: 12px;">
            ${summary.warnings.map((warning) => html`<div class="callout warn">${warning}</div>`)}
          </div>
        `
      : html`<div class="callout success" style="margin-top: 12px;">
          ${t("channels.health.noAttentionItems")}
        </div>`}
  `;
}

function renderHealthMetric(label: string, value: number) {
  return html`
    <div class="account-card">
      <div class="account-card-id">${label}</div>
      <div class="card-title">${value}</div>
    </div>
  `;
}

export function resolveChannelHealthSummary(
  snapshot: ChannelsStatusSnapshot | null,
  now = Date.now(),
): ChannelHealthSummary {
  if (!snapshot) {
    return {
      configured: 0,
      running: 0,
      connected: 0,
      warnings: [],
    };
  }

  let configured = 0;
  let running = 0;
  let connected = 0;
  const warnings: string[] = [];

  for (const key of resolveChannelOrder(snapshot)) {
    const label = resolveChannelLabel(snapshot, key);
    const status = (snapshot.channels?.[key] ?? null) as Record<string, unknown> | null;
    const accounts = snapshot.channelAccounts?.[key] ?? [];
    const channelConfigured =
      status?.configured === true || accounts.some((account) => account.configured === true);
    const channelRunning =
      status?.running === true || accounts.some((account) => account.running === true);
    const channelConnected =
      status?.connected === true || accounts.some((account) => account.connected === true);

    if (channelConfigured) {
      configured += 1;
    }
    if (channelRunning) {
      running += 1;
    }
    if (channelConnected) {
      connected += 1;
    }

    const statusHealth =
      typeof status?.healthState === "string" && status.healthState.length > 0
        ? status.healthState
        : null;
    const statusError =
      typeof status?.lastError === "string" && status.lastError.length > 0
        ? status.lastError
        : null;

    if (
      channelConfigured &&
      channelRunning &&
      !channelConnected &&
      !channelHasOkReadback(status, accounts) &&
      channelDeclaresConnectionState(status, accounts)
    ) {
      warnings.push(t("channels.health.warnings.noActiveConnection", { channel: label }));
    }
    if (statusHealth && !["healthy", "connected"].includes(statusHealth)) {
      warnings.push(
        t("channels.health.warnings.healthState", { channel: label, state: statusHealth }),
      );
    }
    if (statusError) {
      warnings.push(t("channels.health.warnings.reports", { channel: label, error: statusError }));
    }

    for (const account of accounts) {
      warnings.push(...resolveAccountAttentionItems(label, account, now));
    }
  }

  return {
    configured,
    running,
    connected,
    warnings,
  };
}

const CONNECTION_STATE_FIELDS = [
  "connected",
  "lastConnectedAt",
  "lastTransportActivityAt",
  "readbackState",
  "lastReadbackAt",
  "lastReadbackError",
  "readbackRequiredScopes",
  "readbackMissingScopes",
] as const;

function hasOwnConnectionStateField(value: Record<string, unknown> | null): boolean {
  if (!value) {
    return false;
  }
  return CONNECTION_STATE_FIELDS.some((field) => Object.hasOwn(value, field));
}

function channelDeclaresConnectionState(
  status: Record<string, unknown> | null,
  accounts: ChannelAccountSnapshot[],
): boolean {
  if (hasOwnConnectionStateField(status)) {
    return true;
  }
  return accounts.some((account) =>
    CONNECTION_STATE_FIELDS.some((field) =>
      Object.hasOwn(account as Record<string, unknown>, field),
    ),
  );
}

function channelHasOkReadback(
  status: Record<string, unknown> | null,
  accounts: ChannelAccountSnapshot[],
): boolean {
  return (
    status?.readbackState === "ok" || accounts.some((account) => account.readbackState === "ok")
  );
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
  const label = resolveChannelLabel(props.snapshot, key);
  const displayState = resolveChannelDisplayState(key, props);
  const lastError =
    typeof displayState.status?.lastError === "string" ? displayState.status.lastError : undefined;
  const accounts = channelAccounts[key] ?? [];
  const accountCountLabel = renderChannelAccountCount(key, channelAccounts);

  return html`
    <div class="card">
      <div class="card-title">${label}</div>
      <div class="card-sub">${t("channels.generic.subtitle")}</div>
      ${accountCountLabel}
      ${accounts.length > 0
        ? html`
            <div class="account-card-list">
              ${accounts.map((account) => renderGenericAccount(account))}
            </div>
          `
        : html`
            <div class="status-list" style="margin-top: 16px;">
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
    </div>
  `;
}

function resolveChannelMetaMap(
  snapshot: ChannelsStatusSnapshot | null,
): Record<string, ChannelUiMetaEntry> {
  if (!snapshot?.channelMeta?.length) {
    return {};
  }
  return Object.fromEntries(snapshot.channelMeta.map((entry) => [entry.id, entry]));
}

function resolveChannelLabel(snapshot: ChannelsStatusSnapshot | null, key: string): string {
  const meta = resolveChannelMetaMap(snapshot)[key];
  return meta?.label ?? snapshot?.channelLabels?.[key] ?? key;
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
  const lastActivityAt = newestAccountActivityAt(account);

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
          <span class="label">${t("common.lastActivity")}</span>
          <span>${lastActivityAt ? formatRelativeTimestamp(lastActivityAt) : t("common.na")}</span>
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

function resolveAccountAttentionItems(
  channelLabel: string,
  account: ChannelAccountSnapshot,
  now: number,
): string[] {
  const prefix =
    account.name && account.name !== account.accountId
      ? `${channelLabel} (${account.name})`
      : `${channelLabel} (${account.accountId})`;
  const warnings: string[] = [];

  if (account.healthState && !["healthy", "connected"].includes(account.healthState)) {
    warnings.push(
      t("channels.health.warnings.accountHealthState", {
        account: prefix,
        state: account.healthState,
      }),
    );
  }
  if (account.lastError) {
    warnings.push(
      t("channels.health.warnings.accountReports", {
        account: prefix,
        error: account.lastError,
      }),
    );
  }
  if (account.readbackState && account.readbackState !== "ok") {
    warnings.push(
      account.lastReadbackError
        ? t("channels.health.warnings.accountReadbackWithError", {
            account: prefix,
            state: account.readbackState,
            error: account.lastReadbackError,
          })
        : t("channels.health.warnings.accountReadback", {
            account: prefix,
            state: account.readbackState,
          }),
    );
  }
  if (account.readbackMissingScopes?.length) {
    warnings.push(
      t("channels.health.warnings.accountMissingScopes", {
        account: prefix,
        scopes: account.readbackMissingScopes.join(", "),
      }),
    );
  }
  if (account.running && account.connected === false) {
    warnings.push(t("channels.health.warnings.accountDisconnected", { account: prefix }));
  }

  const lastActivityAt = newestAccountActivityAt(account);
  if (
    (account.running || account.connected) &&
    lastActivityAt &&
    now - lastActivityAt > STALE_CHANNEL_ACTIVITY_MS
  ) {
    warnings.push(t("channels.health.warnings.accountStaleActivity", { account: prefix }));
  }

  return warnings;
}

function newestAccountActivityAt(account: ChannelAccountSnapshot): number | null {
  const values = [
    account.lastTransportActivityAt,
    account.lastInboundAt,
    account.lastOutboundAt,
    account.lastConnectedAt,
    account.lastProbeAt,
  ].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  return values.length ? Math.max(...values) : null;
}
