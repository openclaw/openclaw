// Control UI tests cover session display behavior.
import { describe, expect, it } from "vitest";
import {
  parseSessionKey,
  resolveSessionDisplayName,
  shortenSessionKeyForCell,
} from "./session-display.ts";

describe("parseSessionKey", () => {
  it("identifies main session", () => {
    const result = parseSessionKey("main");
    expect(result.prefix).toBe("");
    expect(result.fallbackName).toBe("Main Session");
  });

  it("identifies main session in agent format", () => {
    const result = parseSessionKey("agent:main:main");
    expect(result.fallbackName).toBe("Main Session");
  });

  it("identifies subagent sessions", () => {
    const result = parseSessionKey("agent:main:main:subagent:worker-1");
    expect(result.prefix).toBe("Subagent:");
  });

  it("identifies cron sessions", () => {
    const result = parseSessionKey("cron:daily-report");
    expect(result.prefix).toBe("Cron:");
  });

  it("identifies direct chat sessions with known channel", () => {
    const result = parseSessionKey("agent:main:feishu:direct:ou_user123");
    expect(result.prefix).toBe("");
    expect(result.fallbackName).toBe("Feishu · ou_user123");
  });

  it("preserves full long identifiers in parseSessionKey (canonical behavior)", () => {
    const longId = "ou_67075ec667cac0a7feae2c5094fd27b2";
    const key = `agent:main:feishu:direct:${longId}`;
    const result = parseSessionKey(key);
    // parseSessionKey should return FULL identifier (canonical)
    expect(result.fallbackName).toBe(`Feishu · ${longId}`);
    expect(result.fallbackName).toContain(longId);
  });

  it("preserves full long user_id identifiers in parseSessionKey", () => {
    const longId = "user_1234567890abcdef1234567890abcdef";
    const key = `agent:main:feishu:direct:${longId}`;
    const result = parseSessionKey(key);
    expect(result.fallbackName).toBe(`Feishu · ${longId}`);
    expect(result.fallbackName).toContain(longId);
  });

  it("preserves short identifiers as-is", () => {
    const result = parseSessionKey("agent:main:telegram:direct:user_123");
    expect(result.fallbackName).toContain("user_123");
  });

  it("handles direct sessions with unknown channel prefix", () => {
    const result = parseSessionKey("agent:main:unknown-channel:direct:user_123");
    expect(result.fallbackName).toMatch(/^Unknown-channel · /i);
  });

  it("handles group sessions", () => {
    const result = parseSessionKey("agent:main:telegram:group:g-12345");
    expect(result.fallbackName).toBe("Telegram Group");
  });

  it("handles legacy channel-prefixed keys", () => {
    const result = parseSessionKey("imessage:g-foo");
    expect(result.fallbackName).toBe("iMessage Session");
  });

  it("returns key as-is for unknown formats", () => {
    const result = parseSessionKey("some-weird-key-format");
    expect(result.fallbackName).toBe("some-weird-key-format");
  });
});

describe("shortenSessionKeyForCell", () => {
  it("preserves short identifiers (≤20 chars) as-is", () => {
    const result = shortenSessionKeyForCell("agent:main:feishu:direct:ou_user123");
    expect(result).toBe("Feishu · ou_user123");
  });

  it("truncates long identifiers (>20 chars)", () => {
    const longId = "ou_67075ec667cac0a7feae2c5094fd27b2";
    const key = `agent:main:feishu:direct:${longId}`;
    const result = shortenSessionKeyForCell(key);
    // Should truncate: first 6 + "..." + last 4
    expect(result).toBe("Feishu · ou_670...27b2");
    expect(result.length).toBeLessThan(key.length);
    expect(result).not.toContain(longId);
  });

  it("truncates long telegram identifiers", () => {
    const longId = "user_1234567890abcdef1234567890abcdef";
    const key = `agent:main:telegram:direct:${longId}`;
    const result = shortenSessionKeyForCell(key);
    expect(result).toBe("Telegram · user_1...cdef");
    expect(result.length).toBeLessThan(key.length);
  });

  it("handles non-direct keys via parseSessionKey", () => {
    // Main session
    const mainResult = shortenSessionKeyForCell("main");
    expect(mainResult).toBe("Main Session");

    // Subagent
    const subagentResult = shortenSessionKeyForCell("agent:main:main:subagent:worker-1");
    expect(subagentResult).toContain("Subagent");

    // Cron
    const cronResult = shortenSessionKeyForCell("cron:daily-report");
    expect(cronResult).toContain("Cron");

    // Group
    const groupResult = shortenSessionKeyForCell("agent:main:telegram:group:g-12345");
    expect(groupResult).toBe("Telegram Group");
  });

  it("handles unknown channel", () => {
    const result = shortenSessionKeyForCell("agent:main:unknown-channel:direct:user_123");
    expect(result).toMatch(/^Unknown-channel · /i);
  });
});

describe("resolveSessionDisplayName", () => {
  it("uses label when available", () => {
    const result = resolveSessionDisplayName("agent:main:feishu:direct:ou_user123", {
      key: "agent:main:feishu:direct:ou_user123",
      label: "税务师",
    } as any);
    expect(result).toBe("税务师");
  });

  it("uses displayName when label is unavailable", () => {
    const result = resolveSessionDisplayName("agent:main:feishu:direct:ou_user123", {
      key: "agent:main:feishu:direct:ou_user123",
      displayName: "Feishu DM",
    } as any);
    expect(result).toBe("Feishu DM");
  });

  it("falls back to parseSessionKey when no label or displayName", () => {
    const result = resolveSessionDisplayName("agent:main:feishu:direct:ou_user123", {
      key: "agent:main:feishu:direct:ou_user123",
    } as any);
    expect(result).toBe("Feishu · ou_user123");
  });

  it("applies typed prefix for subagent sessions", () => {
    const result = resolveSessionDisplayName("agent:main:main:subagent:worker-1", {
      key: "agent:main:main:subagent:worker-1",
    } as any);
    expect(result).toContain("Subagent");
  });
});
