import { describe, expect, it, vi } from "vitest";
import { parseThemeSelection, resolveTheme } from "./theme.ts";

describe("resolveTheme", () => {
  it("resolves named theme families when mode is provided", () => {
    expect(resolveTheme("claw", "dark")).toBe("dark");
    expect(resolveTheme("claw", "light")).toBe("light");
  });

  it("resolves alternate named theme families when mode is provided", () => {
    expect(resolveTheme("knot", "dark")).toBe("openknot");
    expect(resolveTheme("dash", "light")).toBe("dash-light");
  });

  it("uses system preference when system mode is selected", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    expect(resolveTheme("knot", "system")).toBe("openknot-light");
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
