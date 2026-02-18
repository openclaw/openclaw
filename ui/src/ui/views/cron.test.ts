import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../types.ts";
import { DEFAULT_CRON_FORM } from "../app-defaults.ts";
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

function createProps(overrides: Partial<CronProps> = {}): CronProps {
  return {
    basePath: "",
    loading: false,
    status: null,
    jobs: [],
    error: null,
    busy: false,
    form: { ...DEFAULT_CRON_FORM },
    channels: [],
    channelLabels: {},
    runsJobId: null,
    runs: [],
    onFormChange: () => undefined,
    onRefresh: () => undefined,
    onAdd: () => undefined,
    onToggle: () => undefined,
    onRun: () => undefined,
    onRemove: () => undefined,
    onLoadRuns: () => undefined,
    ...overrides,
  };
}

describe("cron view", () => {
  it("prompts to select a job before showing run history", () => {
    const container = document.createElement("div");
    render(renderCron(createProps()), container);

    expect(container.textContent).toContain("Select a job to inspect run history.");
  });

  it("loads run history when clicking a job row", () => {
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

    const row = container.querySelector(".list-item-clickable");
    expect(row).not.toBeNull();
    row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onLoadRuns).toHaveBeenCalledWith("job-1");
  });

  it("marks the selected job and keeps History button to a single call", () => {
    const container = document.createElement("div");
    const onLoadRuns = vi.fn();
    const job = createJob("job-1");
    render(
      renderCron(
        createProps({
          jobs: [job],
          runsJobId: "job-1",
          onLoadRuns,
        }),
      ),
      container,
    );

    const selected = container.querySelector(".list-item-selected");
    expect(selected).not.toBeNull();

    const historyButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "History",
    );
    expect(historyButton).not.toBeUndefined();
    historyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onLoadRuns).toHaveBeenCalledTimes(1);
    expect(onLoadRuns).toHaveBeenCalledWith("job-1");
  });

  it("renders run chat links when session keys are present", () => {
    const container = document.createElement("div");
    render(
      renderCron(
        createProps({
          basePath: "/ui",
          runsJobId: "job-1",
          runs: [
            {
              ts: Date.now(),
              jobId: "job-1",
              status: "ok",
              summary: "done",
              sessionKey: "agent:main:cron:job-1:run:abc",
            },
          ],
        }),
      ),
      container,
    );

    const link = container.querySelector("a.session-link");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toContain(
      "/ui/chat?session=agent%3Amain%3Acron%3Ajob-1%3Arun%3Aabc",
    );
  });

  it("shows selected job name and sorts run history newest first", () => {
    const container = document.createElement("div");
    const job = createJob("job-1");
    render(
      renderCron(
        createProps({
          jobs: [job],
          runsJobId: "job-1",
          runs: [
            { ts: 1, jobId: "job-1", status: "ok", summary: "older run" },
            { ts: 2, jobId: "job-1", status: "ok", summary: "newer run" },
          ],
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Latest runs for Daily ping.");

    const cards = Array.from(container.querySelectorAll(".card"));
    const runHistoryCard = cards.find(
      (card) => card.querySelector(".card-title")?.textContent?.trim() === "Run history",
    );
    expect(runHistoryCard).not.toBeUndefined();

    const summaries = Array.from(
      runHistoryCard?.querySelectorAll(".list-item .list-sub") ?? [],
    ).map((el) => (el.textContent ?? "").trim());
    expect(summaries[0]).toBe("newer run");
    expect(summaries[1]).toBe("older run");
  });

  it("shows webhook delivery option in the form", () => {
    const container = document.createElement("div");
    render(
      renderCron(
        createProps({
          form: { ...DEFAULT_CRON_FORM, payloadKind: "agentTurn" },
        }),
      ),
      container,
    );

    const options = Array.from(container.querySelectorAll("option")).map((opt) =>
      (opt.textContent ?? "").trim(),
    );
    expect(options).toContain("Webhook POST");
  });

  it("normalizes stale announce selection in the form when unsupported", () => {
    const container = document.createElement("div");
    render(
      renderCron(
        createProps({
          form: {
            ...DEFAULT_CRON_FORM,
            sessionTarget: "main",
            payloadKind: "systemEvent",
            deliveryMode: "announce",
          },
        }),
      ),
      container,
    );

    const options = Array.from(container.querySelectorAll("option")).map((opt) =>
      (opt.textContent ?? "").trim(),
    );
    expect(options).not.toContain("Announce summary (default)");
    expect(options).toContain("Webhook POST");
    expect(options).toContain("None (internal)");
    expect(container.querySelector('input[placeholder="https://example.invalid/cron"]')).toBeNull();
  });

  it("shows webhook delivery details for jobs", () => {
    const container = document.createElement("div");
    const job = {
      ...createJob("job-2"),
      sessionTarget: "isolated" as const,
      payload: { kind: "agentTurn" as const, message: "do it" },
      delivery: { mode: "webhook" as const, to: "https://example.invalid/cron" },
    };
    render(
      renderCron(
        createProps({
          jobs: [job],
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Delivery");
    expect(container.textContent).toContain("webhook");
    expect(container.textContent).toContain("https://example.invalid/cron");
  });
});
