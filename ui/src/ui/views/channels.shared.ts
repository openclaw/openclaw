// Control UI view renders channels.shared screen content.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { ChannelAccountSnapshot, ChannelsStatusSnapshot } from "../types.ts";
import type { ChannelKey, ChannelsProps } from "./channels.types.ts";

type ChannelDisplayState = {
  configured: boolean | null;
  running: boolean | null;
  connected: boolean | null;
  defaultAccount: ChannelAccountSnapshot | null;
  hasAnyActiveAccount: boolean;
  status: Record<string, unknown> | undefined;
};

type ChannelStatusRow = {
  label: string;
  value: unknown;
};

function resolveChannelStatus(
  key: ChannelKey,
  props: ChannelsProps,
): Record<string, unknown> | undefined {
  const channels = props.snapshot?.channels as Record<string, unknown> | null;
  return channels?.[key] as Record<string, unknown> | undefined;
}

export function resolveDefaultChannelAccount(
  key: ChannelKey,
  props: ChannelsProps,
): ChannelAccountSnapshot | null {
  const accounts = props.snapshot?.channelAccounts?.[key] ?? [];
  const defaultAccountId = props.snapshot?.channelDefaultAccountId?.[key];
  return (
    (defaultAccountId
      ? accounts.find((account) => account.accountId === defaultAccountId)
      : undefined) ??
    accounts[0] ??
    null
  );
}

export function resolveChannelDisplayState(
  key: ChannelKey,
  props: ChannelsProps,
): ChannelDisplayState {
  const status = resolveChannelStatus(key, props);
  const accounts = props.snapshot?.channelAccounts?.[key] ?? [];
  const defaultAccount = resolveDefaultChannelAccount(key, props);
  const configured =
    typeof status?.configured === "boolean"
      ? status.configured
      : typeof defaultAccount?.configured === "boolean"
        ? defaultAccount.configured
        : null;
  const running = typeof status?.running === "boolean" ? status.running : null;
  const connected = typeof status?.connected === "boolean" ? status.connected : null;
  const hasAnyActiveAccount = accounts.some(
    (account) => account.configured || account.running || account.connected,
  );

  return {
    configured,
    running,
    connected,
    defaultAccount,
    hasAnyActiveAccount,
    status,
  };
}

export function channelEnabled(key: ChannelKey, props: ChannelsProps) {
  if (!props.snapshot) {
    return false;
  }
  const displayState = resolveChannelDisplayState(key, props);
  return (
    displayState.configured === true ||
    displayState.running === true ||
    displayState.connected === true ||
    displayState.hasAnyActiveAccount
  );
}

export function resolveChannelConfigured(key: ChannelKey, props: ChannelsProps): boolean | null {
  return resolveChannelDisplayState(key, props).configured;
}

export function formatNullableBoolean(value: boolean | null): string {
  if (value == null) {
    return t("common.na");
  }
  return value ? t("common.yes") : t("common.no");
}

// Body-only channel card: the directory row owns identity (logo + name), so this
// renders just the status rows, callouts, config form, and per-channel footer
// that live inside an expanded row.
export function renderSingleAccountChannelCard(params: {
  accountCountLabel: unknown;
  statusRows: readonly ChannelStatusRow[];
  lastError?: string | null;
  secondaryCallout?: unknown;
  extraContent?: unknown;
  configSection: unknown;
  footer?: unknown;
}) {
  return html`
    ${params.accountCountLabel}
    <div class="status-list">
      ${params.statusRows.map(
        (row) => html`
          <div>
            <span class="label">${row.label}</span>
            <span>${row.value}</span>
          </div>
        `,
      )}
    </div>
    ${params.lastError
      ? html`<div class="callout danger" style="margin-top: 12px;">${params.lastError}</div>`
      : nothing}
    ${params.secondaryCallout ?? nothing} ${params.extraContent ?? nothing} ${params.configSection}
    ${params.footer ?? nothing}
  `;
}

// Display label + descriptive subtitle for the directory row of each built-in
// channel. Unknown plugin channels fall back to the snapshot label + generic copy.
const CHANNEL_DIRECTORY_META: Record<string, { labelKey: string; subtitleKey: string }> = {
  whatsapp: {
    labelKey: "channels.directory.labels.whatsapp",
    subtitleKey: "channels.directory.subtitles.whatsapp",
  },
  telegram: {
    labelKey: "channels.directory.labels.telegram",
    subtitleKey: "channels.directory.subtitles.telegram",
  },
  discord: {
    labelKey: "channels.directory.labels.discord",
    subtitleKey: "channels.directory.subtitles.discord",
  },
  slack: {
    labelKey: "channels.directory.labels.slack",
    subtitleKey: "channels.directory.subtitles.slack",
  },
  signal: {
    labelKey: "channels.directory.labels.signal",
    subtitleKey: "channels.directory.subtitles.signal",
  },
  imessage: {
    labelKey: "channels.directory.labels.imessage",
    subtitleKey: "channels.directory.subtitles.imessage",
  },
  googlechat: {
    labelKey: "channels.directory.labels.googlechat",
    subtitleKey: "channels.directory.subtitles.googlechat",
  },
  nostr: {
    labelKey: "channels.directory.labels.nostr",
    subtitleKey: "channels.directory.subtitles.nostr",
  },
};

function resolveSnapshotLabel(snapshot: ChannelsStatusSnapshot | null, key: ChannelKey): string {
  const meta = snapshot?.channelMeta?.find((entry) => entry.id === key);
  return meta?.label ?? snapshot?.channelLabels?.[key] ?? key;
}

export function resolveChannelDirectoryName(
  snapshot: ChannelsStatusSnapshot | null,
  key: ChannelKey,
): string {
  const meta = CHANNEL_DIRECTORY_META[key];
  return meta ? t(meta.labelKey) : resolveSnapshotLabel(snapshot, key);
}

export function resolveChannelDirectorySubtitle(key: ChannelKey): string {
  const meta = CHANNEL_DIRECTORY_META[key];
  return meta ? t(meta.subtitleKey) : t("channels.generic.subtitle");
}

export type ChannelDotState = "ok" | "warn" | "off";

function hasAccountLastError(accounts: readonly ChannelAccountSnapshot[]): boolean {
  return accounts.some(
    (account) => typeof account.lastError === "string" && account.lastError.trim().length > 0,
  );
}

// Row status dot: off = not enabled; ok = connected/running/active account;
// warn = enabled but reporting an error or not yet connected (needs attention).
export function resolveChannelDotState(key: ChannelKey, props: ChannelsProps): ChannelDotState {
  if (!channelEnabled(key, props)) {
    return "off";
  }
  const displayState = resolveChannelDisplayState(key, props);
  const lastError =
    typeof displayState.status?.lastError === "string" ? displayState.status.lastError.trim() : "";
  if (lastError || hasAccountLastError(props.snapshot?.channelAccounts?.[key] ?? [])) {
    return "warn";
  }
  if (
    displayState.connected === true ||
    displayState.running === true ||
    displayState.hasAnyActiveAccount
  ) {
    return "ok";
  }
  return "warn";
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
  if (count < 2) {
    return nothing;
  }
  return html`<div class="account-count">Accounts (${count})</div>`;
}
