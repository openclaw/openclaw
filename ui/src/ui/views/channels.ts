import { html, nothing, type TemplateResult } from "lit";

import { formatAgo } from "../format";
import { icon, type IconName } from "../icons";
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
} from "../types";
import type {
  ChannelKey,
  ChannelsChannelData,
  ChannelsProps,
} from "./channels.types";
import {
  channelEnabled,
  getChannelAccountCount,
  renderChannelIntegrationCard,
  type ChannelCardFrame,
  type ChannelCardVisualState,
} from "./channels.shared";
import { renderChannelConfigSection } from "./channels.config";
import { renderDiscordCard } from "./channels.discord";
import { renderGoogleChatCard } from "./channels.googlechat";
import { renderIMessageCard } from "./channels.imessage";
import { renderNostrCard } from "./channels.nostr";
import { renderSignalCard } from "./channels.signal";
import { renderSlackCard } from "./channels.slack";
import { renderTelegramCard } from "./channels.telegram";
import { renderWhatsAppCard } from "./channels.whatsapp";
import { renderChannelWizard } from "./channel-config-wizard";

export function renderChannels(props: ChannelsProps) {
  const channels = props.snapshot?.channels as Record<string, unknown> | null;
  const whatsapp = (channels?.whatsapp ?? undefined) as
    | WhatsAppStatus
    | undefined;
  const telegram = (channels?.telegram ?? undefined) as
    | TelegramStatus
    | undefined;
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
    .sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.order - b.order;
    });

  return html`
    <section class="card channels-header">
      <div class="row" style="justify-content: space-between; align-items: center;">
        <div>
          <div class="card-title">Channels</div>
          <div class="card-sub">Connect and manage your messaging integrations.</div>
        </div>
        <div class="row" style="gap: 10px; flex-wrap: wrap; justify-content: flex-end;">
          <button
            class="btn btn--sm"
            ?disabled=${props.loading}
            @click=${() => props.onRefresh(false)}
          >
            <span aria-hidden="true">${icon("refresh-cw", { size: 16 })}</span>
            Refresh
          </button>
          <button
            class="btn btn--sm primary"
            ?disabled=${props.loading}
            @click=${() => props.onRefresh(true)}
          >
            <span aria-hidden="true">${icon("zap", { size: 16 })}</span>
            Probe
          </button>
        </div>
      </div>
      <div class="muted" style="margin-top: 10px;">
        Last snapshot: ${props.lastSuccessAt ? formatAgo(props.lastSuccessAt) : "n/a"}
      </div>
      ${props.lastError
        ? html`<div class="callout danger" style="margin-top: 12px;">
            ${props.lastError}
          </div>`
        : nothing}
      <details style="margin-top: 12px;">
        <summary class="btn btn--sm">Snapshot JSON</summary>
        <pre class="code-block" style="margin-top: 12px;">
${props.snapshot ? JSON.stringify(props.snapshot, null, 2) : "No snapshot yet."}
        </pre>
      </details>
    </section>

    <section class="channels-grid" style="margin-top: 18px;">
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

    ${renderChannelWizard({
      state: props.wizardState,
      props,
      onClose: () => props.onWizardClose(),
      onSave: () => props.onWizardSave(),
      onDiscard: () => props.onWizardDiscard(),
      onSectionChange: (sectionId) => props.onWizardSectionChange(sectionId),
      onConfirmClose: () => props.onWizardConfirmClose(),
      onCancelClose: () => props.onWizardCancelClose(),
    })}
  `;
}

function resolveChannelOrder(snapshot: ChannelsStatusSnapshot | null): ChannelKey[] {
  if (snapshot?.channelMeta?.length) {
    return snapshot.channelMeta.map((entry) => entry.id) as ChannelKey[];
  }
  if (snapshot?.channelOrder?.length) {
    return snapshot.channelOrder;
  }
  return [
    "whatsapp",
    "telegram",
    "discord",
    "googlechat",
    "slack",
    "signal",
    "imessage",
    "nostr",
  ];
}

function channelIconFor(key: ChannelKey): IconName {
  switch (key) {
    case "whatsapp":
      return "message-square";
    case "telegram":
      return "send";
    case "discord":
      return "sparkles";
    case "googlechat":
      return "message-square";
    case "slack":
      return "layout-dashboard";
    case "signal":
      return "radio";
    case "imessage":
      return "message-square";
    case "nostr":
      return "zap";
    default:
      return "link";
  }
}

function channelColorClassFor(key: ChannelKey): string | null {
  switch (key) {
    case "whatsapp":
    case "telegram":
    case "discord":
    case "googlechat":
    case "slack":
    case "signal":
    case "imessage":
    case "nostr":
      return key;
    default:
      return null;
  }
}

function channelSubtitleFor(key: ChannelKey): string {
  switch (key) {
    case "whatsapp":
      return "Link WhatsApp Web and monitor connection health.";
    case "telegram":
    case "discord":
      return "Bot status and channel configuration.";
    case "googlechat":
      return "Google Chat status and configuration.";
    case "slack":
      return "Socket mode status and channel configuration.";
    case "signal":
      return "signal-cli status and channel configuration.";
    case "imessage":
      return "macOS bridge status and channel configuration.";
    case "nostr":
      return "Decentralized DMs via Nostr relays (NIP-04).";
    default:
      return "Channel status and configuration.";
  }
}

function resolveChannelStatusObject(
  snapshot: ChannelsStatusSnapshot | null,
  key: ChannelKey,
): Record<string, unknown> | null {
  const channels = snapshot?.channels as Record<string, unknown> | null;
  if (!channels) return null;
  const status = channels[key];
  return status && typeof status === "object" ? (status as Record<string, unknown>) : null;
}

function resolveChannelError(
  key: ChannelKey,
  snapshot: ChannelsStatusSnapshot | null,
  channelAccounts: Record<string, ChannelAccountSnapshot[]> | null,
): string | null {
  const status = resolveChannelStatusObject(snapshot, key);
  const lastError = typeof status?.lastError === "string" ? status.lastError : null;
  if (lastError) return lastError;
  const accounts = channelAccounts?.[key] ?? [];
  for (const account of accounts) {
    if (typeof account.lastError === "string" && account.lastError) return account.lastError;
  }
  return null;
}

function deriveChannelVisualState(params: {
  loading: boolean;
  error: string | null;
  configured: boolean;
  connected: boolean;
  running: boolean;
  accountActive: boolean;
}): { state: ChannelCardVisualState; label: string } {
  if (params.loading) return { state: "loading", label: "Checking…" };
  if (params.error) return { state: "error", label: "Error" };
  if (params.connected || params.accountActive) return { state: "connected", label: "Connected" };
  if (params.running) return { state: "connected", label: "Running" };
  if (params.configured) return { state: "disconnected", label: "Configured" };
  return { state: "disconnected", label: "Offline" };
}

function renderChannelActions(key: ChannelKey, props: ChannelsProps): TemplateResult {
  const disabled = props.loading;
  const configureButton = html`
    <button
      class="btn btn--sm primary channel-card__action"
      ?disabled=${disabled}
      @click=${() => props.onWizardOpen(key)}
    >
      <span aria-hidden="true">${icon("settings", { size: 16 })}</span>
      Configure
    </button>
  `;

  if (key === "whatsapp") {
    return html`
      ${configureButton}
      <button
        class="btn btn--sm channel-card__action"
        ?disabled=${props.whatsappBusy || disabled}
        @click=${() => props.onWhatsAppStart(false)}
      >
        ${props.whatsappBusy ? "Working…" : "Show QR"}
      </button>
      <button
        class="btn btn--sm channel-card__action"
        ?disabled=${props.whatsappBusy || disabled}
        @click=${() => props.onWhatsAppStart(true)}
      >
        Relink
      </button>
      <button
        class="btn btn--sm danger channel-card__action"
        ?disabled=${props.whatsappBusy || disabled}
        @click=${() => props.onWhatsAppLogout()}
      >
        Logout
      </button>
      <button
        class="btn btn--sm channel-card__action"
        ?disabled=${disabled}
        @click=${() => props.onRefresh(true)}
      >
        <span aria-hidden="true">${icon("refresh-cw", { size: 16 })}</span>
        Probe
      </button>
    `;
  }

  return html`
    ${configureButton}
    <button
      class="btn btn--sm channel-card__action"
      ?disabled=${disabled}
      @click=${() => props.onRefresh(false)}
    >
      <span aria-hidden="true">${icon("refresh-cw", { size: 16 })}</span>
      Refresh
    </button>
    <button
      class="btn btn--sm channel-card__action"
      ?disabled=${disabled}
      @click=${() => props.onRefresh(true)}
    >
      <span aria-hidden="true">${icon("zap", { size: 16 })}</span>
      Probe
    </button>
  `;
}

function buildChannelFrame(
  key: ChannelKey,
  props: ChannelsProps,
  data: ChannelsChannelData,
): { frame: ChannelCardFrame; facts: TemplateResult; error: string | null } {
  const label = resolveChannelLabel(props.snapshot, key);
  const subtitle = channelSubtitleFor(key);
  const channelAccounts = data.channelAccounts ?? null;
  const status = resolveChannelStatusObject(props.snapshot, key);
  const accounts = channelAccounts?.[key] ?? [];

  const configured =
    (typeof status?.configured === "boolean" && status.configured) ||
    accounts.some((a) => a.configured);
  const running =
    (typeof status?.running === "boolean" && status.running) ||
    accounts.some((a) => a.running);
  const connected =
    (typeof status?.connected === "boolean" && status.connected) ||
    accounts.some((a) => a.connected === true);
  const accountActive = accounts.some((a) => a.running || a.connected || hasRecentActivity(a));

  const error = resolveChannelError(key, props.snapshot, channelAccounts);
  const loading = props.loading || (key === "whatsapp" && props.whatsappBusy);
  const derived = deriveChannelVisualState({
    loading,
    error,
    configured,
    connected,
    running,
    accountActive,
  });

  const count = getChannelAccountCount(key, channelAccounts);
  const accountsLabel = `${count} account${count === 1 ? "" : "s"}`;
  const hint = (() => {
    const lastProbeAt = typeof status?.lastProbeAt === "number" ? (status.lastProbeAt as number) : null;
    if (lastProbeAt) return `Last probe ${formatAgo(lastProbeAt)}`;
    const lastStartAt = typeof status?.lastStartAt === "number" ? (status.lastStartAt as number) : null;
    if (lastStartAt) return `Last start ${formatAgo(lastStartAt)}`;
    if (key === "whatsapp") {
      const linked = typeof status?.linked === "boolean" ? (status.linked as boolean) : null;
      if (linked === true) return "Linked";
      if (linked === false) return "Not linked";
    }
    return null;
  })();

  const facts = html`
    <div class="channel-fact ${configured ? "channel-fact--ok" : ""}">
      <span class="channel-fact__icon" aria-hidden="true"
        >${icon(configured ? "check" : "alert-circle", { size: 14 })}</span
      >
      <span class="channel-fact__label">Configured</span>
      <span class="channel-fact__value">${configured ? "Yes" : "No"}</span>
    </div>
    <div class="channel-fact ${running || accountActive ? "channel-fact--ok" : ""}">
      <span class="channel-fact__icon" aria-hidden="true"
        >${icon(running || accountActive ? "check" : "alert-circle", { size: 14 })}</span
      >
      <span class="channel-fact__label">Running</span>
      <span class="channel-fact__value">${running || accountActive ? "Yes" : "No"}</span>
    </div>
    <div class="channel-fact ${connected || accountActive ? "channel-fact--ok" : ""}">
      <span class="channel-fact__icon" aria-hidden="true"
        >${icon(connected || accountActive ? "check" : "alert-circle", { size: 14 })}</span
      >
      <span class="channel-fact__label">Connected</span>
      <span class="channel-fact__value">${connected || accountActive ? "Yes" : "No"}</span>
    </div>
  `;

  return {
    frame: {
      channelId: key,
      title: label,
      subtitle,
      iconName: channelIconFor(key),
      colorClass: channelColorClassFor(key),
      state: derived.state,
      stateLabel: derived.label,
      accountsLabel,
      hint,
    },
    facts,
    error,
  };
}

function renderChannel(
  key: ChannelKey,
  props: ChannelsProps,
  data: ChannelsChannelData,
) {
  const { frame, facts, error } = buildChannelFrame(key, props, data);
  const actions = renderChannelActions(key, props);
  switch (key) {
    case "whatsapp":
      return renderWhatsAppCard({
        whatsapp: data.whatsapp,
        frame,
        actions,
        facts,
        error,
        whatsappMessage: props.whatsappMessage,
        whatsappQrDataUrl: props.whatsappQrDataUrl,
        whatsappBusy: props.whatsappBusy,
        onWhatsAppWait: props.onWhatsAppWait,
        onRefresh: props.onRefresh,
      });
    case "telegram":
      return renderTelegramCard({
        telegram: data.telegram,
        telegramAccounts: data.channelAccounts?.telegram ?? [],
        frame,
        actions,
        facts,
        error,
      });
    case "discord":
      return renderDiscordCard({
        discord: data.discord,
        frame,
        actions,
        facts,
        error,
      });
    case "googlechat":
      return renderGoogleChatCard({
        googlechat: data.googlechat,
        frame,
        actions,
        facts,
        error,
      });
    case "slack":
      return renderSlackCard({
        slack: data.slack,
        frame,
        actions,
        facts,
        error,
      });
    case "signal":
      return renderSignalCard({
        signal: data.signal,
        frame,
        actions,
        facts,
        error,
      });
    case "imessage":
      return renderIMessageCard({
        imessage: data.imessage,
        frame,
        actions,
        facts,
        error,
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
        nostr: data.nostr,
        nostrAccounts,
        frame,
        actions,
        facts,
        error,
        profileFormState: showForm,
        profileFormCallbacks,
        onEditProfile: () => props.onNostrProfileEdit(accountId, profile),
      });
    }
    default:
      return renderGenericChannelCard(
        key,
        props,
        data.channelAccounts ?? {},
        frame,
        actions,
        facts,
        error,
      );
  }
}

function renderGenericChannelCard(
  key: ChannelKey,
  props: ChannelsProps,
  channelAccounts: Record<string, ChannelAccountSnapshot[]>,
  frame: ChannelCardFrame,
  actions: TemplateResult,
  facts: TemplateResult,
  error: string | null,
) {
  const status = props.snapshot?.channels?.[key] as Record<string, unknown> | undefined;
  const configured = typeof status?.configured === "boolean" ? status.configured : undefined;
  const running = typeof status?.running === "boolean" ? status.running : undefined;
  const connected = typeof status?.connected === "boolean" ? status.connected : undefined;
  const accounts = channelAccounts[key] ?? [];
  const details = html`
    ${accounts.length > 0
      ? html`
          <div class="account-card-list">
            ${accounts.map((account) => renderGenericAccount(account))}
          </div>
        `
      : html`
          <div class="status-list" style="margin-top: 16px;">
            <div>
              <span class="label">Configured</span>
              <span>${configured == null ? "n/a" : configured ? "Yes" : "No"}</span>
            </div>
            <div>
              <span class="label">Running</span>
              <span>${running == null ? "n/a" : running ? "Yes" : "No"}</span>
            </div>
            <div>
              <span class="label">Connected</span>
              <span>${connected == null ? "n/a" : connected ? "Yes" : "No"}</span>
            </div>
          </div>
        `}

    ${renderChannelConfigSection({ channelId: key, props })}
  `;

  return renderChannelIntegrationCard({
    frame,
    actions,
    facts,
    details,
    error,
  });
}

function resolveChannelMetaMap(
  snapshot: ChannelsStatusSnapshot | null,
): Record<string, ChannelUiMetaEntry> {
  if (!snapshot?.channelMeta?.length) return {};
  return Object.fromEntries(snapshot.channelMeta.map((entry) => [entry.id, entry]));
}

function resolveChannelLabel(
  snapshot: ChannelsStatusSnapshot | null,
  key: string,
): string {
  const meta = resolveChannelMetaMap(snapshot)[key];
  return meta?.label ?? snapshot?.channelLabels?.[key] ?? key;
}

const RECENT_ACTIVITY_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

function hasRecentActivity(account: ChannelAccountSnapshot): boolean {
  if (!account.lastInboundAt) return false;
  return Date.now() - account.lastInboundAt < RECENT_ACTIVITY_THRESHOLD_MS;
}

function deriveRunningStatus(account: ChannelAccountSnapshot): "Yes" | "No" | "Active" {
  if (account.running) return "Yes";
  // If we have recent inbound activity, the channel is effectively running
  if (hasRecentActivity(account)) return "Active";
  return "No";
}

function deriveConnectedStatus(account: ChannelAccountSnapshot): "Yes" | "No" | "Active" | "n/a" {
  if (account.connected === true) return "Yes";
  if (account.connected === false) return "No";
  // If connected is null/undefined but we have recent activity, show as active
  if (hasRecentActivity(account)) return "Active";
  return "n/a";
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
          <span class="label">Running</span>
          <span>${runningStatus}</span>
        </div>
        <div>
          <span class="label">Configured</span>
          <span>${account.configured ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Connected</span>
          <span>${connectedStatus}</span>
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
}
