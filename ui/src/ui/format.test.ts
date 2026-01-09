import { describe, expect, it } from "vitest";

import { stripThinkingTags } from "./format";

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
});

