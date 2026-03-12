import { describe, expect, it } from "vitest";
import { resolveOverviewModelState } from "./agents.ts";

describe("resolveOverviewModelState", () => {
  it("exposes global default primary separately from agent override", () => {
    const result = resolveOverviewModelState(
      {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5",
              fallbacks: ["openai/gpt-5-mini"],
            },
          },
          list: [{ id: "main" }],
        },
      } as Record<string, unknown>,
      "main",
    );

    expect(result.defaultPrimary).toBe("openai/gpt-5");
    expect(result.effectivePrimary).toBe("openai/gpt-5");
    expect(result.modelFallbacks).toEqual(["openai/gpt-5-mini"]);
  });

  it("prefers agent override for effective primary while keeping global default visible", () => {
    const result = resolveOverviewModelState(
      {
        agents: {
          defaults: {
            model: "openai/gpt-5",
          },
          list: [{ id: "writer", model: "minimax/abab-6.5s-chat" }],
        },
      } as Record<string, unknown>,
      "writer",
    );

    expect(result.defaultPrimary).toBe("openai/gpt-5");
    expect(result.modelPrimary).toBe("minimax/abab-6.5s-chat");
    expect(result.effectivePrimary).toBe("minimax/abab-6.5s-chat");
  });
});
