import { describe, expect, it } from "vitest";
import { TAB_GROUPS, tabFromPath } from "./navigation.ts";

describe("TAB_GROUPS", () => {
  it("does not expose unfinished settings slices in the sidebar", () => {
    const settings = TAB_GROUPS.find((group) => group.label === "settings");
    expect(settings?.tabs).toEqual([
      "config",
      "communications",
      "appearance",
      "automation",
      "infrastructure",
      "aiAgents",
      "debug",
      "logs",
    ]);
  });

  it("groups operational dashboards together", () => {
    const dashboards = TAB_GROUPS.find((group) => group.label === "dashboards");
    expect(dashboards?.tabs).toEqual([
      "appStudio",
      "musicStudio",
      "snesStudio",
      "bookWriter",
      "kalshi",
      "patternLab",
    ]);

    const control = TAB_GROUPS.find((group) => group.label === "control");
    expect(control?.tabs).not.toContain("kalshi");
    expect(control?.tabs).not.toContain("musicStudio");
    expect(control?.tabs).not.toContain("snesStudio");
  });

  it("routes every published settings slice", () => {
    expect(tabFromPath("/communications")).toBe("communications");
    expect(tabFromPath("/appearance")).toBe("appearance");
    expect(tabFromPath("/automation")).toBe("automation");
    expect(tabFromPath("/infrastructure")).toBe("infrastructure");
    expect(tabFromPath("/ai-agents")).toBe("aiAgents");
    expect(tabFromPath("/config")).toBe("config");
    expect(tabFromPath("/app-studio")).toBe("appStudio");
    expect(tabFromPath("/music-studio")).toBe("musicStudio");
    expect(tabFromPath("/snes-studio")).toBe("snesStudio");
    expect(tabFromPath("/book-writer")).toBe("bookWriter");
    expect(tabFromPath("/pattern-lab")).toBe("patternLab");
  });
});
