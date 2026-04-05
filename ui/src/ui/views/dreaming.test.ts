/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderDreaming, type DreamingProps } from "./dreaming.ts";

function buildProps(overrides?: Partial<DreamingProps>): DreamingProps {
  return {
    active: true,
    shortTermCount: 47,
    longTermCount: 182,
    promotedCount: 12,
    dreamingOf: null,
    nextCycle: "4:00 AM",
    timezone: "America/Los_Angeles",
    phases: [
      {
        id: "light",
        label: "Light",
        detail: "sort and stage the day",
        enabled: true,
        nextCycle: "1:00 AM",
        managedCronPresent: true,
      },
      {
        id: "deep",
        label: "Deep",
        detail: "promote durable memory",
        enabled: true,
        nextCycle: "3:00 AM",
        managedCronPresent: true,
      },
      {
        id: "rem",
        label: "REM",
        detail: "surface themes and reflections",
        enabled: false,
        nextCycle: null,
        managedCronPresent: false,
      },
    ],
    statusLoading: false,
    statusError: null,
    modeSaving: false,
    onRefresh: () => {},
    onToggleEnabled: () => {},
    onTogglePhase: () => {},
    ...overrides,
  };
}

function renderInto(props: DreamingProps): HTMLDivElement {
  const container = document.createElement("div");
  render(renderDreaming(props), container);
  return container;
}

describe("dreaming view", () => {
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

  it("shows active status label when active", () => {
    const container = renderInto(buildProps({ active: true }));
    const label = container.querySelector(".dreams__status-label");
    expect(label?.textContent).toBe("Dreaming Active");
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

  it("renders phase controls", () => {
    const container = renderInto(buildProps());
    expect(container.querySelector(".dreams__controls")).not.toBeNull();
    expect(container.querySelectorAll(".dreams__phase").length).toBe(3);
  });

  it("renders control error when present", () => {
    const container = renderInto(buildProps({ statusError: "patch failed" }));
    expect(container.querySelector(".dreams__controls-error")?.textContent).toContain(
      "patch failed",
    );
  });

  it("wires phase toggle callbacks", () => {
    const onTogglePhase = vi.fn();
    const container = renderInto(buildProps({ onTogglePhase }));

    container.querySelector<HTMLButtonElement>(".dreams__phase .btn")?.click();

    expect(onTogglePhase).toHaveBeenCalled();
  });
});
