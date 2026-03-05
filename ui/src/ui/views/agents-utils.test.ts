import { describe, expect, it } from "vitest";
import {
  resolveAgentConfigEntryIndex,
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

describe("resolveAgentConfigEntryIndex", () => {
  it("bootstraps agents.list when missing", () => {
    const result = resolveAgentConfigEntryIndex({}, "main");

    expect(result).toEqual({
      index: 0,
      bootstrapPatches: [
        {
          path: ["agents", "list"],
          value: [{ id: "main" }],
        },
      ],
    });
  });

  it("returns existing agent index without bootstrap patches", () => {
    const result = resolveAgentConfigEntryIndex(
      {
        agents: {
          list: [{ id: "main" }, { id: "writer" }],
        },
      },
      "writer",
    );

    expect(result).toEqual({
      index: 1,
      bootstrapPatches: [],
    });
  });

  it("appends a missing agent to the existing list", () => {
    const result = resolveAgentConfigEntryIndex(
      {
        agents: {
          list: [{ id: "main" }],
        },
      },
      "ops",
    );

    expect(result).toEqual({
      index: 1,
      bootstrapPatches: [
        {
          path: ["agents", "list", 1],
          value: { id: "ops" },
        },
      ],
    });
  });

  it("returns null for invalid list shape", () => {
    expect(resolveAgentConfigEntryIndex({ agents: { list: {} } }, "main")).toBeNull();
  });
});
