import { describe, expect, it } from "vitest";
import { formatRelativeTimestamp, parseSessionKeyParts, stripThinkingTags } from "./format.ts";

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

describe("parseSessionKeyParts", () => {
  it("parses a standard agent session key", () => {
    expect(parseSessionKeyParts("agent:data-expert:dingtalk:cidzg6sF43NZMy52Rnk8EN")).toEqual({
      agentId: "data-expert",
      channel: "dingtalk",
      accountId: "cidzg6sF43NZMy52Rnk8EN",
    });
  });

  it("parses a key with special characters in accountId", () => {
    expect(parseSessionKeyParts("agent:code-prince:dingtalk:cidtYWov/AQ==")).toEqual({
      agentId: "code-prince",
      channel: "dingtalk",
      accountId: "cidtYWov/AQ==",
    });
  });

  it("parses a key with colons in accountId", () => {
    expect(parseSessionKeyParts("agent:main:telegram:user:12345:extra")).toEqual({
      agentId: "main",
      channel: "telegram",
      accountId: "user:12345:extra",
    });
  });

  it("returns null for non-agent keys", () => {
    expect(parseSessionKeyParts("global:default")).toBeNull();
    expect(parseSessionKeyParts("direct:some-key")).toBeNull();
    expect(parseSessionKeyParts("")).toBeNull();
  });

  it("returns null for malformed agent keys missing channel or accountId", () => {
    expect(parseSessionKeyParts("agent:")).toBeNull();
    expect(parseSessionKeyParts("agent:main")).toBeNull();
    expect(parseSessionKeyParts("agent:main:")).toBeNull();
  });

  it("returns null for agent key with only agentId and channel but no accountId", () => {
    expect(parseSessionKeyParts("agent:main:telegram")).toBeNull();
  });
});
