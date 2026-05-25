/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { ActivityEntry, ActivityStatus } from "../activity-model.ts";
import { renderActivity, type ActivityProps } from "./activity.ts";

function createEntry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: "run-1:tool-1",
    toolCallId: "tool-1",
    runId: "run-1",
    sessionKey: "main",
    toolName: "exec",
    status: "running",
    startedAt: 1_000,
    updatedAt: 120_900,
    durationMs: 119_900,
    outputPreview: "ok",
    outputTruncated: false,
    summary: "exec running; 0 arguments hidden",
    hiddenArgumentCount: 0,
    ...overrides,
  };
}

function createProps(overrides: Partial<ActivityProps> = {}): ActivityProps {
  const statusFilters: Record<ActivityStatus, boolean> = {
    running: true,
    done: true,
    error: true,
  };
  return {
    entries: [createEntry()],
    filterText: "",
    statusFilters,
    toolFilter: "",
    expandedIds: new Set<string>(),
    autoFollow: true,
    onFilterTextChange: vi.fn(),
    onToolFilterChange: vi.fn(),
    onStatusToggle: vi.fn(),
    onToggleAutoFollow: vi.fn(),
    onClear: vi.fn(),
    onExpandAll: vi.fn(),
    onCollapseAll: vi.fn(),
    onEntryToggle: vi.fn(),
    onScroll: vi.fn(),
    ...overrides,
  };
}

describe("renderActivity", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the summary from localized labels", async () => {
    await i18n.setLocale("de");
    const container = document.createElement("div");
    document.body.append(container);

    render(renderActivity(createProps()), container);

    expect(container.querySelector(".activity-entry__text")?.textContent?.trim()).toBe(
      "exec Wird ausgeführt; 0 arguments hidden",
    );
  });

  it("normalizes rounded minute durations that would otherwise show 60 seconds", async () => {
    await i18n.setLocale("en");
    const container = document.createElement("div");
    document.body.append(container);

    render(renderActivity(createProps()), container);

    const meta = Array.from(container.querySelectorAll(".activity-entry__meta span")).map(
      (element) => element.textContent?.trim(),
    );
    expect(meta).toContain("2m 0s");
  });
});
