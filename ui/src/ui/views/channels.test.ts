// Control UI tests cover channels behavior.
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppStatus } from "../types.ts";
import { readExpandedChannelsFromUrl, writeExpandedChannelsToUrl } from "./channels-url.ts";
import {
  channelEnabled,
  resolveChannelConfigured,
  resolveChannelDisplayState,
  resolveChannelDotState,
} from "./channels.shared.ts";
import { renderChannels } from "./channels.ts";
import type { ChannelFilter, ChannelsProps } from "./channels.types.ts";
import { renderWhatsAppCard } from "./channels.whatsapp.ts";

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
    expandedChannelIds: [],
    channelFilter: "all",
    onChannelToggle: () => {},
    onChannelFilterChange: () => {},
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

function createWhatsAppStatus(overrides: Partial<WhatsAppStatus> = {}): WhatsAppStatus {
  return {
    configured: true,
    linked: false,
    running: false,
    connected: false,
    reconnectAttempts: 0,
    ...overrides,
  };
}

function renderWhatsAppButtons(params: {
  linked?: boolean;
  qrDataUrl?: string | null;
  onWhatsAppStart?: ChannelsProps["onWhatsAppStart"];
}) {
  const whatsapp = createWhatsAppStatus({ linked: params.linked === true });
  const props = createProps({
    ts: Date.now(),
    channelOrder: ["whatsapp"],
    channelLabels: { whatsapp: "WhatsApp" },
    channels: { whatsapp },
    channelAccounts: {},
    channelDefaultAccountId: {},
  });
  props.whatsappQrDataUrl = params.qrDataUrl ?? null;
  if (params.onWhatsAppStart) {
    props.onWhatsAppStart = params.onWhatsAppStart;
  }

  const container = document.createElement("div");
  render(renderWhatsAppCard({ props, whatsapp, accountCountLabel: null }), container);
  const buttons = Array.from(container.querySelectorAll("button"));
  return {
    buttons,
    labels: buttons.map((button) => button.textContent?.trim()),
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

describe("WhatsApp card actions", () => {
  it("shows QR as the primary action before WhatsApp is linked", () => {
    const onWhatsAppStart = vi.fn();
    const { buttons, labels } = renderWhatsAppButtons({
      linked: false,
      onWhatsAppStart,
    });

    expect(labels).toEqual(["Save", "Reload", "Show QR", "Logout", "Refresh"]);

    const showQr = buttons.find((button) => button.textContent?.trim() === "Show QR");
    expect(showQr).toBeInstanceOf(HTMLButtonElement);
    showQr!.click();
    expect(onWhatsAppStart).toHaveBeenCalledWith(false);
  });

  it("uses relink as the explicit action after WhatsApp is linked", () => {
    const onWhatsAppStart = vi.fn();
    const { buttons, labels } = renderWhatsAppButtons({
      linked: true,
      onWhatsAppStart,
    });

    expect(labels).toEqual(["Save", "Reload", "Relink", "Logout", "Refresh"]);

    const relink = buttons.find((button) => button.textContent?.trim() === "Relink");
    expect(relink).toBeInstanceOf(HTMLButtonElement);
    relink!.click();
    expect(onWhatsAppStart).toHaveBeenCalledWith(true);
  });

  it("shows wait for scan only while a QR is displayed", () => {
    const { labels } = renderWhatsAppButtons({
      linked: false,
      qrDataUrl: "data:image/png;base64,current-qr",
    });

    expect(labels).toEqual(["Save", "Reload", "Show QR", "Wait for scan", "Logout", "Refresh"]);
  });
});

function createDirectoryProps(overrides: Partial<ChannelsProps> = {}): ChannelsProps {
  const props = createProps({
    ts: Date.now(),
    channelOrder: ["whatsapp", "telegram"],
    channelLabels: { whatsapp: "WhatsApp", telegram: "Telegram" },
    channels: {
      whatsapp: { configured: true, running: true, connected: true },
      telegram: { configured: false },
    },
    channelAccounts: {},
    channelDefaultAccountId: {},
  });
  return { ...props, ...overrides };
}

function renderDirectory(props: ChannelsProps) {
  const container = document.createElement("div");
  render(renderChannels(props), container);
  return container;
}

describe("channels directory", () => {
  it("derives the row status dot from connection state", () => {
    const props = createDirectoryProps();
    expect(resolveChannelDotState("whatsapp", props)).toBe("ok");
    expect(resolveChannelDotState("telegram", props)).toBe("off");

    const erroring = createProps({
      ts: Date.now(),
      channelOrder: ["slack"],
      channelLabels: { slack: "Slack" },
      channels: { slack: { configured: true, lastError: "boom" } },
      channelAccounts: {},
      channelDefaultAccountId: {},
    });
    expect(resolveChannelDotState("slack", erroring)).toBe("warn");

    const accountErroring = createProps({
      ts: Date.now(),
      channelOrder: ["telegram"],
      channelLabels: { telegram: "Telegram" },
      channels: { telegram: { configured: true, running: true } },
      channelAccounts: {
        telegram: [{ accountId: "bot", configured: true, running: true, lastError: "bad token" }],
      },
      channelDefaultAccountId: { telegram: "bot" },
    });
    expect(resolveChannelDotState("telegram", accountErroring)).toBe("warn");
  });

  it("renders one collapsed row per channel and expands only the selected ones", () => {
    const collapsed = renderDirectory(createDirectoryProps());
    expect(collapsed.querySelectorAll(".channel-row").length).toBe(2);
    expect(collapsed.querySelector(".channel-row__body")).toBeNull();

    const expanded = renderDirectory(createDirectoryProps({ expandedChannelIds: ["whatsapp"] }));
    expect(expanded.querySelectorAll(".channel-row--open").length).toBe(1);
    expect(expanded.querySelectorAll(".channel-row__body").length).toBe(1);
  });

  it("filters rows by enabled state", () => {
    const enabled = renderDirectory(createDirectoryProps({ channelFilter: "enabled" }));
    expect(enabled.querySelectorAll(".channel-row").length).toBe(1);
    expect(enabled.textContent).toContain("WhatsApp");

    const disabled = renderDirectory(createDirectoryProps({ channelFilter: "disabled" }));
    expect(disabled.querySelectorAll(".channel-row").length).toBe(1);
    expect(disabled.textContent).toContain("Telegram");
  });

  it("toggles a channel when its header is clicked", () => {
    const onChannelToggle = vi.fn();
    const container = renderDirectory(createDirectoryProps({ onChannelToggle }));
    const headers = container.querySelectorAll<HTMLButtonElement>(".channel-row__header");
    headers[1].click();
    expect(onChannelToggle).toHaveBeenCalledWith("telegram");
  });

  it("switches the active filter when a filter button is clicked", () => {
    const onChannelFilterChange = vi.fn<(filter: ChannelFilter) => void>();
    const container = renderDirectory(createDirectoryProps({ onChannelFilterChange }));
    const buttons = container.querySelectorAll<HTMLButtonElement>(".channel-filter");
    expect(container.querySelector(".channel-directory__filters")?.getAttribute("role")).toBe(
      "group",
    );
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(buttons[0].getAttribute("aria-pressed")).toBe("true");
    expect(buttons[1].textContent).toContain("Enabled");
    expect(buttons[2].textContent).toContain("Disabled");
    buttons[2].click();
    expect(onChannelFilterChange).toHaveBeenCalledWith("disabled");
  });

  it("keeps the raw snapshot behind a collapsed disclosure", () => {
    const container = renderDirectory(createDirectoryProps());
    const details = container.querySelector("details.channel-raw");
    expect(details).toBeInstanceOf(HTMLDetailsElement);
    expect((details as HTMLDetailsElement).open).toBe(false);
  });
});

describe("channels deep-link url", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/channels");
  });

  it("round-trips the expanded channel set through the query string", () => {
    writeExpandedChannelsToUrl(["telegram", "whatsapp"]);
    expect(new URL(window.location.href).searchParams.get("channels")).toBe("telegram,whatsapp");
    expect(readExpandedChannelsFromUrl()).toEqual(["telegram", "whatsapp"]);
  });

  it("clears the query param when no channels are expanded", () => {
    writeExpandedChannelsToUrl(["telegram"]);
    writeExpandedChannelsToUrl([]);
    expect(new URL(window.location.href).searchParams.has("channels")).toBe(false);
    expect(readExpandedChannelsFromUrl()).toEqual([]);
  });
});
