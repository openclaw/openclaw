import { describe, expect, it } from "vitest";
import { formatCronSchedule } from "./presenter.ts";
import type { CronJob } from "./types.ts";

function cronSchedule(expr: string, tz?: string): CronJob {
  return {
    id: "job-1",
    name: "Job",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "cron", expr, tz },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "ping" },
  };
}

describe("formatCronSchedule", () => {
  it("formats common hourly cron intervals as human-readable intervals", () => {
    expect(formatCronSchedule(cronSchedule("0 * * * *"))).toBe("Every 1 hour");
    expect(formatCronSchedule(cronSchedule("0 */6 * * *"))).toBe("Every 6 hours");
    expect(formatCronSchedule(cronSchedule("0 */1 * * *", "UTC"))).toBe("Every 1 hour (UTC)");
  });

  it("formats common minute cron intervals as human-readable intervals", () => {
    expect(formatCronSchedule(cronSchedule("*/5 * * * *"))).toBe("Every 5 minutes");
  });

  it("keeps unsupported cron expressions on the raw cron fallback", () => {
    expect(formatCronSchedule(cronSchedule("15 3 * * 1"))).toBe("Cron 15 3 * * 1");
  });
});
