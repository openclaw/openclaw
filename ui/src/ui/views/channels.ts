import { html, nothing } from "lit";
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
import { channelIcon, COMING_SOON_CHANNELS } from "./channels.icons.ts";
import { renderIMessageCard } from "./channels.imessage.ts";
import { renderNostrCard } from "./channels.nostr.ts";
import { channelEnabled, renderChannelAccountCount } from "./channels.shared.ts";
import { renderSignalCard } from "./channels.signal.ts";
import { renderSlackCard } from "./channels.slack.ts";
import { renderTelegramCard } from "./channels.telegram.ts";
import type { ChannelKey, ChannelsChannelData, ChannelsProps } from "./channels.types.ts";
import { renderWhatsAppCard } from "./channels.whatsapp.ts";

// ── Channel state classification ────────────────────────────────────

type ChannelTileState = "ok" | "setup" | "error" | "disabled";

function classifyChannel(key: ChannelKey, props: ChannelsProps): ChannelTileState {
  const snapshot = props.snapshot;
  const channels = snapshot?.channels as Record<string, unknown> | null;
  if (!channels) {
    return "disabled";
  }
  const status = channels[key] as Record<string, unknown> | undefined;
  if (!status) {
    return "disabled";
  }

  const lastError = typeof status.lastError === "string" ? status.lastError : undefined;
  if (lastError) {
    return "error";
  }

  const connected = typeof status.connected === "boolean" && status.connected;
  const running = typeof status.running === "boolean" && status.running;
  const configured = typeof status.configured === "boolean" && status.configured;
  const accounts = snapshot?.channelAccounts?.[key] ?? [];
  const anyAccountOk = accounts.some((a) => a.connected || a.running);

  if (connected || running || anyAccountOk) {
    return "ok";
  }

  if (configured || channelEnabled(key, props)) {
    return "setup";
  }

  return "disabled";
}

function tileStatusLabel(state: ChannelTileState): string {
  switch (state) {
    case "ok":
      return "Connected";
    case "setup":
      return "Setup";
    case "error":
      return "Error";
    case "disabled":
      return "Off";
  }
}

// ── Main render ─────────────────────────────────────────────────────

export function renderChannels(props: ChannelsProps) {
  const channels = props.snapshot?.channels as Record<string, unknown> | null;
  const channelOrder = resolveChannelOrder(props.snapshot);

  // Classify each backend channel
  const classified = channelOrder.map((key) => ({
    key,
    state: classifyChannel(key, props),
    label: resolveChannelLabel(props.snapshot, key),
  }));

  // Split into sections
  const connected = classified.filter((c) => c.state === "ok");
  const available = classified.filter((c) => c.state === "setup" || c.state === "error");
  const more = classified.filter((c) => c.state === "disabled");

  // Build channel data for expanded view
  const whatsapp = (channels?.whatsapp ?? undefined) as WhatsAppStatus | undefined;
  const telegram = (channels?.telegram ?? undefined) as TelegramStatus | undefined;
  const discord = (channels?.discord ?? null) as DiscordStatus | null;
  const googlechat = (channels?.googlechat ?? null) as GoogleChatStatus | null;
  const slack = (channels?.slack ?? null) as SlackStatus | null;
  const signal = (channels?.signal ?? null) as SignalStatus | null;
  const imessage = (channels?.imessage ?? null) as IMessageStatus | null;
  const nostr = (channels?.nostr ?? null) as NostrStatus | null;
  const channelData: ChannelsChannelData = {
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

  return html`
    ${
      connected.length > 0
        ? html`
          <div class="channel-section-title">Connected</div>
          <div class="channel-grid">
            ${connected.map((c) => renderTile(c.key, c.label, c.state, props))}
          </div>
        `
        : nothing
    }

    ${
      available.length > 0
        ? html`
          <div class="channel-section-title">Available</div>
          <div class="channel-grid">
            ${available.map((c) => renderTile(c.key, c.label, c.state, props))}
          </div>
        `
        : nothing
    }

    ${
      connected.length === 0 && available.length === 0
        ? html`
            <div class="channel-section-title">Channels</div>
            <div class="callout info" style="margin-bottom: 16px">
              No channels connected yet. Click a channel below to get started.
            </div>
          `
        : nothing
    }

    ${
      more.length > 0
        ? html`
          <div class="channel-section-title">More Channels</div>
          <div class="channel-grid">
            ${more.map((c) => renderTile(c.key, c.label, c.state, props))}
          </div>
        `
        : nothing
    }

    <div class="channel-section-title">Coming Soon</div>
    <div class="channel-grid">
      ${COMING_SOON_CHANNELS.map((c) => renderComingSoonTile(c.id, c.label))}
    </div>

    ${props.expandedChannel ? renderExpandedPanel(props, channelData) : nothing}

    <section class="card" style="margin-top: 18px;">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Channel health</div>
          <div class="card-sub">Channel status snapshots from the gateway.</div>
        </div>
        <div class="muted">${props.lastSuccessAt ? formatRelativeTimestamp(props.lastSuccessAt) : "n/a"}</div>
      </div>
      ${
        props.lastError
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.lastError}</div>`
          : nothing
      }
      <pre class="code-block" style="margin-top: 12px;">
${props.snapshot ? JSON.stringify(props.snapshot, null, 2) : "No snapshot yet."}
      </pre>
    </section>
  `;
}

// ── Tile rendering ──────────────────────────────────────────────────

function renderTile(key: ChannelKey, label: string, state: ChannelTileState, props: ChannelsProps) {
  const isSelected = props.expandedChannel === key;
  const stateClass = `channel-tile--${state}`;
  const selectedClass = isSelected ? "channel-tile--selected" : "";

  return html`
    <div
      class="channel-tile ${stateClass} ${selectedClass}"
      @click=${() => props.onChannelSelect(isSelected ? null : key)}
    >
      <div class="channel-tile__icon">${channelIcon(key)}</div>
      <div class="channel-tile__name">${label}</div>
      <div class="channel-tile__status">
        <span class="channel-tile__dot channel-tile__dot--${state}"></span>
        <span>${tileStatusLabel(state)}</span>
      </div>
    </div>
  `;
}

function renderComingSoonTile(id: string, label: string) {
  return html`
    <div class="channel-tile channel-tile--coming">
      <div class="channel-tile__icon">${channelIcon(id)}</div>
      <div class="channel-tile__name">${label}</div>
      <div class="channel-tile__status">
        <span class="channel-tile__dot channel-tile__dot--disabled"></span>
        <span>Soon</span>
      </div>
    </div>
  `;
}

// ── Expanded detail panel ───────────────────────────────────────────

function renderExpandedPanel(props: ChannelsProps, data: ChannelsChannelData) {
  const key = props.expandedChannel;
  if (!key) {
    return nothing;
  }

  return html`
    <div class="channel-expanded">
      ${renderChannel(key, props, data)}
      <div class="channel-expanded__close">
        <button class="btn btn--sm" @click=${() => props.onChannelSelect(null)}>Close</button>
      </div>
    </div>
  `;
}

// ── Channel detail renderers (reused from original) ─────────────────

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

function resolveChannelOrder(snapshot: ChannelsStatusSnapshot | null): ChannelKey[] {
  if (snapshot?.channelMeta?.length) {
    return snapshot.channelMeta.map((entry) => entry.id);
  }
  if (snapshot?.channelOrder?.length) {
    return snapshot.channelOrder;
  }
  return ["whatsapp", "telegram", "discord", "googlechat", "slack", "signal", "imessage", "nostr"];
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

// ── Generic channel card ────────────────────────────────────────────

function renderGenericChannelCard(
  key: ChannelKey,
  props: ChannelsProps,
  channelAccounts: Record<string, ChannelAccountSnapshot[]>,
) {
  const label = resolveChannelLabel(props.snapshot, key);
  const status = props.snapshot?.channels?.[key] as Record<string, unknown> | undefined;
  const configured = typeof status?.configured === "boolean" ? status.configured : undefined;
  const running = typeof status?.running === "boolean" ? status.running : undefined;
  const connected = typeof status?.connected === "boolean" ? status.connected : undefined;
  const lastError = typeof status?.lastError === "string" ? status.lastError : undefined;
  const accounts = channelAccounts[key] ?? [];
  const accountCountLabel = renderChannelAccountCount(key, channelAccounts);

  return html`
    <div class="card">
      <div class="card-title">${label}</div>
      <div class="card-sub">Channel status and configuration.</div>
      ${accountCountLabel}

      ${
        accounts.length > 0
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
          `
      }

      ${
        lastError
          ? html`<div class="callout danger" style="margin-top: 12px;">${lastError}</div>`
          : nothing
      }

      ${renderChannelConfigSection({ channelId: key, props })}
    </div>
  `;
}

const RECENT_ACTIVITY_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

function hasRecentActivity(account: ChannelAccountSnapshot): boolean {
  if (!account.lastInboundAt) {
    return false;
  }
  return Date.now() - account.lastInboundAt < RECENT_ACTIVITY_THRESHOLD_MS;
}

function deriveRunningStatus(account: ChannelAccountSnapshot): "Yes" | "No" | "Active" {
  if (account.running) {
    return "Yes";
  }
  if (hasRecentActivity(account)) {
    return "Active";
  }
  return "No";
}

function deriveConnectedStatus(account: ChannelAccountSnapshot): "Yes" | "No" | "Active" | "n/a" {
  if (account.connected === true) {
    return "Yes";
  }
  if (account.connected === false) {
    return "No";
  }
  if (hasRecentActivity(account)) {
    return "Active";
  }
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
          <span>${account.lastInboundAt ? formatRelativeTimestamp(account.lastInboundAt) : "n/a"}</span>
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
}
