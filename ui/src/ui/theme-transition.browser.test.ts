import { afterEach, describe, expect, it, vi } from "vitest";
import { startThemeTransition } from "./theme-transition.ts";
import { resolveTheme } from "./theme.ts";

describe("theme transition regressions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.classList.remove("theme-transition");
    document.documentElement.style.removeProperty("--theme-switch-x");
    document.documentElement.style.removeProperty("--theme-switch-y");
  });

  it("cleans up transition class and vars after dark/light toggle completes", async () => {
    const startViewTransition = vi.fn((callback: () => void) => {
      callback();
      return { finished: Promise.resolve() };
    });

    Object.assign(document, { startViewTransition });

    const applyTheme = vi.fn();
    startThemeTransition({
      currentTheme: "dark",
      nextTheme: "light",
      applyTheme,
      context: { pointerClientX: 10, pointerClientY: 20 },
    });

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(applyTheme).toHaveBeenCalledTimes(1);

    await Promise.resolve();

    const root = document.documentElement;
    expect(root.classList.contains("theme-transition")).toBe(false);
    expect(root.style.getPropertyValue("--theme-switch-x")).toBe("");
    expect(root.style.getPropertyValue("--theme-switch-y")).toBe("");
  });

  it("cleans up transition class and vars when toggling back to dark", async () => {
    const startViewTransition = vi.fn((callback: () => void) => {
      callback();
      return { finished: Promise.resolve() };
    });
    Object.assign(document, { startViewTransition });

    const applyTheme = vi.fn();
    startThemeTransition({
      currentTheme: "light",
      nextTheme: "dark",
      applyTheme,
      context: { pointerClientX: 200, pointerClientY: 160 },
    });

    await Promise.resolve();

    const root = document.documentElement;
    expect(applyTheme).toHaveBeenCalledTimes(1);
    expect(root.classList.contains("theme-transition")).toBe(false);
    expect(root.style.getPropertyValue("--theme-switch-x")).toBe("");
    expect(root.style.getPropertyValue("--theme-switch-y")).toBe("");
  });

  it("skips transition when current and next theme are the same", () => {
    const resolved = resolveTheme("dark");
    expect(resolved).toBe("dark");

    const applyTheme = vi.fn();
    startThemeTransition({
      currentTheme: resolved,
      nextTheme: resolved,
      applyTheme,
    });

    expect(applyTheme).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains("theme-transition")).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--theme-switch-x")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--theme-switch-y")).toBe("");
  });

  it("respects prefers-reduced-motion by bypassing view transitions and cleaning vars", () => {
    const startViewTransition = vi.fn((callback: () => void) => {
      callback();
      return { finished: Promise.resolve() };
    });
    Object.assign(document, { startViewTransition });

    vi.spyOn(window, "matchMedia").mockImplementation((query: string): MediaQueryList => {
      return {
        media: query,
        matches: query === "(prefers-reduced-motion: reduce)",
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => true,
      } as MediaQueryList;
    });

    const root = document.documentElement;
    root.style.setProperty("--theme-switch-x", "50%");
    root.style.setProperty("--theme-switch-y", "50%");
    root.classList.add("theme-transition");

    const applyTheme = vi.fn();
    startThemeTransition({
      currentTheme: "dark",
      nextTheme: "light",
      applyTheme,
    });

    expect(applyTheme).toHaveBeenCalledTimes(1);
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(root.classList.contains("theme-transition")).toBe(false);
    expect(root.style.getPropertyValue("--theme-switch-x")).toBe("");
    expect(root.style.getPropertyValue("--theme-switch-y")).toBe("");
  });
});
