// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  addQueryToken,
  buildQuerySuggestions,
  buildSessionsCsv,
  removeQueryToken,
} from "./usage-query.ts";
import type { UsageAggregates, UsageSessionEntry } from "./usageTypes.ts";

describe("usage-query provider canonicalization", () => {
  it("uses canonical provider ids in usage CSV exports", () => {
    const sessions = [
      {
        key: "s1",
        label: "Session one",
        modelProvider: "z-ai",
        model: "glm-4.5",
        usage: { totalTokens: 10, totalCost: 0.01 },
      } as UsageSessionEntry,
      {
        key: "s2",
        label: "Session two",
        providerOverride: "aws-bedrock",
        model: "claude-3.5",
        usage: { totalTokens: 20, totalCost: 0.02 },
      } as UsageSessionEntry,
    ];

    const csv = buildSessionsCsv(sessions);

    expect(csv).toContain("zai");
    expect(csv).toContain("amazon-bedrock");
    expect(csv).not.toContain("z-ai");
    expect(csv).not.toContain("aws-bedrock");
  });

  it("uses canonical provider ids for query suggestions and chip toggles", () => {
    const sessions = [
      { key: "s1", modelProvider: "z-ai", usage: { totalTokens: 10, totalCost: 0 } },
      { key: "s2", providerOverride: "z.ai", usage: { totalTokens: 10, totalCost: 0 } },
    ] as UsageSessionEntry[];
    const aggregates = {
      byProvider: [
        { provider: "aws-bedrock", count: 1, totals: { totalTokens: 1, totalCost: 0 } },
      ],
      byModel: [],
      tools: { tools: [] },
    } as unknown as UsageAggregates;

    expect(buildQuerySuggestions("provider:z", sessions, aggregates)).toEqual([
      { label: "provider:zai", value: "provider:zai" },
    ]);
    expect(buildQuerySuggestions("provider:bedrock", sessions, aggregates)).toEqual([
      { label: "provider:amazon-bedrock", value: "provider:amazon-bedrock" },
    ]);
    expect(addQueryToken("provider:z-ai ", "provider:zai")).toBe("provider:z-ai ");
    expect(removeQueryToken("provider:z-ai model:glm ", "provider:zai")).toBe("model:glm ");
  });
});
