// Control UI tests cover navigation groups behavior.
import { describe, expect, it } from "vitest";
import {
  SETTINGS_NAVIGATION_ROUTES,
  SIDEBAR_SECTIONS,
  isSettingsNavigationRoute,
  isRouteInSidebarSection,
} from "../app-navigation.ts";
import { routeIdFromPath } from "../app-routes.ts";

describe("SIDEBAR_SECTIONS", () => {
  it("collapses detailed settings slices into one sidebar entry", () => {
    const settings = SIDEBAR_SECTIONS.find((group) => group.label === "settings");
    expect(settings?.routes).toEqual(["config"]);
    expect(SETTINGS_NAVIGATION_ROUTES.every((routeId) => isSettingsNavigationRoute(routeId))).toBe(
      true,
    );
  });

  it("keeps channel management out of the primary control sidebar", () => {
    const control = SIDEBAR_SECTIONS.find((group) => group.label === "control");
    expect(control?.routes).toEqual([
      "overview",
      "activity",
      "workboard",
      "instances",
      "sessions",
      "usage",
      "cron",
    ]);
    expect(SETTINGS_NAVIGATION_ROUTES).toContain("channels");
  });

  it("keeps the settings group active for nested settings routes", () => {
    const settings = SIDEBAR_SECTIONS.find((group) => group.label === "settings");
    if (!settings) {
      throw new Error("Expected settings group");
    }

    expect(isRouteInSidebarSection(settings, "appearance")).toBe(true);
    expect(isRouteInSidebarSection(settings, "channels")).toBe(true);
    expect(isRouteInSidebarSection(settings, "debug")).toBe(true);
    expect(isRouteInSidebarSection(settings, "chat")).toBe(false);
  });

  it("routes every published settings slice", () => {
    expect(routeIdFromPath("/communications")).toBe("communications");
    expect(routeIdFromPath("/appearance")).toBe("appearance");
    expect(routeIdFromPath("/automation")).toBe("automation");
    expect(routeIdFromPath("/infrastructure")).toBe("infrastructure");
    expect(routeIdFromPath("/ai-agents")).toBe("ai-agents");
    expect(routeIdFromPath("/config")).toBe("config");
    expect(routeIdFromPath("/channels")).toBe("channels");
  });
});
