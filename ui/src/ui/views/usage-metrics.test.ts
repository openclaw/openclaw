import { describe, it, expect } from "vitest";
import { formatCost } from "./usage-metrics.ts";

describe("usage-metrics.formatCost", () => {
  it("keeps explicit precision when decimals are provided", () => {
    expect(formatCost(0.004, 2)).toBe("$0.00");
    expect(formatCost(0.004, 4)).toBe("$0.0040");
  });

  it("uses higher precision by default for very small costs", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.004)).toBe("$0.0040");
  });

  it("rounds normally for typical costs", () => {
    // Matches ui/src/ui/format.ts: < 1 keeps 3 decimals (0.03 -> $0.030)
    expect(formatCost(0.03)).toBe("$0.030");
    expect(formatCost(1.2345)).toBe("$1.23");
  });

  it("falls back for non-finite numbers", () => {
    expect(formatCost(Number.NaN)).toBe("$0.00");
    expect(formatCost(Number.POSITIVE_INFINITY)).toBe("$0.00");
    expect(formatCost(Number.NEGATIVE_INFINITY)).toBe("$0.00");
    // Also ensure the explicit-decimals branch does not surface `$NaN`.
    expect(formatCost(Number.NaN, 4)).toBe("$0.00");
  });
});
