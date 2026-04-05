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

  it("filters by context inspector source and truncation severity", () => {
    const run = {
      key: "run",
      contextWeight: { source: "run", truncationSeverity: "medium" },
      usage: { totalTokens: 10, totalCost: 0 },
    };
    const estimate = {
      key: "estimate",
      contextWeight: { source: "estimate", truncationSeverity: "none" },
      usage: { totalTokens: 10, totalCost: 0 },
    };

    expect(filterSessionsByQuery([run, estimate], "source:run").sessions).toEqual([run]);
    expect(filterSessionsByQuery([run, estimate], "truncation:medium").sessions).toEqual([run]);
  });

  it("supports has:tracked and has:truncation", () => {
    const tracked = {
      key: "tracked",
      contextWeight: {
        source: "run",
        tracked: { estimatedTokens: 255 },
        truncationSeverity: "low",
      },
      usage: { totalTokens: 10, totalCost: 0 },
    };
    const plain = {
      key: "plain",
      contextWeight: { source: "estimate", truncationSeverity: "none" },
      usage: { totalTokens: 10, totalCost: 0 },
    };

    expect(filterSessionsByQuery([tracked, plain], "has:tracked").sessions).toEqual([tracked]);
    expect(filterSessionsByQuery([tracked, plain], "has:truncation").sessions).toEqual([tracked]);
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
});
