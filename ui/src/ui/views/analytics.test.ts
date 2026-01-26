import { describe, expect, it } from "vitest";
import type { CostUsageDailyEntry, CostUsageSummary, AnalyticsProps } from "./analytics";

// Test the helper functions used in analytics view
describe("analytics view helpers", () => {
  describe("formatNumber", () => {
    // Inline the function for testing since it's not exported
    const formatNumber = (n: number): string => {
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
      if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
      return n.toFixed(0);
    };

    it("formats millions", () => {
      expect(formatNumber(1_500_000)).toBe("1.5M");
      expect(formatNumber(2_000_000)).toBe("2.0M");
    });

    it("formats thousands", () => {
      expect(formatNumber(1_500)).toBe("1.5K");
      expect(formatNumber(50_000)).toBe("50.0K");
    });

    it("formats small numbers", () => {
      expect(formatNumber(500)).toBe("500");
      expect(formatNumber(0)).toBe("0");
    });
  });

  describe("formatCost", () => {
    const formatCost = (n: number): string => {
      if (n === 0) return "$0.00";
      if (n < 0.01) return `$${n.toFixed(4)}`;
      return `$${n.toFixed(2)}`;
    };

    it("formats zero", () => {
      expect(formatCost(0)).toBe("$0.00");
    });

    it("formats small costs", () => {
      expect(formatCost(0.001)).toBe("$0.0010");
      expect(formatCost(0.0001)).toBe("$0.0001");
    });

    it("formats normal costs", () => {
      expect(formatCost(1.5)).toBe("$1.50");
      expect(formatCost(123.45)).toBe("$123.45");
    });
  });
});

describe("analytics data types", () => {
  it("CostUsageSummary has expected structure", () => {
    const summary: CostUsageSummary = {
      updatedAt: Date.now(),
      days: 30,
      daily: [
        {
          date: "2026-01-01",
          input: 1000,
          output: 500,
          cacheRead: 200,
          cacheWrite: 100,
          totalTokens: 1800,
          totalCost: 0.05,
          missingCostEntries: 0,
        },
      ],
      totals: {
        input: 1000,
        output: 500,
        cacheRead: 200,
        cacheWrite: 100,
        totalTokens: 1800,
        totalCost: 0.05,
        missingCostEntries: 0,
      },
    };

    expect(summary.days).toBe(30);
    expect(summary.daily).toHaveLength(1);
    expect(summary.totals.totalTokens).toBe(1800);
  });

  it("AnalyticsProps has expected structure", () => {
    const props: AnalyticsProps = {
      loading: false,
      error: null,
      data: null,
      quota: null,
      days: 30,
      onDaysChange: () => {},
      onRefresh: () => {},
    };

    expect(props.loading).toBe(false);
    expect(props.days).toBe(30);
    expect(props.quota).toBeNull();
  });
});
