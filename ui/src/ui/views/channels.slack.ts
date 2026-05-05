import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../format.ts";
import type { ChannelAccountSnapshot, SlackStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import {
  formatNullableBoolean,
  renderSingleAccountChannelCard,
  resolveChannelConfigured,
} from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";

export function renderSlackCard(params: {
  props: ChannelsProps;
  slack?: SlackStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, slack, accountCountLabel } = params;
  const configured = resolveChannelConfigured("slack", props);
  const slackAccounts = props.snapshot?.channelAccounts?.slack ?? [];
  const attention = resolveSlackAttentionItems(slack, slackAccounts);

  return renderSingleAccountChannelCard({
    title: "Slack",
    subtitle: "Socket mode status and channel configuration.",
    accountCountLabel,
    statusRows: [
      { label: t("common.configured"), value: formatNullableBoolean(configured) },
      { label: t("common.running"), value: slack?.running ? t("common.yes") : t("common.no") },
      {
        label: t("common.lastStart"),
        value: slack?.lastStartAt ? formatRelativeTimestamp(slack.lastStartAt) : t("common.na"),
      },
      {
        label: t("common.lastProbe"),
        value: slack?.lastProbeAt ? formatRelativeTimestamp(slack.lastProbeAt) : t("common.na"),
      },
      {
        label: t("common.lastActivity"),
        value: formatSlackActivityAt(slack, slackAccounts),
      },
      {
        label: t("common.lastReadback"),
        value: formatSlackReadbackAt(slack, slackAccounts),
      },
    ],
    lastError: slack?.lastError,
    secondaryCallout: slack?.probe
      ? html`<div class="callout" style="margin-top: 12px;">
          ${slack.probe.ok ? t("common.probeOk") : t("common.probeFailed")} ·
          ${slack.probe.status ?? ""} ${slack.probe.error ?? ""}
        </div>`
      : nothing,
    extraContent: attention.length
      ? html`
          <div class="stack" style="margin-top: 12px;">
            ${attention.map((item) => html`<div class="callout warn">${item}</div>`)}
          </div>
        `
      : nothing,
    configSection: renderChannelConfigSection({ channelId: "slack", props }),
    footer: html`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${() => props.onRefresh(true)}>${t("common.probe")}</button>
    </div>`,
  });
}

function newestTimestamp(values: Array<number | null | undefined>): number | null {
  const timestamps = values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  return timestamps.length ? Math.max(...timestamps) : null;
}

function formatSlackActivityAt(
  slack: SlackStatus | null | undefined,
  accounts: ChannelAccountSnapshot[],
): string {
  const at = newestTimestamp([
    slack?.lastTransportActivityAt,
    slack?.lastConnectedAt,
    ...accounts.flatMap((account) => [account.lastTransportActivityAt, account.lastConnectedAt]),
  ]);
  return at ? formatRelativeTimestamp(at) : t("common.na");
}

function formatSlackReadbackAt(
  slack: SlackStatus | null | undefined,
  accounts: ChannelAccountSnapshot[],
): string {
  const at = newestTimestamp([
    slack?.lastReadbackAt,
    ...accounts.map((account) => account.lastReadbackAt),
  ]);
  return at ? formatRelativeTimestamp(at) : t("common.na");
}

export function resolveSlackAttentionItems(
  slack: SlackStatus | null | undefined,
  accounts: ChannelAccountSnapshot[],
  now = Date.now(),
): string[] {
  const items: string[] = [];
  const configured = slack?.configured === true || accounts.some((account) => account.configured);
  const running = slack?.running === true || accounts.some((account) => account.running);
  const connected = slack?.connected === true || accounts.some((account) => account.connected);
  const hasSocketModeRuntime = resolveHasSocketModeRuntime(slack, accounts);
  const healthState =
    slack?.healthState ?? accounts.find((account) => account.healthState)?.healthState ?? null;
  const readbackState =
    slack?.readbackState ??
    accounts.find((account) => account.readbackState)?.readbackState ??
    null;
  const readbackError =
    slack?.lastReadbackError ??
    accounts.find((account) => account.lastReadbackError)?.lastReadbackError ??
    null;
  const missingReadbackScopes = [
    ...(slack?.readbackMissingScopes ?? []),
    ...accounts.flatMap((account) => account.readbackMissingScopes ?? []),
  ];
  const lastTransportActivityAt = newestTimestamp([
    slack?.lastTransportActivityAt,
    ...accounts.map((account) => account.lastTransportActivityAt),
  ]);

  if (configured && running && !connected && hasSocketModeRuntime) {
    items.push(t("channels.slack.attention.noSocketModeReadback"));
  }
  if (healthState && !["healthy", "connected"].includes(healthState)) {
    items.push(t("channels.slack.attention.healthState", { state: healthState }));
  }
  if (connected && lastTransportActivityAt && now - lastTransportActivityAt > 10 * 60 * 1000) {
    items.push(t("channels.slack.attention.staleTransport"));
  }
  if (readbackState && readbackState !== "ok") {
    items.push(
      readbackError
        ? t("channels.slack.attention.readbackWithError", {
            state: readbackState,
            error: readbackError,
          })
        : t("channels.slack.attention.readbackMissingScopes", { state: readbackState }),
    );
  }
  if (missingReadbackScopes.length > 0) {
    items.push(
      t("channels.slack.attention.missingScopes", {
        scopes: missingReadbackScopes.join(", "),
      }),
    );
  }

  return Array.from(new Set(items));
}

function resolveHasSocketModeRuntime(
  slack: SlackStatus | null | undefined,
  accounts: ChannelAccountSnapshot[],
): boolean {
  const modes = [slack?.mode, ...accounts.map((account) => account.mode)]
    .filter((mode): mode is string => typeof mode === "string")
    .map((mode) => mode.trim().toLowerCase())
    .filter(Boolean);
  if (modes.length === 0) {
    return true;
  }
  return modes.some((mode) => mode !== "http");
}
