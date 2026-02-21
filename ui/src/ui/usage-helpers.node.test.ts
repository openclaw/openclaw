import { describe, expect, it } from "vitest";
import { extractQueryTerms, filterSessionsByQuery, parseToolSummary } from "./usage-helpers.ts";

describe("usage-helpers", () => {
  it("tokenizes query terms including quoted strings", () => {
    const terms = extractQueryTerms('agent:main "model:gpt-5.2" has:errors');
    expect(terms.map((t) => t.raw)).toEqual(["agent:main", "model:gpt-5.2", "has:errors"]);
  });

  it("matches key: glob filters against session keys", () => {
    const session = {
      key: "agent:main:cron:16234bc?token=dev-token",
      label: "agent:main:cron:16234bc?token=dev-token",
      usage: { totalTokens: 100, totalCost: 0 },
    };
    const matches = filterSessionsByQuery([session], "key:agent:main:cron*");
    expect(matches.sessions).toHaveLength(1);
  });

  it("supports numeric filters like minTokens/maxTokens", () => {
    const a = { key: "a", label: "a", usage: { totalTokens: 100, totalCost: 0 } };
    const b = { key: "b", label: "b", usage: { totalTokens: 5, totalCost: 0 } };
    expect(filterSessionsByQuery([a, b], "minTokens:10").sessions).toEqual([a]);
    expect(filterSessionsByQuery([a, b], "maxTokens:10").sessions).toEqual([b]);
  });

  it("warns on unknown keys and invalid numbers", () => {
    const session = { key: "a", usage: { totalTokens: 10, totalCost: 0 } };
    const res = filterSessionsByQuery([session], "wat:1 minTokens:wat");
    expect(res.warnings.some((w) => w.includes("Unknown filter"))).toBe(true);
    expect(res.warnings.some((w) => w.includes("Invalid number"))).toBe(true);
  });

  it("parses tool summaries from compact session logs", () => {
    const res = parseToolSummary(
      "[Tool: read]\n[Tool Result]\n[Tool: exec]\n[Tool: read]\n[Tool Result]",
    );
    expect(res.summary).toContain("read");
    expect(res.summary).toContain("exec");
    expect(res.tools[0]?.[0]).toBe("read");
    expect(res.tools[0]?.[1]).toBe(2);
  });

  it("handles null/undefined agentId when filtering by agent name", () => {
    const sessionWithAgent = {
      key: "session-1",
      agentId: "test-agent",
      usage: { totalTokens: 100, totalCost: 0 },
    };
    const sessionWithoutAgent = {
      key: "session-2",
      agentId: undefined,
      usage: { totalTokens: 50, totalCost: 0 },
    };
    const sessionWithNullAgent = {
      key: "session-3",
      agentId: null,
      usage: { totalTokens: 75, totalCost: 0 },
    };

    // Should not crash when filtering sessions with null/undefined agentIds
    const result = filterSessionsByQuery(
      [sessionWithAgent, sessionWithoutAgent, sessionWithNullAgent],
      "agent:test",
    );
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.key).toBe("session-1");
  });

  it("handles null/undefined channel, chatType, and label in filters", () => {
    const sessionWithNulls = {
      key: "session-null",
      channel: null,
      chatType: undefined,
      label: null,
      usage: { totalTokens: 50, totalCost: 0 },
    };
    const sessionWithValues = {
      key: "session-values",
      channel: "telegram",
      chatType: "dm",
      label: "Test Session",
      usage: { totalTokens: 100, totalCost: 0 },
    };

    // None of these should crash
    expect(() => filterSessionsByQuery([sessionWithNulls], "channel:telegram")).not.toThrow();
    expect(() => filterSessionsByQuery([sessionWithNulls], "chat:dm")).not.toThrow();
    expect(() => filterSessionsByQuery([sessionWithNulls], "label:test")).not.toThrow();

    // Should filter correctly
    expect(
      filterSessionsByQuery([sessionWithNulls, sessionWithValues], "channel:telegram").sessions,
    ).toHaveLength(1);
    expect(
      filterSessionsByQuery([sessionWithNulls, sessionWithValues], "channel:telegram").sessions[0]
        ?.key,
    ).toBe("session-values");
  });

  it("handles null/undefined sessionId in session/id filter", () => {
    const sessionWithoutSessionId = {
      key: "session-key-1",
      sessionId: undefined,
      usage: { totalTokens: 50, totalCost: 0 },
    };
    const sessionWithNullSessionId = {
      key: "session-key-2",
      sessionId: null,
      usage: { totalTokens: 75, totalCost: 0 },
    };
    const sessionWithSessionId = {
      key: "session-key-3",
      sessionId: "abc-123-def",
      usage: { totalTokens: 100, totalCost: 0 },
    };

    // Should not crash when filtering sessions with null/undefined sessionIds
    expect(() =>
      filterSessionsByQuery([sessionWithoutSessionId, sessionWithNullSessionId], "session:abc"),
    ).not.toThrow();
    expect(() =>
      filterSessionsByQuery([sessionWithoutSessionId, sessionWithNullSessionId], "id:abc"),
    ).not.toThrow();

    // Should filter correctly and only match the session with the sessionId
    const result = filterSessionsByQuery(
      [sessionWithoutSessionId, sessionWithNullSessionId, sessionWithSessionId],
      "session:abc",
    );
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.sessionId).toBe("abc-123-def");
  });
});
