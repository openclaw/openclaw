import { describe, expect, it } from "vitest";
import {
  TAB_GROUPS,
  iconForTab,
  inferBasePathFromPathname,
  normalizeBasePath,
  normalizePath,
  pathForTab,
  subtitleForTab,
  tabFromPath,
  titleForTab,
  type Tab,
} from "./navigation.ts";

/** All valid tab identifiers derived from TAB_GROUPS */
const ALL_TABS: Tab[] = TAB_GROUPS.flatMap((group) => group.tabs) as Tab[];

describe("iconForTab", () => {
  it("returns a non-empty string for every tab", () => {
    for (const tab of ALL_TABS) {
      const icon = iconForTab(tab);
      expect(icon).toBeTruthy();
      expect(typeof icon).toBe("string");
      expect(icon.length).toBeGreaterThan(0);
    }
  });

  it("returns stable icons for known tabs", () => {
    const cases = [
      { tab: "chat", icon: "messageSquare" },
      { tab: "overview", icon: "barChart" },
      { tab: "channels", icon: "link" },
      { tab: "instances", icon: "radio" },
      { tab: "sessions", icon: "fileText" },
      { tab: "cron", icon: "loader" },
      { tab: "skills", icon: "zap" },
      { tab: "nodes", icon: "monitor" },
      { tab: "config", icon: "settings" },
      { tab: "communications", icon: "send" },
      { tab: "appearance", icon: "spark" },
      { tab: "automation", icon: "terminal" },
      { tab: "infrastructure", icon: "globe" },
      { tab: "aiAgents", icon: "brain" },
      { tab: "debug", icon: "bug" },
      { tab: "logs", icon: "scrollText" },
    ] as const;
    for (const testCase of cases) {
      expect(iconForTab(testCase.tab), testCase.tab).toBe(testCase.icon);
    }
  });

  it("returns a fallback icon for unknown tab", () => {
    // TypeScript won't allow this normally, but runtime could receive unexpected values
    const unknownTab = "unknown" as Tab;
    expect(iconForTab(unknownTab)).toBe("folder");
  });
});

describe("titleForTab", () => {
  it("returns a non-empty string for every tab", () => {
    for (const tab of ALL_TABS) {
      const title = titleForTab(tab);
      expect(title).toBeTruthy();
      expect(typeof title).toBe("string");
    }
  });

  it("returns expected titles", () => {
    const cases = [
      { tab: "chat", title: "Chat" },
      { tab: "overview", title: "Overview" },
      { tab: "cron", title: "Cron Jobs" },
    ] as const;
    for (const testCase of cases) {
      expect(titleForTab(testCase.tab), testCase.tab).toBe(testCase.title);
    }
  });
});

describe("subtitleForTab", () => {
  it("returns a string for every tab", () => {
    for (const tab of ALL_TABS) {
      const subtitle = subtitleForTab(tab);
      expect(typeof subtitle).toBe("string");
    }
  });

  it("returns descriptive subtitles", () => {
    expect(subtitleForTab("chat")).toContain("chat");
    expect(subtitleForTab("config")).toContain("openclaw.json");
  });
});

describe("normalizeBasePath", () => {
  it("normalizes base-path variants", () => {
    const cases = [
      { input: "", expected: "" },
      { input: "ui", expected: "/ui" },
      { input: "/ui/", expected: "/ui" },
      { input: "/", expected: "" },
      { input: "/apps/openclaw", expected: "/apps/openclaw" },
    ] as const;
    for (const testCase of cases) {
      expect(normalizeBasePath(testCase.input), testCase.input).toBe(testCase.expected);
    }
  });
});

describe("normalizePath", () => {
  it("normalizes paths", () => {
    const cases = [
      { input: "", expected: "/" },
      { input: "chat", expected: "/chat" },
      { input: "/chat/", expected: "/chat" },
      { input: "/", expected: "/" },
    ] as const;
    for (const testCase of cases) {
      expect(normalizePath(testCase.input), testCase.input).toBe(testCase.expected);
    }
  });
});

describe("pathForTab", () => {
  it("builds tab paths with optional bases", () => {
    const cases = [
      { tab: "chat", base: undefined, expected: "/chat" },
      { tab: "overview", base: undefined, expected: "/overview" },
      { tab: "chat", base: "/ui", expected: "/ui/chat" },
      { tab: "sessions", base: "/apps/openclaw", expected: "/apps/openclaw/sessions" },
    ] as const;
    for (const testCase of cases) {
      expect(
        pathForTab(testCase.tab, testCase.base),
        `${testCase.tab}:${testCase.base ?? "root"}`,
      ).toBe(testCase.expected);
    }
  });
});

describe("tabFromPath", () => {
  it("resolves tabs from path variants", () => {
    const cases = [
      { path: "/chat", base: undefined, expected: "chat" },
      { path: "/overview", base: undefined, expected: "overview" },
      { path: "/sessions", base: undefined, expected: "sessions" },
      { path: "/", base: undefined, expected: "chat" },
      { path: "/ui/chat", base: "/ui", expected: "chat" },
      { path: "/apps/openclaw/sessions", base: "/apps/openclaw", expected: "sessions" },
      { path: "/unknown", base: undefined, expected: null },
      { path: "/CHAT", base: undefined, expected: "chat" },
      { path: "/Overview", base: undefined, expected: "overview" },
    ] as const;
    for (const testCase of cases) {
      expect(
        tabFromPath(testCase.path, testCase.base),
        `${testCase.path}:${testCase.base ?? "root"}`,
      ).toBe(testCase.expected);
    }
  });
});

describe("inferBasePathFromPathname", () => {
  it("infers base-path variants from pathname", () => {
    const cases = [
      { path: "/", expected: "" },
      { path: "/chat", expected: "" },
      { path: "/overview", expected: "" },
      { path: "/ui/chat", expected: "/ui" },
      { path: "/apps/openclaw/sessions", expected: "/apps/openclaw" },
      { path: "/index.html", expected: "" },
      { path: "/ui/index.html", expected: "/ui" },
    ] as const;
    for (const testCase of cases) {
      expect(inferBasePathFromPathname(testCase.path), testCase.path).toBe(testCase.expected);
    }
  });
});

describe("TAB_GROUPS", () => {
  it("contains all expected groups", () => {
    const labels = TAB_GROUPS.map((g) => g.label.toLowerCase());
    for (const expected of ["chat", "control", "agent", "settings"]) {
      expect(labels).toContain(expected);
    }
  });

  it("all tabs are unique", () => {
    const allTabs = TAB_GROUPS.flatMap((g) => g.tabs);
    const uniqueTabs = new Set(allTabs);
    expect(uniqueTabs.size).toBe(allTabs.length);
  });
});
