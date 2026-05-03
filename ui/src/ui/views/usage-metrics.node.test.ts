import { afterEach, describe, expect, it } from "vitest";
import { formatDayLabel, formatFullDate } from "./usage-metrics.ts";

describe("usage date labels", () => {
  const originalTimeZone = process.env.TZ;

  afterEach(() => {
    if (originalTimeZone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTimeZone;
    }
  });

  it("does not shift YYYY-MM-DD buckets backward in time zones west of UTC", () => {
    process.env.TZ = "America/Sao_Paulo";

    expect(formatDayLabel("2026-04-22")).toContain("22");
    expect(formatFullDate("2026-04-22")).toContain("22");
    expect(formatFullDate("2026-04-22")).toContain("2026");
  });
});
