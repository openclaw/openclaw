import { describe, expect, it } from "vitest";
import {
  channelEnabled,
  resolveChannelConfigured,
  resolveChannelDisplayState,
} from "./channels.shared.ts";
import { resolveSlackAttentionItems } from "./channels.slack.ts";
import { resolveChannelHealthSummary } from "./channels.ts";
import type { ChannelsProps } from "./channels.types.ts";

function createProps(snapshot: ChannelsProps["snapshot"]): ChannelsProps {
  return {
    connected: true,
    loading: false,
    snapshot,
    lastError: null,
    lastSuccessAt: null,
    whatsappMessage: null,
    whatsappQrDataUrl: null,
    whatsappConnected: null,
    whatsappBusy: false,
    configSchema: null,
    configSchemaLoading: false,
    configForm: null,
    configUiHints: {},
    configSaving: false,
    configFormDirty: false,
    nostrProfileFormState: null,
    nostrProfileAccountId: null,
    onRefresh: () => {},
    onWhatsAppStart: () => {},
    onWhatsAppWait: () => {},
    onWhatsAppLogout: () => {},
    onConfigPatch: () => {},
    onConfigSave: () => {},
    onConfigReload: () => {},
    onNostrProfileEdit: () => {},
    onNostrProfileCancel: () => {},
    onNostrProfileFieldChange: () => {},
    onNostrProfileSave: () => {},
    onNostrProfileImport: () => {},
    onNostrProfileToggleAdvanced: () => {},
  };
}

describe("channel display selectors", () => {
  it("returns the channel summary configured flag when present", () => {
    const props = createProps({
      ts: Date.now(),
      channelOrder: ["guildchat"],
      channelLabels: { guildchat: "Guild Chat" },
      channels: { guildchat: { configured: false } },
      channelAccounts: {
        guildchat: [{ accountId: "guild-main", configured: true }],
      },
      channelDefaultAccountId: { guildchat: "guild-main" },
    });

    expect(resolveChannelConfigured("guildchat", props)).toBe(false);
    expect(resolveChannelDisplayState("guildchat", props).configured).toBe(false);
  });

  it("falls back to the default account when the channel summary omits configured", () => {
    const props = createProps({
      ts: Date.now(),
      channelOrder: ["guildchat"],
      channelLabels: { guildchat: "Guild Chat" },
      channels: { guildchat: { running: true } },
      channelAccounts: {
        guildchat: [
          { accountId: "default", configured: false },
          { accountId: "guild-main", configured: true },
        ],
      },
      channelDefaultAccountId: { guildchat: "guild-main" },
    });

    const displayState = resolveChannelDisplayState("guildchat", props);

    expect(resolveChannelConfigured("guildchat", props)).toBe(true);
    expect(displayState.defaultAccount?.accountId).toBe("guild-main");
    expect(channelEnabled("guildchat", props)).toBe(true);
  });

  it("falls back to the first account when no default account id is available", () => {
    const props = createProps({
      ts: Date.now(),
      channelOrder: ["workspace"],
      channelLabels: { workspace: "Workspace" },
      channels: { workspace: { running: true } },
      channelAccounts: {
        workspace: [{ accountId: "workspace-a", configured: true }],
      },
      channelDefaultAccountId: {},
    });

    const displayState = resolveChannelDisplayState("workspace", props);

    expect(resolveChannelConfigured("workspace", props)).toBe(true);
    expect(displayState.defaultAccount?.accountId).toBe("workspace-a");
  });

  it("keeps disabled channels hidden when neither summary nor accounts are active", () => {
    const props = createProps({
      ts: Date.now(),
      channelOrder: ["quietchat"],
      channelLabels: { quietchat: "Quiet Chat" },
      channels: { quietchat: {} },
      channelAccounts: {
        quietchat: [{ accountId: "default", configured: false, running: false, connected: false }],
      },
      channelDefaultAccountId: { quietchat: "default" },
    });

    const displayState = resolveChannelDisplayState("quietchat", props);

    expect(displayState.configured).toBe(false);
    expect(displayState.running).toBeNull();
    expect(displayState.connected).toBeNull();
    expect(channelEnabled("quietchat", props)).toBe(false);
  });
});

describe("channel health summary", () => {
  it("does not warn when a generic running channel omits connection state", () => {
    expect(
      resolveChannelHealthSummary({
        ts: 1_000,
        channelOrder: ["guildchat"],
        channelLabels: { guildchat: "Guild Chat" },
        channels: { guildchat: { configured: true, running: true } },
        channelAccounts: {
          guildchat: [{ accountId: "guild-main", configured: true, running: true }],
        },
        channelDefaultAccountId: { guildchat: "guild-main" },
      }),
    ).toEqual({
      configured: 1,
      running: 1,
      connected: 0,
      warnings: [],
    });
  });

  it("promotes connection, health, and stale account states", () => {
    expect(
      resolveChannelHealthSummary(
        {
          ts: 1_000,
          channelOrder: ["slack", "discord"],
          channelLabels: { slack: "Slack", discord: "Discord" },
          channels: {
            slack: { configured: true, running: true, connected: false, healthState: "stale" },
            discord: { configured: true, running: true, connected: true },
          },
          channelAccounts: {
            slack: [
              {
                accountId: "workspace-a",
                configured: true,
                running: true,
                connected: false,
                lastTransportActivityAt: 1_000,
                readbackState: "mismatch",
                lastReadbackError: "history scope missing",
              },
            ],
            discord: [{ accountId: "guild-a", configured: true, running: true, connected: true }],
          },
          channelDefaultAccountId: { slack: "workspace-a", discord: "guild-a" },
        },
        1_000 + 11 * 60 * 1000,
      ),
    ).toEqual({
      configured: 2,
      running: 2,
      connected: 1,
      warnings: [
        "Slack is running but no active connection/readback is reported.",
        "Slack health is stale.",
        "Slack (workspace-a) readback is mismatch: history scope missing.",
        "Slack (workspace-a) is running but disconnected.",
        "Slack (workspace-a) activity is stale.",
      ],
    });
  });
});

describe("Slack channel attention items", () => {
  it("flags running Slack accounts without readback connectivity", () => {
    expect(
      resolveSlackAttentionItems(
        {
          configured: true,
          running: true,
          connected: false,
          healthState: "disconnected",
        },
        [],
        1_000_000,
      ),
    ).toEqual([
      "Slack Socket Mode is running, but no active readback connection is reported.",
      "Slack health is disconnected; inbound history/readback may be stale.",
    ]);
  });

  it("does not show Socket Mode connectivity warnings for HTTP-mode Slack accounts", () => {
    expect(
      resolveSlackAttentionItems(
        {
          configured: true,
          running: true,
          connected: false,
          healthState: "disconnected",
        },
        [{ accountId: "http-workspace", configured: true, running: true, mode: "http" }],
        1_000_000,
      ),
    ).toEqual(["Slack health is disconnected; inbound history/readback may be stale."]);
  });

  it("flags Slack readback mismatches", () => {
    expect(
      resolveSlackAttentionItems(
        {
          configured: true,
          running: true,
          connected: true,
          readbackState: "mismatch",
          lastReadbackError: "history scope missing",
        },
        [],
        1_000_000,
      ),
    ).toEqual(["Slack message readback is mismatch: history scope missing."]);
  });

  it("flags stale Slack transport activity", () => {
    expect(
      resolveSlackAttentionItems(
        {
          configured: true,
          running: true,
          connected: true,
          lastTransportActivityAt: 1_000,
        },
        [],
        1_000 + 11 * 60 * 1000,
      ),
    ).toEqual(["Slack transport activity is stale; verify Socket Mode and history scopes."]);
  });
});
