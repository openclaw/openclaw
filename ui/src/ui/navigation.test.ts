// Control UI tests cover navigation behavior.
import { describe, expect, it } from "vitest";
import {
  SETTINGS_NAVIGATION_ROUTES,
  SIDEBAR_SECTIONS,
  navigationIconForRoute,
} from "../app-navigation.ts";
import {
  inferBasePathFromPathname,
  normalizeBasePath,
  normalizePath,
  pathForRoute,
  subtitleForRoute,
  routeIdFromPath,
  titleForRoute,
  type RouteId,
} from "../app-routes.ts";

/** All route identifiers derived from visible groups plus routed settings slices. */
const ALL_ROUTES: RouteId[] = Array.from(
  new Set<RouteId>([
    ...(SIDEBAR_SECTIONS.flatMap((group) => group.routes) as RouteId[]),
    ...SETTINGS_NAVIGATION_ROUTES,
  ]),
);

const leadingSlashNormalizerCases = [
  { name: "normalizeBasePath", normalize: normalizeBasePath, input: "ui", expected: "/ui" },
  { name: "normalizePath", normalize: normalizePath, input: "chat", expected: "/chat" },
];

describe("navigationIconForRoute", () => {
  it("returns stable icons for every route", () => {
    expect(
      Object.fromEntries(ALL_ROUTES.map((routeId) => [routeId, navigationIconForRoute(routeId)])),
    ).toEqual({
      chat: "messageSquare",
      overview: "barChart",
      activity: "activity",
      workboard: "folder",
      channels: "link",
      instances: "radio",
      sessions: "fileText",
      usage: "barChart",
      cron: "loader",
      agents: "folder",
      skills: "zap",
      "skill-workshop": "wrench",
      nodes: "monitor",
      dreams: "moon",
      config: "settings",
      communications: "send",
      appearance: "spark",
      automation: "terminal",
      mcp: "wrench",
      infrastructure: "globe",
      "ai-agents": "brain",
      debug: "bug",
      logs: "scrollText",
    });
  });

  it("returns a fallback icon for unknown route", () => {
    // TypeScript won't allow this normally, but runtime could receive unexpected values
    const unknownRouteId = "unknown" as RouteId;
    expect(navigationIconForRoute(unknownRouteId)).toBe("folder");
  });
});

describe("titleForRoute", () => {
  it("returns expected titles for every route", () => {
    expect(
      Object.fromEntries(ALL_ROUTES.map((routeId) => [routeId, titleForRoute(routeId)])),
    ).toEqual({
      chat: "Chat",
      overview: "Overview",
      activity: "Activity",
      workboard: "Workboard",
      channels: "Channels",
      instances: "Instances",
      sessions: "Sessions",
      usage: "Usage",
      cron: "Cron Jobs",
      agents: "Agents",
      skills: "Skills",
      "skill-workshop": "Skill Workshop",
      nodes: "Nodes",
      dreams: "Dreaming",
      config: "Settings",
      communications: "Communications",
      appearance: "Appearance",
      automation: "Automation",
      mcp: "MCP",
      infrastructure: "Infrastructure",
      "ai-agents": "AI & Agents",
      debug: "Debug",
      logs: "Logs",
    });
  });
});

describe("subtitleForRoute", () => {
  it("returns expected subtitles for every route", () => {
    expect(
      Object.fromEntries(ALL_ROUTES.map((routeId) => [routeId, subtitleForRoute(routeId)])),
    ).toEqual({
      chat: "Gateway chat for quick interventions.",
      overview: "Status, entry points, health.",
      activity: "Browser-local tool activity summaries.",
      workboard: "Agent work queue and session handoff.",
      channels: "Channels and settings.",
      instances: "Connected clients and nodes.",
      sessions: "Active sessions and defaults.",
      usage: "API usage and costs.",
      cron: "Wakeups and recurring runs.",
      agents: "Workspaces, tools, identities.",
      skills: "Skills and API keys.",
      "skill-workshop": "Review, refine, and apply proposals before they become live skills.",
      nodes: "Paired devices and commands.",
      dreams: "Memory dreaming, consolidation, and reflection.",
      config: "Edit openclaw.json.",
      communications: "Channels, messages, and audio settings.",
      appearance: "Theme, UI, and setup wizard settings.",
      automation: "Commands, hooks, cron, and plugins.",
      mcp: "MCP servers, auth, tools, and diagnostics.",
      infrastructure: "Gateway, web, browser, and media settings.",
      "ai-agents": "Agents, models, skills, tools, memory, session.",
      debug: "Snapshots, events, RPC.",
      logs: "Live gateway logs.",
    });
  });
});

describe("leading slash path normalizers", () => {
  it.each(leadingSlashNormalizerCases)(
    "$name adds leading slash if missing",
    ({ expected, input, normalize }) => {
      expect(normalize(input)).toBe(expected);
    },
  );
});

describe("normalizeBasePath", () => {
  it("returns empty string for falsy input", () => {
    expect(normalizeBasePath("")).toBe("");
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

  it("removes trailing slash except for root", () => {
    expect(normalizePath("/chat/")).toBe("/chat");
    expect(normalizePath("/")).toBe("/");
  });
});

describe("pathForRoute", () => {
  it("returns correct path without base", () => {
    expect(pathForRoute("chat")).toBe("/chat");
    expect(pathForRoute("overview")).toBe("/overview");
  });

  it("prepends base path", () => {
    expect(pathForRoute("chat", "/ui")).toBe("/ui/chat");
    expect(pathForRoute("sessions", "/apps/openclaw")).toBe("/apps/openclaw/sessions");
  });
});

describe("routeIdFromPath", () => {
  it("returns tab for valid path", () => {
    expect(routeIdFromPath("/chat")).toBe("chat");
    expect(routeIdFromPath("/overview")).toBe("overview");
    expect(routeIdFromPath("/activity")).toBe("activity");
    expect(routeIdFromPath("/sessions")).toBe("sessions");
    expect(routeIdFromPath("/dreaming")).toBe("dreams");
    expect(routeIdFromPath("/dreams")).toBe("dreams");
  });

  it("returns chat for root path", () => {
    expect(routeIdFromPath("/")).toBe("chat");
  });

  it("handles base paths", () => {
    expect(routeIdFromPath("/ui/chat", "/ui")).toBe("chat");
    expect(routeIdFromPath("/apps/openclaw/sessions", "/apps/openclaw")).toBe("sessions");
  });

  it("returns null for unknown path", () => {
    expect(routeIdFromPath("/unknown")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(routeIdFromPath("/CHAT")).toBe("chat");
    expect(routeIdFromPath("/Overview")).toBe("overview");
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

describe("SIDEBAR_SECTIONS", () => {
  it("contains all expected groups", () => {
    expect(SIDEBAR_SECTIONS.map((g) => g.label)).toEqual(["chat", "control", "agent", "settings"]);
  });

  it("all routes are unique", () => {
    const allRoutes = SIDEBAR_SECTIONS.flatMap((g) => g.routes);
    const uniqueRoutes = new Set(allRoutes);
    expect(uniqueRoutes.size).toBe(allRoutes.length);
  });

  it("keeps detailed settings slices routed but out of the root sidebar", () => {
    const settings = SIDEBAR_SECTIONS.find((group) => group.label === "settings");
    expect(settings?.routes).toEqual(["config"]);
    expect(SETTINGS_NAVIGATION_ROUTES).toEqual([
      "config",
      "channels",
      "communications",
      "appearance",
      "automation",
      "mcp",
      "infrastructure",
      "ai-agents",
      "debug",
      "logs",
    ]);
  });
});
