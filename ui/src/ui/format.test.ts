import { describe, expect, it } from "vitest";
import { formatRelativeTimestamp, stripThinkingTags } from "./format.ts";

describe("formatAgo", () => {
  it("formats relative timestamps across future/past/null cases", () => {
    const now = Date.now();
    const cases = [
      { name: "<1m future", input: now + 30_000, expected: "in <1m" },
      { name: "minutes future", input: now + 5 * 60_000, expected: "in 5m" },
      { name: "hours future", input: now + 3 * 60 * 60_000, expected: "in 3h" },
      { name: "days future", input: now + 3 * 24 * 60 * 60_000, expected: "in 3d" },
      { name: "recent past", input: now - 10_000, expected: "just now" },
      { name: "minutes past", input: now - 5 * 60_000, expected: "5m ago" },
      { name: "null", input: null, expected: "n/a" },
      { name: "undefined", input: undefined, expected: "n/a" },
    ] as const;
    for (const testCase of cases) {
      expect(formatRelativeTimestamp(testCase.input), testCase.name).toBe(testCase.expected);
    }
  });
});

describe("stripThinkingTags", () => {
  it("normalizes think/final tag variants", () => {
    const cases = [
      {
        name: "strip think block",
        input: ["<think>", "secret", "</think>", "", "Hello"].join("\n"),
        expected: "Hello",
      },
      {
        name: "strip thinking block",
        input: ["<thinking>", "secret", "</thinking>", "", "Hello"].join("\n"),
        expected: "Hello",
      },
      {
        name: "unpaired think start",
        input: "<think>\nsecret\nHello",
        expected: "secret\nHello",
      },
      {
        name: "unpaired think end",
        input: "Hello\n</think>",
        expected: "Hello\n",
      },
      {
        name: "no tags",
        input: "Hello",
        expected: "Hello",
      },
      {
        name: "strip final block",
        input: "<final>\n\nHello there\n\n</final>",
        expected: "Hello there\n\n",
      },
      {
        name: "strip mixed think/final",
        input: "<think>reasoning</think>\n\n<final>Hello</final>",
        expected: "Hello",
      },
      {
        name: "incomplete final start",
        input: "<final\nHello",
        expected: "<final\nHello",
      },
      {
        name: "orphan final end",
        input: "Hello</final>",
        expected: "Hello",
      },
    ] as const;
    for (const testCase of cases) {
      expect(stripThinkingTags(testCase.input), testCase.name).toBe(testCase.expected);
    }
  });
});
