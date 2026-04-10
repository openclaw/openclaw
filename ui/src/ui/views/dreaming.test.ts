/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderDreaming, setDreamSubTab, type DreamingProps } from "./dreaming.ts";

function buildProps(overrides?: Partial<DreamingProps>): DreamingProps {
  return {
    active: true,
    promotedCount: 12,
    phases: {
      light: { enabled: true, cron: "0 * * * *", nextRunAtMs: Date.parse("2026-04-05T11:30:00Z") },
      deep: { enabled: true, cron: "30 * * * *", nextRunAtMs: Date.parse("2026-04-05T12:00:00Z") },
      rem: { enabled: false, cron: "0 4 * * *" },
    },
    dreamingOf: null,
    nextCycle: "4:00 AM",
    timezone: "America/Los_Angeles",
    statusLoading: false,
    statusError: null,
    modeSaving: false,
    dreamDiaryLoading: false,
    dreamDiaryActionLoading: false,
    dreamDiaryError: null,
    dreamDiaryPath: "DREAMS.md",
    dreamDiaryContent:
      "# Dream Diary\n\n<!-- openclaw:dreaming:diary:start -->\n\n---\n\n*April 5, 2026, 3:00 AM*\n\nThe repository whispered of forgotten endpoints tonight.\n\n<!-- openclaw:dreaming:diary:end -->",
    onRefresh: () => {},
    onRefreshDiary: () => {},
    onBackfillDiary: () => {},
    onResetDiary: () => {},
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

  it("displays sleep phase cards", () => {
    const container = renderInto(buildProps());
    const phases = [...container.querySelectorAll(".dreams__phase-name")].map((node) =>
      node.textContent?.trim(),
    );
    expect(phases).toEqual(["Light", "Deep", "Rem"]);
    expect(container.querySelectorAll(".dreams__phase").length).toBe(3);
    expect(container.querySelector(".dreams__phase--off")?.textContent).toContain("off");
  });

  it("renders scene backfill and reset controls", () => {
    const container = renderInto(buildProps());
    const buttons = [...container.querySelectorAll("button")].map((node) =>
      node.textContent?.trim(),
    );
    expect(buttons).toContain("Backfill");
    expect(buttons).toContain("Reset");
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

  it("flattens structured backfill diary entries into plain prose", () => {
    setDreamSubTab("diary");
    const container = renderInto(
      buildProps({
        dreamDiaryContent: [
          "# Dream Diary",
          "",
          "<!-- openclaw:dreaming:diary:start -->",
          "",
          "---",
          "",
          "*January 1, 2026*",
          "",
          "<!-- openclaw:dreaming:backfill-entry day=2026-01-01 source=memory/2026-01-01.md -->",
          "",
          "What Happened",
          "1. Always use Happy Together for flights.",
          "",
          "Reflections",
          "1. Stable preferences were made explicit.",
          "",
          "Candidates",
          "- likely_durable: Happy Together rule",
          "",
          "Possible Lasting Updates",
          "- Use Happy Together for flights.",
          "",
          "<!-- openclaw:dreaming:diary:end -->",
        ].join("\n"),
      }),
    );
    const prose = [...container.querySelectorAll(".dreams-diary__para")].map((node) =>
      node.textContent?.trim(),
    );
    expect(prose).toContain("Always use Happy Together for flights.");
    expect(prose).toContain("Stable preferences were made explicit.");
    expect(prose).toContain("Happy Together rule");
    expect(prose).toContain("Use Happy Together for flights.");
    expect(container.querySelector(".dreams-diary__panel-title")).toBeNull();
    setDreamSubTab("scene");
  });

  it("renders diary day chips without the old density map", () => {
    setDreamSubTab("diary");
    const container = renderInto(
      buildProps({
        dreamDiaryContent: [
          "# Dream Diary",
          "",
          "<!-- openclaw:dreaming:diary:start -->",
          "",
          "---",
          "",
          "*January 1, 2026*",
          "",
          "What Happened",
          "1. First durable fact.",
          "",
          "---",
          "",
          "*January 2, 2026*",
          "",
          "What Happened",
          "1. Second durable fact.",
          "",
          "Candidates",
          "- candidate",
          "",
          "<!-- openclaw:dreaming:diary:end -->",
        ].join("\n"),
      }),
    );
    expect(container.querySelectorAll(".dreams-diary__day-chip").length).toBe(2);
    expect(container.querySelector(".dreams-diary__heatmap-cell")).toBeNull();
    expect(container.querySelector(".dreams-diary__timeline-month")).toBeNull();
    const labels = [...container.querySelectorAll(".dreams-diary__day-chip")].map((node) =>
      node.textContent?.replace(/\s+/g, "").trim(),
    );
    expect(labels.filter(Boolean).some((label) => /^\d+\/\d+$/.test(label ?? ""))).toBe(true);
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

  it("does not render the old page navigation chrome", () => {
    setDreamSubTab("diary");
    const container = renderInto(buildProps());
    expect(container.querySelector(".dreams-diary__page")).toBeNull();
    expect(container.querySelector(".dreams-diary__nav-btn")).toBeNull();
    setDreamSubTab("scene");
  });

  // Toggle lives in the page header (app-render.ts), not inside the dreaming view.
});
