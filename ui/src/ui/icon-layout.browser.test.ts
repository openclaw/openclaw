import "../styles.css";
import { html, render } from "lit";
import { describe, expect, it } from "vitest";
import { icons } from "./icons.ts";

describe("icon layout styling", () => {
  it("styles nav group chevrons as compact inline SVGs", () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      html`<button class="nav-group__label">
        <span class="nav-group__label-text">Control</span>
        <span class="nav-group__chevron">${icons.chevronDown}</span>
      </button>`,
      container,
    );

    const button = container.querySelector<HTMLElement>(".nav-group__label");
    const svg = container.querySelector<SVGElement>(".nav-group__chevron svg");
    expect(button).not.toBeNull();
    expect(svg).not.toBeNull();
    expect(getComputedStyle(button!).display).toBe("flex");
    expect(getComputedStyle(svg!).width).toBe("12px");
    expect(getComputedStyle(svg!).height).toBe("12px");
  });

  it("styles tool summary icons without default SVG fallback sizing", () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      html`<details class="chat-tool-msg-collapse">
        <summary class="chat-tool-msg-summary">
          <span class="chat-tool-msg-summary__icon">${icons.zap}</span>
          <span class="chat-tool-msg-summary__label">Tool output</span>
        </summary>
      </details>`,
      container,
    );

    const summary = container.querySelector<HTMLElement>(".chat-tool-msg-summary");
    const svg = container.querySelector<SVGElement>(".chat-tool-msg-summary__icon svg");
    expect(summary).not.toBeNull();
    expect(svg).not.toBeNull();
    expect(getComputedStyle(summary!).display).toBe("flex");
    expect(getComputedStyle(svg!).width).toBe("14px");
    expect(getComputedStyle(svg!).height).toBe("14px");
  });

  it("renders the shared nav collapse trigger with the compact hamburger icon", () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      html`<button class="nav-collapse-toggle" type="button">
        <span class="nav-collapse-toggle__icon">${icons.menu}</span>
      </button>`,
      container,
    );

    const button = container.querySelector<HTMLElement>(".nav-collapse-toggle");
    const svg = container.querySelector<SVGElement>(".nav-collapse-toggle__icon svg");
    expect(button).not.toBeNull();
    expect(svg).not.toBeNull();
    expect(getComputedStyle(button!).display).toBe("flex");
    expect(getComputedStyle(svg!).width).toBe("18px");
    expect(getComputedStyle(svg!).height).toBe("18px");
  });
});
