import { describe, expect, it, vi } from "vitest";
import {
  parseAppearanceConfig,
  parseThemeSelection,
  resolveAppearancePreset,
  resolveAppearanceScheme,
  resolveSystemTheme,
  resolveTheme,
} from "./theme.ts";

describe("resolveTheme", () => {
  it("resolves named theme families when a scheme is provided", () => {
    expect(resolveTheme("knot", "dark")).toBe("openknot");
    expect(resolveTheme("dash", "light")).toBe("dash-light");
  });
});

describe("resolveSystemTheme", () => {
  it("mirrors the active preferred color scheme", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    expect(resolveSystemTheme()).toBe("light");
    vi.unstubAllGlobals();
  });
});

describe("parseThemeSelection", () => {
  it("maps legacy stored values onto theme + mode", () => {
    expect(parseThemeSelection("system", undefined)).toEqual({
      theme: "claw",
      mode: "system",
    });
    expect(parseThemeSelection("fieldmanual", undefined)).toEqual({
      theme: "dash",
      mode: "dark",
    });
  });
});

describe("appearance config", () => {
  it("migrates a legacy light mode selection into single mode", () => {
    expect(parseAppearanceConfig(undefined, "light")).toEqual({
      mode: "single",
      lightPreset: "openclaw-light",
      darkPreset: "openclaw-dark",
      singleScheme: "light",
    });
  });

  it("resolves sync mode against the active OS scheme", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    const config = parseAppearanceConfig(
      {
        mode: "sync",
        lightPreset: "github-light-default",
        darkPreset: "github-dark-default",
        singleScheme: "dark",
      },
      undefined,
    );
    expect(resolveAppearanceScheme(config)).toBe("light");
    expect(resolveAppearancePreset(config)).toBe("github-light-default");
    vi.unstubAllGlobals();
  });
});
