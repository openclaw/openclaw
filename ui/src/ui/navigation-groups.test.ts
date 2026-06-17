// Control UI tests cover navigation groups behavior.
import { describe, expect, it } from "vitest";
import {
  SETTINGS_ROUTES,
  ROUTE_GROUPS,
  isSettingsRoute,
  isRouteInGroup,
  routeIdFromPath,
} from "../routes/route-registry.ts";

describe("ROUTE_GROUPS", () => {
  it("collapses detailed settings slices into one sidebar entry", () => {
    const settings = ROUTE_GROUPS.find((group) => group.label === "settings");
    expect(settings?.routes).toEqual(["config"]);
    expect(SETTINGS_ROUTES.every((routeId) => isSettingsRoute(routeId))).toBe(true);
  });

  it("keeps channel management out of the primary control sidebar", () => {
    const control = ROUTE_GROUPS.find((group) => group.label === "control");
    expect(control?.routes).toEqual([
      "overview",
      "activity",
      "workboard",
      "instances",
      "sessions",
      "usage",
      "cron",
    ]);
    expect(SETTINGS_ROUTES).toContain("channels");
  });

  it("keeps the settings group active for nested settings routes", () => {
    const settings = ROUTE_GROUPS.find((group) => group.label === "settings");
    if (!settings) {
      throw new Error("Expected settings group");
    }

    expect(isRouteInGroup(settings, "appearance")).toBe(true);
    expect(isRouteInGroup(settings, "channels")).toBe(true);
    expect(isRouteInGroup(settings, "debug")).toBe(true);
    expect(isRouteInGroup(settings, "chat")).toBe(false);
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
