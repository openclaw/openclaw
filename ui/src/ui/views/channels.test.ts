import { describe, expect, it } from "vitest";
import {
  channelEnabled,
  resolveChannelConfigured,
  resolveChannelDisplayState,
} from "./channels.shared.ts";
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
      channelOrder: ["discord"],
      channelLabels: { discord: "Discord" },
      channels: { discord: { configured: false } },
      channelAccounts: {
        discord: [{ accountId: "discord-main", configured: true }],
      },
      channelDefaultAccountId: { discord: "discord-main" },
    });

    expect(resolveChannelConfigured("discord", props)).toBe(false);
    expect(resolveChannelDisplayState("discord", props).configured).toBe(false);
  });

  it("falls back to the default account when the channel summary omits configured", () => {
    const props = createProps({
      ts: Date.now(),
      channelOrder: ["discord"],
      channelLabels: { discord: "Discord" },
      channels: { discord: { running: true } },
      channelAccounts: {
        discord: [
          { accountId: "default", configured: false },
          { accountId: "discord-main", configured: true },
        ],
      },
      channelDefaultAccountId: { discord: "discord-main" },
    });

    const displayState = resolveChannelDisplayState("discord", props);

    expect(resolveChannelConfigured("discord", props)).toBe(true);
    expect(displayState.defaultAccount?.accountId).toBe("discord-main");
    expect(channelEnabled("discord", props)).toBe(true);
  });

  it("falls back to the first account when no default account id is available", () => {
    const props = createProps({
      ts: Date.now(),
      channelOrder: ["slack"],
      channelLabels: { slack: "Slack" },
      channels: { slack: { running: true } },
      channelAccounts: {
        slack: [{ accountId: "workspace-a", configured: true }],
      },
      channelDefaultAccountId: {},
    });

    const displayState = resolveChannelDisplayState("slack", props);

    expect(resolveChannelConfigured("slack", props)).toBe(true);
    expect(displayState.defaultAccount?.accountId).toBe("workspace-a");
  });

  it("keeps disabled channels hidden when neither summary nor accounts are active", () => {
    const props = createProps({
      ts: Date.now(),
      channelOrder: ["signal"],
      channelLabels: { signal: "Signal" },
      channels: { signal: {} },
      channelAccounts: {
        signal: [{ accountId: "default", configured: false, running: false, connected: false }],
      },
      channelDefaultAccountId: { signal: "default" },
    });

    const displayState = resolveChannelDisplayState("signal", props);

    expect(displayState.configured).toBe(false);
    expect(displayState.running).toBeNull();
    expect(displayState.connected).toBeNull();
    expect(channelEnabled("signal", props)).toBe(false);
  });
});
