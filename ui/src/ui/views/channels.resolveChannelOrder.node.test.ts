import { describe, expect, it } from "vitest";
import type { ChannelsStatusSnapshot } from "../types.ts";
import { BUILTIN_CHANNEL_ORDER, resolveChannelOrder } from "./channels.ts";

describe("resolveChannelOrder", () => {
  it("includes built-in channels even when snapshot.channelMeta only contains custom channels", () => {
    const snapshot = {
      ts: Date.now(),
      channelOrder: [],
      channelLabels: {},
      channels: {},
      channelAccounts: {},
      channelDefaultAccountId: {},
      channelMeta: [
        {
          id: "icenter",
          label: "iCenter",
          detailLabel: "iCenter",
        },
      ],
    };

    expect(resolveChannelOrder(snapshot as unknown as ChannelsStatusSnapshot)).toEqual([
      "icenter",
      ...BUILTIN_CHANNEL_ORDER,
    ]);
  });

  it("preserves snapshot.channelOrder and appends missing built-ins after", () => {
    const snapshot = {
      ts: Date.now(),
      channelOrder: ["slack", "icenter", "telegram"],
      channelLabels: {},
      channels: {},
      channelAccounts: {},
      channelDefaultAccountId: {},
    };

    expect(resolveChannelOrder(snapshot as unknown as ChannelsStatusSnapshot)).toEqual([
      "slack",
      "icenter",
      "telegram",
      // missing built-ins appended in default order
      "whatsapp",
      "discord",
      "googlechat",
      "signal",
      "imessage",
      "nostr",
    ]);
  });

  it("falls back to built-in channels when there is no snapshot", () => {
    expect(resolveChannelOrder(null)).toEqual(BUILTIN_CHANNEL_ORDER);
  });
});
