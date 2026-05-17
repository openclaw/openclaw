// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  extractQueryTerms,
  filterSessionsByQuery,
  normalizeUsageProviderId,
  parseToolSummary,
} from "./usage-helpers.ts";

function requireFirstTool(tools: Array<[string, number]>): [string, number] {
  const tool = tools[0];
  if (!tool) {
    throw new Error("expected parsed tool summary entry");
  }
  return tool;
}

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
    expect(matches.sessions).toEqual([session]);
  });

  it("supports numeric filters like minTokens/maxTokens", () => {
    const a = { key: "a", label: "a", usage: { totalTokens: 100, totalCost: 0 } };
    const b = { key: "b", label: "b", usage: { totalTokens: 5, totalCost: 0 } };
    expect(filterSessionsByQuery([a, b], "minTokens:10").sessions).toEqual([a]);
    expect(filterSessionsByQuery([a, b], "maxTokens:10").sessions).toEqual([b]);
  });

  it("matches provider filters against canonical provider aliases", () => {
    const session = {
      key: "alias-provider",
      label: "Alias provider",
      modelProvider: "z-ai",
      providerOverride: "aws-bedrock",
      usage: {
        totalTokens: 10,
        totalCost: 0,
        modelUsage: [{ provider: "z.ai", model: "glm-4.5", count: 1, totals: { totalTokens: 10 } }],
      },
    };

    expect(normalizeUsageProviderId("z-ai")).toBe("zai");
    expect(normalizeUsageProviderId("aws-bedrock")).toBe("amazon-bedrock");
    expect(filterSessionsByQuery([session], "provider:zai").sessions).toEqual([session]);
    expect(filterSessionsByQuery([session], "provider:z.ai").sessions).toEqual([session]);
    expect(filterSessionsByQuery([session], "provider:amazon-bedrock").sessions).toEqual([session]);
  });

  it("warns on unknown keys and invalid numbers", () => {
    const session = { key: "a", usage: { totalTokens: 10, totalCost: 0 } };
    const res = filterSessionsByQuery([session], "wat:1 minTokens:wat");
    expect(res.warnings).toEqual(["Unknown filter: wat", "Invalid number for minTokens"]);
  });

  it("parses tool summaries from compact session logs", () => {
    const res = parseToolSummary(
      "[Tool: read]\n[Tool Result]\n[Tool: exec]\n[Tool: read]\n[Tool Result]",
    );
    expect(res.summary).toBe("Tools: read×2, exec×1 (3 calls)");
    expect(res.cleanContent).toBe("");
    const firstTool = requireFirstTool(res.tools);
    expect(firstTool[0]).toBe("read");
    expect(firstTool[1]).toBe(2);
  });
});
