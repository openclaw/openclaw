import { describe, expect, it } from "vitest";
import { shouldUseDailyTotalsForDisplay } from "./usage.ts";

describe("shouldUseDailyTotalsForDisplay", () => {
  it("uses daily totals for a pure day filter", () => {
    expect(
      shouldUseDailyTotalsForDisplay({
        selectedSessions: [],
        selectedDays: ["2026-02-01"],
        selectedHours: [],
        hasQuery: false,
      }),
    ).toBe(true);
  });

  it("keeps daily totals when a query further narrows a day filter", () => {
    expect(
      shouldUseDailyTotalsForDisplay({
        selectedSessions: [],
        selectedDays: ["2026-02-01"],
        selectedHours: [],
        hasQuery: true,
      }),
    ).toBe(true);
  });
});
