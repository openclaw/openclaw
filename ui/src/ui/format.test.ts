import { describe, expect, it } from "vitest";
import {
  describeCronExpression,
  formatRelativeTimestamp,
  formatUnknownText,
  stripThinkingTags,
} from "./format.ts";

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

describe("describeCronExpression", () => {
  it("describes every-N-minutes patterns", () => {
    expect(describeCronExpression("*/5 * * * *")).toBe("Every 5 minutes");
    expect(describeCronExpression("*/15 * * * *")).toBe("Every 15 minutes");
  });

  it("describes every-minute pattern", () => {
    expect(describeCronExpression("* * * * *")).toBe("Every minute");
    expect(describeCronExpression("*/1 * * * *")).toBe("Every minute");
  });

  it("describes every-N-hours patterns", () => {
    expect(describeCronExpression("0 */6 * * *")).toBe("Every 6 hours");
    expect(describeCronExpression("0 */2 * * *")).toBe("Every 2 hours");
    expect(describeCronExpression("0 */1 * * *")).toBe("Every hour");
  });

  it("describes every-hour-at-minute patterns", () => {
    expect(describeCronExpression("30 * * * *")).toBe("Every hour at :30");
  });

  it("describes daily-at-time patterns", () => {
    expect(describeCronExpression("0 3 * * *")).toBe("Daily at 3:00 AM");
    expect(describeCronExpression("0 15 * * *")).toBe("Daily at 3:00 PM");
    expect(describeCronExpression("30 0 * * *")).toBe("Daily at 12:30 AM");
    expect(describeCronExpression("0 12 * * *")).toBe("Daily at 12:00 PM");
  });

  it("describes weekly patterns", () => {
    expect(describeCronExpression("0 5 * * 0")).toBe("Weekly Sun at 5:00 AM");
    expect(describeCronExpression("0 9 * * 1")).toBe("Weekly Mon at 9:00 AM");
    expect(describeCronExpression("30 14 * * 5")).toBe("Weekly Fri at 2:30 PM");
  });

  it("treats day-of-week 7 as Sunday", () => {
    expect(describeCronExpression("0 5 * * 7")).toBe("Weekly Sun at 5:00 AM");
  });

  it("falls back for step-zero expressions", () => {
    expect(describeCronExpression("*/0 * * * *")).toBe("*/0 * * * *");
    expect(describeCronExpression("0 */0 * * *")).toBe("0 */0 * * *");
  });

  it("falls back to raw expression for complex patterns", () => {
    expect(describeCronExpression("0 0 1 * *")).toBe("0 0 1 * *");
    expect(describeCronExpression("0 0 * * 1-5")).toBe("0 0 * * 1-5");
    expect(describeCronExpression("*/5 */2 * * *")).toBe("*/5 */2 * * *");
  });

  it("returns raw string for non-standard field counts", () => {
    expect(describeCronExpression("0 0 * *")).toBe("0 0 * *");
    expect(describeCronExpression("0 0 * * * *")).toBe("0 0 * * * *");
  });

  it("returns empty string for empty input", () => {
    expect(describeCronExpression("")).toBe("");
  });
});

describe("formatUnknownText", () => {
  it("stringifies plain objects without throwing", () => {
    expect(formatUnknownText({ ok: true })).toBe('{"ok":true}');
  });

  it("falls back to object tags for non-serializable values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatUnknownText(circular)).toBe("[object Object]");
  });

  it("formats symbols without relying on object coercion", () => {
    expect(formatUnknownText(Symbol("agent"))).toBe("Symbol(agent)");
  });
});
