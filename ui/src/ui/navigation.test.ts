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
    expect(iconForTab("chat")).toBe("messageSquare");
    expect(iconForTab("overview")).toBe("barChart");
    expect(iconForTab("agentWorkflows")).toBe("brain");
    expect(iconForTab("appStudio")).toBe("spark");
    expect(iconForTab("musicStudio")).toBe("radio");
    expect(iconForTab("snesStudio")).toBe("monitor");
    expect(iconForTab("bookWriter")).toBe("book");
    expect(iconForTab("kalshi")).toBe("lineChart");
    expect(iconForTab("patternLab")).toBe("monitor");
    expect(iconForTab("channels")).toBe("link");
    expect(iconForTab("instances")).toBe("radio");
    expect(iconForTab("sessions")).toBe("fileText");
    expect(iconForTab("cron")).toBe("loader");
    expect(iconForTab("skills")).toBe("zap");
    expect(iconForTab("nodes")).toBe("monitor");
    expect(iconForTab("config")).toBe("settings");
    expect(iconForTab("debug")).toBe("bug");
    expect(iconForTab("logs")).toBe("scrollText");
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
    expect(titleForTab("chat")).toBe("Chat");
    expect(titleForTab("agentWorkflows")).toBe("Agent Workflow Maps");
    expect(titleForTab("overview")).toBe("Overview");
    expect(titleForTab("appStudio")).toBe("App Studio");
    expect(titleForTab("musicStudio")).toBe("Music Studio");
    expect(titleForTab("snesStudio")).toBe("SNES Studio");
    expect(titleForTab("bookWriter")).toBe("Book Studio");
    expect(titleForTab("kalshi")).toBe("Kalshi");
    expect(titleForTab("patternLab")).toBe("Pattern Lab");
    expect(titleForTab("cron")).toBe("Cron Jobs");
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
    expect(subtitleForTab("chat")).toContain("quick interventions");
    expect(subtitleForTab("agentWorkflows")).toContain("Live Agent Workspace");
    expect(subtitleForTab("appStudio")).toContain("native iPhone apps");
    expect(subtitleForTab("musicStudio")).toContain("original music");
    expect(subtitleForTab("snesStudio")).toContain("Prompt, play, and edit");
    expect(subtitleForTab("bookWriter")).toContain("original books");
    expect(subtitleForTab("kalshi")).toContain("Prediction market");
    expect(subtitleForTab("patternLab")).toContain("YouTube review");
    expect(subtitleForTab("config")).toContain("openclaw.json");
  });
});

describe("normalizeBasePath", () => {
  it("returns empty string for falsy input", () => {
    expect(normalizeBasePath("")).toBe("");
  });

  it("adds leading slash if missing", () => {
    expect(normalizeBasePath("ui")).toBe("/ui");
  });

  it("removes trailing slash", () => {
    expect(normalizeBasePath("/ui/")).toBe("/ui");
  });

  it("returns empty string for root path", () => {
    expect(normalizeBasePath("/")).toBe("");
  });

  it("handles nested paths", () => {
    expect(normalizeBasePath("/apps/openclaw")).toBe("/apps/openclaw");
  });
});

describe("normalizePath", () => {
  it("returns / for falsy input", () => {
    expect(normalizePath("")).toBe("/");
  });

  it("adds leading slash if missing", () => {
    expect(normalizePath("chat")).toBe("/chat");
  });

  it("removes trailing slash except for root", () => {
    expect(normalizePath("/chat/")).toBe("/chat");
    expect(normalizePath("/")).toBe("/");
  });
});

describe("pathForTab", () => {
  it("returns correct path without base", () => {
    expect(pathForTab("chat")).toBe("/chat");
    expect(pathForTab("agentWorkflows")).toBe("/agent-workflows");
    expect(pathForTab("overview")).toBe("/overview");
    expect(pathForTab("appStudio")).toBe("/app-studio");
    expect(pathForTab("musicStudio")).toBe("/music-studio");
    expect(pathForTab("snesStudio")).toBe("/snes-studio");
    expect(pathForTab("bookWriter")).toBe("/book-writer");
    expect(pathForTab("kalshi")).toBe("/kalshi");
    expect(pathForTab("patternLab")).toBe("/pattern-lab");
  });

  it("prepends base path", () => {
    expect(pathForTab("chat", "/ui")).toBe("/ui/chat");
    expect(pathForTab("sessions", "/apps/openclaw")).toBe("/apps/openclaw/sessions");
  });
});

describe("tabFromPath", () => {
  it("returns tab for valid path", () => {
    expect(tabFromPath("/chat")).toBe("chat");
    expect(tabFromPath("/agent-workflows")).toBe("agentWorkflows");
    expect(tabFromPath("/overview")).toBe("overview");
    expect(tabFromPath("/app-studio")).toBe("appStudio");
    expect(tabFromPath("/music-studio")).toBe("musicStudio");
    expect(tabFromPath("/snes-studio")).toBe("snesStudio");
    expect(tabFromPath("/book-writer")).toBe("bookWriter");
    expect(tabFromPath("/kalshi")).toBe("kalshi");
    expect(tabFromPath("/pattern-lab")).toBe("patternLab");
    expect(tabFromPath("/sessions")).toBe("sessions");
    expect(tabFromPath("/dreaming")).toBe("dreams");
    expect(tabFromPath("/dreams")).toBe("dreams");
  });

  it("returns chat for root path", () => {
    expect(tabFromPath("/")).toBe("chat");
  });

  it("handles base paths", () => {
    expect(tabFromPath("/ui/chat", "/ui")).toBe("chat");
    expect(tabFromPath("/apps/openclaw/sessions", "/apps/openclaw")).toBe("sessions");
  });

  it("returns null for unknown path", () => {
    expect(tabFromPath("/unknown")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(tabFromPath("/CHAT")).toBe("chat");
    expect(tabFromPath("/Overview")).toBe("overview");
  });
});

describe("inferBasePathFromPathname", () => {
  it("returns empty string for root", () => {
    expect(inferBasePathFromPathname("/")).toBe("");
  });

  it("returns empty string for direct tab path", () => {
    expect(inferBasePathFromPathname("/chat")).toBe("");
    expect(inferBasePathFromPathname("/overview")).toBe("");
    expect(inferBasePathFromPathname("/dreaming")).toBe("");
    expect(inferBasePathFromPathname("/dreams")).toBe("");
  });

  it("infers base path from nested paths", () => {
    expect(inferBasePathFromPathname("/ui/chat")).toBe("/ui");
    expect(inferBasePathFromPathname("/apps/openclaw/sessions")).toBe("/apps/openclaw");
  });

  it("handles index.html suffix", () => {
    expect(inferBasePathFromPathname("/index.html")).toBe("");
    expect(inferBasePathFromPathname("/ui/index.html")).toBe("/ui");
  });
});

describe("TAB_GROUPS", () => {
  it("contains all expected groups", () => {
    const labels = TAB_GROUPS.map((g) => g.label);
    expect(labels).toContain("chat");
    expect(labels).toContain("control");
    expect(labels).toContain("dashboards");
    expect(labels).toContain("agent");
    expect(labels).toContain("settings");
  });

  it("all tabs are unique", () => {
    const allTabs = TAB_GROUPS.flatMap((g) => g.tabs);
    const uniqueTabs = new Set(allTabs);
    expect(uniqueTabs.size).toBe(allTabs.length);
  });
});
