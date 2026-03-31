import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";

type NavigationModule = typeof import("./navigation.ts");

describe("TAB_GROUPS", () => {
  let navigation: NavigationModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    navigation = await import("./navigation.ts");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not expose unfinished settings slices in the sidebar", () => {
    const settings = navigation.TAB_GROUPS.find((group) => group.label === "settings");
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

  it("routes every published settings slice", () => {
    expect(navigation.tabFromPath("/communications")).toBe("communications");
    expect(navigation.tabFromPath("/appearance")).toBe("appearance");
    expect(navigation.tabFromPath("/automation")).toBe("automation");
    expect(navigation.tabFromPath("/infrastructure")).toBe("infrastructure");
    expect(navigation.tabFromPath("/ai-agents")).toBe("aiAgents");
    expect(navigation.tabFromPath("/config")).toBe("config");
  });
});
