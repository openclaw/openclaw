/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderDreams, type DreamsProps } from "./dreams.ts";

function buildProps(overrides?: Partial<DreamsProps>): DreamsProps {
  return {
    active: true,
    shortTermCount: 47,
    longTermCount: 182,
    promotedCount: 12,
    dreamingOf: null,
    nextCycle: "4:00 AM",
    ...overrides,
  };
}

function renderInto(props: DreamsProps): HTMLDivElement {
  const container = document.createElement("div");
  render(renderDreams(props), container);
  return container;
}

describe("dreams view", () => {
  it("renders the sleeping lobster SVG", () => {
    const container = renderInto(buildProps());
    const svg = container.querySelector(".dreams__lobster svg");
    expect(svg).not.toBeNull();
  });

  it("shows three floating Z elements", () => {
    const container = renderInto(buildProps());
    const zs = container.querySelectorAll(".dreams__z");
    expect(zs.length).toBe(3);
  });

  it("renders stars", () => {
    const container = renderInto(buildProps());
    const stars = container.querySelectorAll(".dreams__star");
    expect(stars.length).toBe(12);
  });

  it("renders moon", () => {
    const container = renderInto(buildProps());
    expect(container.querySelector(".dreams__moon")).not.toBeNull();
  });

  it("displays memory stats", () => {
    const container = renderInto(buildProps());
    const values = container.querySelectorAll(".dreams__stat-value");
    expect(values.length).toBe(3);
    expect(values[0]?.textContent).toBe("47");
    expect(values[1]?.textContent).toBe("182");
    expect(values[2]?.textContent).toBe("12");
  });

  it("shows dream bubble when active", () => {
    const container = renderInto(buildProps({ active: true }));
    expect(container.querySelector(".dreams__bubble")).not.toBeNull();
  });

  it("hides dream bubble when idle", () => {
    const container = renderInto(buildProps({ active: false }));
    expect(container.querySelector(".dreams__bubble")).toBeNull();
  });

  it("shows custom dreamingOf text when provided", () => {
    const container = renderInto(buildProps({ dreamingOf: "reindexing old chats…" }));
    const text = container.querySelector(".dreams__bubble-text");
    expect(text?.textContent).toBe("reindexing old chats…");
  });

  it("cycles through phrases when dreamingOf is null", () => {
    const container = renderInto(buildProps({ dreamingOf: null }));
    const text = container.querySelector(".dreams__bubble-text");
    // Should be one of the built-in phrases, not empty
    expect(text?.textContent?.length).toBeGreaterThan(5);
    expect(text?.textContent).toContain("…");
  });

  it("shows active status label when active", () => {
    const container = renderInto(buildProps({ active: true }));
    const label = container.querySelector(".dreams__status-label");
    expect(label?.textContent).toBe("Memory Dreaming Active");
  });

  it("shows idle status label when inactive", () => {
    const container = renderInto(buildProps({ active: false }));
    const label = container.querySelector(".dreams__status-label");
    expect(label?.textContent).toBe("Dreaming Idle");
  });

  it("applies idle class when not active", () => {
    const container = renderInto(buildProps({ active: false }));
    expect(container.querySelector(".dreams--idle")).not.toBeNull();
  });

  it("shows next cycle info when provided", () => {
    const container = renderInto(buildProps({ nextCycle: "4:00 AM" }));
    const detail = container.querySelector(".dreams__status-detail span");
    expect(detail?.textContent).toContain("4:00 AM");
  });

  it("omits next cycle when null", () => {
    const container = renderInto(buildProps({ nextCycle: null }));
    const detail = container.querySelector(".dreams__status-detail span");
    expect(detail?.textContent).not.toContain("next cycle");
  });
});
