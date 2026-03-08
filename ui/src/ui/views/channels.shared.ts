import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatDurationHuman, formatRelativeTimestamp } from "../format.ts";
import type { ChannelAccountSnapshot } from "../types.ts";
import type { ChannelKey, ChannelsProps } from "./channels.types.ts";

export function channelEnabled(key: ChannelKey, props: ChannelsProps) {
  const snapshot = props.snapshot;
  const channels = snapshot?.channels as Record<string, unknown> | null;
  if (!snapshot || !channels) {
    return false;
  }
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
  if (count < 2) {
    return nothing;
  }
  return html`<div class="account-count">${t("channelsView.accountCount", { count: String(count) })}</div>`;
}

export function formatBool(value: boolean | null | undefined, allowNa = false): string {
  if (typeof value === "boolean") {
    return value ? t("common.yes") : t("common.no");
  }
  return allowNa ? t("common.na") : t("common.no");
}

export function formatRelativeOrNa(value: number | null | undefined): string {
  return value != null ? formatRelativeTimestamp(value) : t("common.na");
}

export function formatDurationOrNa(value: number | null | undefined): string {
  return value != null ? formatDurationHuman(value) : t("common.na");
}

export function formatProbeResult(ok: boolean): string {
  return t("channelsView.probe.result", {
    status: ok ? t("channelsView.probe.ok") : t("channelsView.probe.failed"),
  });
}
