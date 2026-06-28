// @vitest-environment node
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../../../../src/test-utils/env.js";
import { formatDayLabel, formatFullDate } from "./usage-metrics.ts";

describe("usage metrics date labels", () => {
  it("formats YYYY-MM-DD values as stable calendar dates in negative UTC offsets", async () => {
    await withEnvAsync({ TZ: "America/Los_Angeles" }, async () => {
      const date = new Date(2026, 1, 1);
      expect(formatDayLabel("2026-02-01")).toBe(
        date.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      );
      expect(formatFullDate("2026-02-01")).toBe(
        date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }),
      );
    });
  });

  it("leaves invalid day labels unchanged", () => {
    expect(formatDayLabel("2026-02-31")).toBe("2026-02-31");
    expect(formatFullDate("2026-02-31")).toBe("2026-02-31");
  });
});
