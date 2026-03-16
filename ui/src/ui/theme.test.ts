import { describe, expect, it, vi } from "vitest";
import { colorSchemeForTheme, parseThemeSelection, resolveTheme } from "./theme.ts";

describe("resolveTheme", () => {
  it("keeps the legacy mode-only signature working for existing callers", () => {
    expect(resolveTheme("dark")).toBe("dark");
    expect(resolveTheme("light")).toBe("light");
  });

  it("resolves named theme families when mode is provided", () => {
    expect(resolveTheme("knot", "dark")).toBe("openknot");
    expect(resolveTheme("dash", "light")).toBe("dash-light");
  });

  it("uses system preference when a named theme omits mode", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    expect(resolveTheme("knot")).toBe("openknot-light");
    vi.unstubAllGlobals();
  });

  it("maps resolved theme families back to valid CSS color-scheme values", () => {
    expect(colorSchemeForTheme("openknot")).toBe("dark");
    expect(colorSchemeForTheme("dash-light")).toBe("light");
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
