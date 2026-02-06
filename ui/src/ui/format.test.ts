import { describe, expect, it } from "vitest";
import { formatAgo, stripThinkingTags } from "./format.ts";

describe("formatAgo", () => {
  it("returns 'just now' for timestamps less than 60s in the future", () => {
    expect(formatAgo(Date.now() + 30_000)).toBe("just now");
  });

  it("returns 'Xm from now' for future timestamps", () => {
    expect(formatAgo(Date.now() + 5 * 60_000)).toBe("5m from now");
  });

  it("returns 'Xh from now' for future timestamps", () => {
    expect(formatAgo(Date.now() + 3 * 60 * 60_000)).toBe("3h from now");
  });

  it("returns 'Xd from now' for future timestamps beyond 48h", () => {
    expect(formatAgo(Date.now() + 3 * 24 * 60 * 60_000)).toBe("3d from now");
  });

  it("returns 'Xs ago' for recent past timestamps", () => {
    expect(formatAgo(Date.now() - 10_000)).toBe("10s ago");
  });

  it("returns 'Xm ago' for past timestamps", () => {
    expect(formatAgo(Date.now() - 5 * 60_000)).toBe("5m ago");
  });

  it("returns 'n/a' for null/undefined", () => {
    expect(formatAgo(null)).toBe("n/a");
    expect(formatAgo(undefined)).toBe("n/a");
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
});
