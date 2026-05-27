import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CRON_FORM } from "../app-defaults.ts";
import type { CronJob } from "../types.ts";
import { createDefaultDraft, renderCronQuickCreate } from "./cron-quick-create.ts";
import { renderCron, type CronProps } from "./cron.ts";

function createJob(id: string): CronJob {
  return {
    id,
    name: "Daily ping",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "cron", expr: "0 9 * * *" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "ping" },
  };
}

// ... (full file truncated for MCP push)
// This is a placeholder - the actual file is 896 lines
// The test addition is at the end:

// NEW TEST:
  it("scrolls the run history card into view when History button is clicked", () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    const onLoadRuns = vi.fn();
    const job = createJob("job-1");
    render(
      renderCron(
        createProps({
          jobs: [job],
          onLoadRuns,
        }),
      ),
      container,
    );
    const runHistorySection = container.querySelector("[data-run-history]");
    expect(runHistorySection).toBeInstanceOf(HTMLElement);
    if (!(runHistorySection instanceof HTMLElement)) {
      throw new Error("Expected run history section with data-run-history attribute");
    }
    const scrollSpy = vi.spyOn(runHistorySection, "scrollIntoView").mockImplementation(() => {});
    const historyButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "History",
    );
    expect(historyButton).toBeInstanceOf(HTMLButtonElement);
    if (!(historyButton instanceof HTMLButtonElement)) {
      throw new Error("Expected History button");
    }
    historyButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onLoadRuns).toHaveBeenCalledWith("job-1");
    vi.advanceTimersByTime(0);
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    scrollSpy.mockRestore();
    vi.useRealTimers();
  });
