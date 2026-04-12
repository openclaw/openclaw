import { describe, expect, it } from "vitest";
import { formatMs } from "./format.ts";
import { formatCronSchedule } from "./presenter.ts";
import type { CronJob } from "./types.ts";

function createJob(schedule: CronJob["schedule"]): CronJob {
  return {
    id: "job-1",
    name: "Cron job",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule,
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "ping" },
    state: {},
  };
}

describe("presenter cron schedule formatting", () => {
  it("does not reinterpret cron-like at strings as timestamps", () => {
    expect(formatCronSchedule(createJob({ kind: "at", at: "0 */6 * * *" }))).toBe("At 0 */6 * * *");
  });

  it("formats valid at timestamps as dates", () => {
    const at = "2026-04-12T18:30:00Z";
    expect(formatCronSchedule(createJob({ kind: "at", at }))).toBe(
      `At ${formatMs(Date.parse(at))}`,
    );
  });
});
