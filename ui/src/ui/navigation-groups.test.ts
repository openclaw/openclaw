import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type NavigationModule = typeof import("./navigation.ts");

function createStorageMock(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

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
    expect(settings?.tabs).toEqual(["config", "debug", "logs"]);
  });

  it("does not route directly into unfinished settings slices", () => {
    expect(navigation.tabFromPath("/communications")).toBeNull();
    expect(navigation.tabFromPath("/appearance")).toBeNull();
    expect(navigation.tabFromPath("/automation")).toBeNull();
    expect(navigation.tabFromPath("/infrastructure")).toBeNull();
    expect(navigation.tabFromPath("/ai-agents")).toBeNull();
    expect(navigation.tabFromPath("/config")).toBe("config");
  });
});
