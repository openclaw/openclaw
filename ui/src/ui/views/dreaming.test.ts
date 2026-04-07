/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderDreaming, setDreamSubTab, type DreamingProps } from "./dreaming.ts";

function buildProps(overrides?: Partial<DreamingProps>): DreamingProps {
  return {
    active: true,
    shortTermCount: 47,
    totalSignalCount: 182,
    phaseSignalCount: 29,
    promotedCount: 12,
    dreamingOf: null,
    nextCycle: "4:00 AM",
    timezone: "America/Los_Angeles",
    statusLoading: false,
    statusError: null,
    modeSaving: false,
    dreamDiaryLoading: false,
    dreamDiaryError: null,
    dreamDiaryPath: "DREAMS.md",
    dreamDiaryContent:
      "# Dream Diary\n\n<!-- openclaw:dreaming:diary:start -->\n\n---\n\n*April 5, 2026, 3:00 AM*\n\nThe repository whispered of forgotten endpoints tonight.\n\n<!-- openclaw:dreaming:diary:end -->",
    onRefresh: () => {},
    onRefreshDiary: () => {},
    onToggleEnabled: () => {},
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
    expect(values[2]?.textContent).toBe("29");
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
    const container = renderInto(buildProps({ dreamingOf: "reindexing old chats\u2026" }));
    const text = container.querySelector(".dreams__bubble-text");
    expect(text?.textContent).toBe("reindexing old chats\u2026");
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

  it("renders control error when present", () => {
    const container = renderInto(buildProps({ statusError: "patch failed" }));
    expect(container.querySelector(".dreams__controls-error")?.textContent).toContain(
      "patch failed",
    );
  });

  it("renders sub-tab navigation", () => {
    const container = renderInto(buildProps());
    const tabs = container.querySelectorAll(".dreams__tab");
    expect(tabs.length).toBe(2);
    expect(tabs[0]?.textContent).toContain("Scene");
    expect(tabs[1]?.textContent).toContain("Diary");
  });

  it("renders dream diary with parsed entry on diary tab", () => {
    setDreamSubTab("diary");
    const container = renderInto(buildProps());
    const title = container.querySelector(".dreams-diary__title");
    expect(title?.textContent).toContain("Dream Diary");

    const entry = container.querySelector(".dreams-diary__entry");
    expect(entry).not.toBeNull();
    const date = container.querySelector(".dreams-diary__date");
    expect(date?.textContent).toContain("April 5, 2026");
    const body = container.querySelector(".dreams-diary__para");
    expect(body?.textContent).toContain("forgotten endpoints");
    setDreamSubTab("scene");
  });

  it("shows empty diary state when no diary content exists", () => {
    setDreamSubTab("diary");
    const container = renderInto(buildProps({ dreamDiaryContent: null }));
    expect(container.querySelector(".dreams-diary__empty")).not.toBeNull();
    expect(container.querySelector(".dreams-diary__empty-text")?.textContent).toContain(
      "No dreams yet",
    );
    setDreamSubTab("scene");
  });

  it("shows diary error message when diary load fails", () => {
    setDreamSubTab("diary");
    const container = renderInto(buildProps({ dreamDiaryError: "read failed" }));
    expect(container.querySelector(".dreams-diary__error")?.textContent).toContain("read failed");
    setDreamSubTab("scene");
  });

  it("renders page navigation for diary entries", () => {
    setDreamSubTab("diary");
    const container = renderInto(buildProps());
    const pageInfo = container.querySelector(".dreams-diary__page");
    expect(pageInfo?.textContent).toContain("1 / 1");
    const navBtns = container.querySelectorAll(".dreams-diary__nav-btn");
    expect(navBtns.length).toBe(2);
    setDreamSubTab("scene");
  });

  // Toggle lives in the page header (app-render.ts), not inside the dreaming view.
});
