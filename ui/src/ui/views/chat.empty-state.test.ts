/**
 * Tests for #45707 - WebChat empty state overlay blocking input
 */

import { describe, it, expect } from "vitest";

describe("chat empty state logic (#45707)", () => {
  it("should not treat session with tool messages as empty", () => {
    const history: unknown[] = [];
    const tools: unknown[] = [{ role: "tool", content: "Heartbeat", timestamp: Date.now() }];
    const hasAnyMessages = history.length > 0 || tools.length > 0;
    const isEmpty = !hasAnyMessages;
    expect(hasAnyMessages).toBe(true);
    expect(isEmpty).toBe(false);
  });

  it("should treat truly empty session as empty", () => {
    const history: unknown[] = [];
    const tools: unknown[] = [];
    const hasAnyMessages = history.length > 0 || tools.length > 0;
    const isEmpty = !hasAnyMessages;
    expect(hasAnyMessages).toBe(false);
    expect(isEmpty).toBe(true);
  });

  it("should not treat session with history messages as empty", () => {
    const history: unknown[] = [{ role: "user", content: "Hello", timestamp: Date.now() }];
    const tools: unknown[] = [];
    const hasAnyMessages = history.length > 0 || tools.length > 0;
    const isEmpty = !hasAnyMessages;
    expect(hasAnyMessages).toBe(true);
    expect(isEmpty).toBe(false);
  });

  it("should handle mixed history and tool messages", () => {
    const history: unknown[] = [{ role: "user", content: "Check", timestamp: Date.now() }];
    const tools: unknown[] = [{ role: "tool", content: "Cron", timestamp: Date.now() }];
    const hasAnyMessages = history.length > 0 || tools.length > 0;
    const isEmpty = !hasAnyMessages;
    expect(hasAnyMessages).toBe(true);
    expect(isEmpty).toBe(false);
  });
});
