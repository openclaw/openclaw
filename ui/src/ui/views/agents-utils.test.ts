import { describe, expect, it } from "vitest";
import {
  resolveAgentConfigSlot,
  resolveConfiguredCronModelSuggestions,
  resolveEffectiveModelFallbacks,
  sortLocaleStrings,
} from "./agents-utils.ts";

describe("resolveEffectiveModelFallbacks", () => {
  it("inherits defaults when no entry fallbacks are configured", () => {
    const entryModel = undefined;
    const defaultModel = {
      primary: "openai/gpt-5-nano",
      fallbacks: ["google/gemini-2.0-flash"],
    };

    expect(resolveEffectiveModelFallbacks(entryModel, defaultModel)).toEqual([
      "google/gemini-2.0-flash",
    ]);
  });

  it("prefers entry fallbacks over defaults", () => {
    const entryModel = {
      primary: "openai/gpt-5-mini",
      fallbacks: ["openai/gpt-5-nano"],
    };
    const defaultModel = {
      primary: "openai/gpt-5",
      fallbacks: ["google/gemini-2.0-flash"],
    };

    expect(resolveEffectiveModelFallbacks(entryModel, defaultModel)).toEqual(["openai/gpt-5-nano"]);
  });

  it("keeps explicit empty entry fallback lists", () => {
    const entryModel = {
      primary: "openai/gpt-5-mini",
      fallbacks: [],
    };
    const defaultModel = {
      primary: "openai/gpt-5",
      fallbacks: ["google/gemini-2.0-flash"],
    };

    expect(resolveEffectiveModelFallbacks(entryModel, defaultModel)).toEqual([]);
  });
});

describe("resolveConfiguredCronModelSuggestions", () => {
  it("collects defaults primary/fallbacks, alias map keys, and per-agent model entries", () => {
    const result = resolveConfiguredCronModelSuggestions({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.2",
            fallbacks: ["google/gemini-2.5-pro", "openai/gpt-5.2-mini"],
          },
          models: {
            "anthropic/claude-sonnet-4-5": { alias: "smart" },
            "openai/gpt-5.2": { alias: "main" },
          },
        },
        list: {
          writer: {
            model: { primary: "xai/grok-4", fallbacks: ["openai/gpt-5.2-mini"] },
          },
          planner: {
            model: "google/gemini-2.5-flash",
          },
        },
      },
    });

    expect(result).toEqual([
      "anthropic/claude-sonnet-4-5",
      "google/gemini-2.5-flash",
      "google/gemini-2.5-pro",
      "openai/gpt-5.2",
      "openai/gpt-5.2-mini",
      "xai/grok-4",
    ]);
  });

  it("returns empty array for invalid or missing config shape", () => {
    expect(resolveConfiguredCronModelSuggestions(null)).toEqual([]);
    expect(resolveConfiguredCronModelSuggestions({})).toEqual([]);
    expect(resolveConfiguredCronModelSuggestions({ agents: { defaults: { model: "" } } })).toEqual(
      [],
    );
  });
});

describe("sortLocaleStrings", () => {
  it("sorts values using localeCompare without relying on Array.prototype.toSorted", () => {
    expect(sortLocaleStrings(["z", "b", "a"])).toEqual(["a", "b", "z"]);
  });

  it("accepts any iterable input, including sets", () => {
    expect(sortLocaleStrings(new Set(["beta", "alpha"]))).toEqual(["alpha", "beta"]);
  });
});

describe("resolveAgentConfigSlot", () => {
  it("returns existing agent index without seed operation", () => {
    const slot = resolveAgentConfigSlot(
      {
        agents: {
          list: [{ id: "main" }, { id: "ops" }],
        },
      },
      "ops",
    );

    expect(slot).toEqual({
      index: 1,
      seedPath: null,
    });
  });

  it("returns append seed when selected agent is missing from list", () => {
    const slot = resolveAgentConfigSlot(
      {
        agents: {
          list: [{ id: "ops" }],
        },
      },
      "main",
    );

    expect(slot).toEqual({
      index: 1,
      seedPath: ["agents", "list", 1, "id"],
      seedValue: "main",
    });
  });

  it("returns initial list seed when agents.list is absent", () => {
    const slot = resolveAgentConfigSlot({}, "main");

    expect(slot).toEqual({
      index: 0,
      seedPath: ["agents", "list"],
      seedValue: [{ id: "main" }],
    });
  });

  it("returns null when agentId is blank", () => {
    expect(resolveAgentConfigSlot({}, "   ")).toBeNull();
  });

  it("returns null when agents.list is not an array", () => {
    expect(
      resolveAgentConfigSlot(
        {
          agents: {
            list: "invalid",
          },
        },
        "main",
      ),
    ).toBeNull();
  });
});
