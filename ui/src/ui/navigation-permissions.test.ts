import { describe, expect, it } from "vitest";
import {
  canAccessTab,
  firstPermittedTab,
  permittedSettingsTabs,
  permittedTabGroups,
  permittedTabs,
} from "./navigation-permissions.ts";

describe("Control UI navigation permissions", () => {
  it("allows every tab before the gateway auth context is known", () => {
    expect(permittedTabs(null)).toContain("config");
    expect(canAccessTab("debug", null)).toBe(true);
  });

  it("limits read-only operators to read surfaces", () => {
    const auth = { role: "operator", scopes: ["operator.read"] };

    expect(canAccessTab("chat", auth)).toBe(true);
    expect(canAccessTab("sessions", auth)).toBe(true);
    expect(canAccessTab("cron", auth)).toBe(true);
    expect(canAccessTab("config", auth)).toBe(false);
    expect(canAccessTab("debug", auth)).toBe(false);
    expect(canAccessTab("nodes", auth)).toBe(false);
    expect(permittedSettingsTabs(auth)).toEqual(["channels", "logs"]);
  });

  it("treats write scope as read-capable for navigation", () => {
    const auth = { role: "operator", scopes: ["operator.write"] };

    expect(canAccessTab("overview", auth)).toBe(true);
    expect(canAccessTab("usage", auth)).toBe(true);
    expect(canAccessTab("config", auth)).toBe(false);
  });

  it("allows pairing operators to see node management without full admin", () => {
    const auth = { role: "operator", scopes: ["operator.pairing"] };

    expect(canAccessTab("nodes", auth)).toBe(true);
    expect(canAccessTab("config", auth)).toBe(false);
    expect(firstPermittedTab(auth)).toBe("nodes");
  });

  it("allows admin operators to see all sidebar and settings sections", () => {
    const auth = { role: "operator", scopes: ["operator.admin"] };

    expect(permittedTabGroups(auth).map((group) => [group.label, group.tabs])).toEqual([
      ["chat", ["chat"]],
      ["control", ["overview", "instances", "sessions", "usage", "cron"]],
      ["agent", ["agents", "skills", "nodes", "dreams"]],
      ["settings", ["config"]],
    ]);
    expect(permittedSettingsTabs(auth)).toEqual([
      "config",
      "channels",
      "communications",
      "appearance",
      "automation",
      "infrastructure",
      "aiAgents",
      "debug",
      "logs",
    ]);
  });

  it("denies non-operator roles", () => {
    const auth = { role: "node", scopes: ["operator.admin"] };

    expect(permittedTabs(auth)).toEqual([]);
    expect(firstPermittedTab(auth)).toBeNull();
  });
});
