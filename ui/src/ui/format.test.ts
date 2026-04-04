import { describe, expect, it } from "vitest";
import { formatFullDateTime, formatRelativeTimestamp, stripThinkingTags } from "./format.ts";

describe("formatAgo", () => {
  it("returns 'in <1m' for timestamps less than 60s in the future", () => {
    expect(formatRelativeTimestamp(Date.now() + 30_000)).toBe("in <1m");
  });

  it("returns 'Xm from now' for future timestamps", () => {
    expect(formatRelativeTimestamp(Date.now() + 5 * 60_000)).toBe("in 5m");
  });

  it("returns 'Xh from now' for future timestamps", () => {
    expect(formatRelativeTimestamp(Date.now() + 3 * 60 * 60_000)).toBe("in 3h");
  });

  it("returns 'Xd from now' for future timestamps beyond 48h", () => {
    expect(formatRelativeTimestamp(Date.now() + 3 * 24 * 60 * 60_000)).toBe("in 3d");
  });

  it("returns 'Xs ago' for recent past timestamps", () => {
    expect(formatRelativeTimestamp(Date.now() - 10_000)).toBe("just now");
  });

  it("returns 'Xm ago' for past timestamps", () => {
    expect(formatRelativeTimestamp(Date.now() - 5 * 60_000)).toBe("5m ago");
  });

  it("returns 'n/a' for null/undefined", () => {
    expect(formatRelativeTimestamp(null)).toBe("n/a");
    expect(formatRelativeTimestamp(undefined)).toBe("n/a");
  });
});

describe("stripThinkingTags", () => {
  it("strips <think>…</think> segments", () => {
    const input = ["<think>", "secret", "</think>", "", "Hello"].join("\n");
    expect(stripThinkingTags(input)).toBe("Hello");
  });

  it("strips <thinking>…</thinking> segments", () => {
    const input = ["<thinking>", "secret", "</thinking>", "", "Hello"].join("\n");
    expect(stripThinkingTags(input)).toBe("Hello");
  });

  it("keeps text when tags are unpaired", () => {
    expect(stripThinkingTags("<think>\nsecret\nHello")).toBe("secret\nHello");
    expect(stripThinkingTags("Hello\n</think>")).toBe("Hello\n");
  });

  it("returns original text when no tags exist", () => {
    expect(stripThinkingTags("Hello")).toBe("Hello");
  });

  it("strips <final>…</final> segments", () => {
    const input = "<final>\n\nHello there\n\n</final>";
    expect(stripThinkingTags(input)).toBe("Hello there\n\n");
  });

  it("strips mixed <think> and <final> tags", () => {
    const input = "<think>reasoning</think>\n\n<final>Hello</final>";
    expect(stripThinkingTags(input)).toBe("Hello");
  });

  it("handles incomplete <final tag gracefully", () => {
    // When streaming splits mid-tag, we may see "<final" without closing ">"
    // This should not crash and should handle gracefully
    expect(stripThinkingTags("<final\nHello")).toBe("<final\nHello");
    expect(stripThinkingTags("Hello</final>")).toBe("Hello");
  });

  it("strips <relevant-memories> blocks", () => {
    const input = [
      "<relevant-memories>",
      "The following memories may be relevant to this conversation:",
      "- Internal memory note",
      "</relevant-memories>",
      "",
      "User-visible answer",
    ].join("\n");
    expect(stripThinkingTags(input)).toBe("User-visible answer");
  });

  it("keeps relevant-memories tags in fenced code blocks", () => {
    const input = [
      "```xml",
      "<relevant-memories>",
      "sample",
      "</relevant-memories>",
      "```",
      "",
      "Visible text",
    ].join("\n");
    expect(stripThinkingTags(input)).toBe(input);
  });

  it("hides unfinished <relevant-memories> block tails", () => {
    const input = ["Hello", "<relevant-memories>", "internal-only"].join("\n");
    expect(stripThinkingTags(input)).toBe("Hello\n");
  });
});

describe("formatFullDateTime", () => {
  it("formats a known epoch to YYYY-MM-DD HH:mm in local time", () => {
    // Use a fixed date so the test is timezone-independent: build from local parts.
    const d = new Date(2026, 2, 20, 14, 30, 0); // March 20, 2026 14:30 local
    expect(formatFullDateTime(d.getTime())).toBe("2026-03-20 14:30");
  });

  it("zero-pads single-digit months and days", () => {
    const d = new Date(2026, 0, 5, 9, 3, 0); // Jan 5, 2026 09:03 local
    expect(formatFullDateTime(d.getTime())).toBe("2026-01-05 09:03");
  });

  it("returns fallback for null", () => {
    expect(formatFullDateTime(null)).toBe("n/a");
  });

  it("returns fallback for undefined", () => {
    expect(formatFullDateTime(undefined)).toBe("n/a");
  });

  it("returns custom fallback when provided", () => {
    expect(formatFullDateTime(null, "—")).toBe("—");
  });

  it("returns fallback for NaN", () => {
    expect(formatFullDateTime(NaN)).toBe("n/a");
  });

  it("returns fallback for epoch 0 (unset sentinel)", () => {
    expect(formatFullDateTime(0)).toBe("n/a");
  });

  it("returns fallback for negative epoch values", () => {
    expect(formatFullDateTime(-1)).toBe("n/a");
    expect(formatFullDateTime(-1_000_000)).toBe("n/a");
  });
});
