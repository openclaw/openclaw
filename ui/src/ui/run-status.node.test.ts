import { describe, expect, it } from "vitest";
import {
  formatStatusBarReasoningLabel,
  formatTickerReasoningLabel,
  resolveRunPhaseLabel,
  resolveRunPhaseSuffixLabel,
} from "./run-status.ts";

describe("run status reasoning labels", () => {
  it("formats Auto -> High for status bar", () => {
    expect(formatStatusBarReasoningLabel({ configured: "auto", effective: "high" })).toBe(
      "Auto -> High",
    );
  });

  it("formats Manual: Deep for status bar", () => {
    expect(formatStatusBarReasoningLabel({ configured: "high", effective: "high" })).toBe(
      "Manual: Deep",
    );
  });

  it("falls back to Default when reasoning tiers are unavailable", () => {
    expect(formatStatusBarReasoningLabel({ configured: null, effective: null })).toBe("Default");
    expect(formatTickerReasoningLabel({ configured: "off", effective: null })).toBe("Default");
  });

  it("resolves configured phase ids via data-driven labels", () => {
    expect(resolveRunPhaseLabel("lifecycle.start")).toBe("planning");
    expect(resolveRunPhaseLabel("tool.result")).toBe("reviewing");
  });

  it("falls back to processing only when phase metadata is missing", () => {
    expect(resolveRunPhaseLabel(null)).toBe("processing");
    expect(resolveRunPhaseLabel("custom.new_phase")).toBe("phase");
  });

  it("resolves phase suffix labels from configured map", () => {
    expect(resolveRunPhaseSuffixLabel("retrying")).toBe("retrying");
    expect(resolveRunPhaseSuffixLabel("error")).toBe("error");
  });
});
