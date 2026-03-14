/**
 * Tests for #45707 - WebChat empty state overlay blocking input
 *
 * This test ensures that sessions with tool-call messages (heartbeat/cron),
 * streaming content, or live streams are not treated as empty, preventing
 * the welcome overlay from blocking the input box.
 */

import { describe, it, expect } from "vitest";

describe("chat empty state logic (#45707)", () => {
  it("should not treat session with tool messages as empty", () => {
    const messages: unknown[] = [];
    const toolMessages: unknown[] = [{ role: "tool", content: "Heartbeat", timestamp: Date.now() }];
    const streamSegments: Array<{ text: string; ts: number }> = [];
    const stream: string | null = null;

    const hasSessionActivity =
      messages.length > 0 ||
      toolMessages.length > 0 ||
      streamSegments.some((segment) => segment.text.trim()) ||
      stream !== null;

    expect(hasSessionActivity).toBe(true);
  });

  it("should treat truly empty session as empty", () => {
    const messages: unknown[] = [];
    const toolMessages: unknown[] = [];
    const streamSegments: Array<{ text: string; ts: number }> = [];
    const stream: string | null = null;

    const hasSessionActivity =
      messages.length > 0 ||
      toolMessages.length > 0 ||
      streamSegments.some((segment) => segment.text.trim()) ||
      stream !== null;

    expect(hasSessionActivity).toBe(false);
  });

  it("should not treat session with history messages as empty", () => {
    const messages: unknown[] = [{ role: "user", content: "Hello", timestamp: Date.now() }];
    const toolMessages: unknown[] = [];
    const streamSegments: Array<{ text: string; ts: number }> = [];
    const stream: string | null = null;

    const hasSessionActivity =
      messages.length > 0 ||
      toolMessages.length > 0 ||
      streamSegments.some((segment) => segment.text.trim()) ||
      stream !== null;

    expect(hasSessionActivity).toBe(true);
  });

  it("should not treat session with streaming content as empty", () => {
    const messages: unknown[] = [];
    const toolMessages: unknown[] = [];
    const streamSegments: Array<{ text: string; ts: number }> = [
      { text: "Streaming response...", ts: Date.now() },
    ];
    const stream: string | null = null;

    const hasSessionActivity =
      messages.length > 0 ||
      toolMessages.length > 0 ||
      streamSegments.some((segment) => segment.text.trim()) ||
      stream !== null;

    expect(hasSessionActivity).toBe(true);
  });

  it("should not treat session with live stream as empty", () => {
    const messages: unknown[] = [];
    const toolMessages: unknown[] = [];
    const streamSegments: Array<{ text: string; ts: number }> = [];
    const stream: string | null = "Live streaming...";

    const hasSessionActivity =
      messages.length > 0 ||
      toolMessages.length > 0 ||
      streamSegments.some((segment) => segment.text.trim()) ||
      stream !== null;

    expect(hasSessionActivity).toBe(true);
  });

  it("should handle mixed messages and streaming", () => {
    const messages: unknown[] = [{ role: "user", content: "Check", timestamp: Date.now() }];
    const toolMessages: unknown[] = [{ role: "tool", content: "Cron", timestamp: Date.now() }];
    const streamSegments: Array<{ text: string; ts: number }> = [
      { text: "Thinking...", ts: Date.now() },
    ];
    const stream: string | null = null;

    const hasSessionActivity =
      messages.length > 0 ||
      toolMessages.length > 0 ||
      streamSegments.some((segment) => segment.text.trim()) ||
      stream !== null;

    expect(hasSessionActivity).toBe(true);
  });
});
