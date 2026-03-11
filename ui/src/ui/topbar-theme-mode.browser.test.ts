import "../styles.css";
import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderTopbarThemeModeToggle } from "./app-render.helpers.ts";

describe("topbar theme mode styling", () => {
  it("renders icon-sized mode buttons instead of unstyled fallback boxes", () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderTopbarThemeModeToggle({
        themeMode: "system",
        setThemeMode: () => {},
      } as never),
      container,
    );

    const group = container.querySelector<HTMLElement>(".topbar-theme-mode");
    const button = container.querySelector<HTMLElement>(".topbar-theme-mode__btn");
    const svg = container.querySelector<SVGElement>(".topbar-theme-mode__btn svg");

    expect(group).not.toBeNull();
    expect(button).not.toBeNull();
    expect(svg).not.toBeNull();
    expect(getComputedStyle(group!).display).toBe("inline-flex");
    expect(getComputedStyle(button!).display).toBe("flex");
    expect(getComputedStyle(svg!).width).toBe("14px");
    expect(getComputedStyle(svg!).height).toBe("14px");
  });
});
