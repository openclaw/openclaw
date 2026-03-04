import { render } from "lit";
import { describe, expect, it } from "vitest";
import {
  buildModelOptions,
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

describe("buildModelOptions", () => {
  const configForm = {
    agents: {
      defaults: {
        models: {
          "github-copilot/claude-sonnet-4.6": {},
          "openai-codex/gpt-5.3-codex": { alias: "codex" },
          "google/gemini-3-pro-preview": {},
        },
      },
    },
  };

  function renderIntoSelect(current?: string | null) {
    const select = document.createElement("select");
    render(buildModelOptions(configForm, current), select);
    return select;
  }

  it("marks exactly one option selected when current matches a configured model", () => {
    const select = renderIntoSelect("openai-codex/gpt-5.3-codex");
    const selected = Array.from(select.options).filter((o) => o.selected);
    expect(selected).toHaveLength(1);
    expect(selected[0].value).toBe("openai-codex/gpt-5.3-codex");
  });

  it("marks the prepended Current option selected when current is not in the configured list", () => {
    const select = renderIntoSelect("unknown/model-x");
    const selected = Array.from(select.options).filter((o) => o.selected);
    expect(selected).toHaveLength(1);
    expect(selected[0].value).toBe("unknown/model-x");
    expect(selected[0].label).toContain("Current");
  });

  it("sets no explicit selected attribute when current is undefined", () => {
    const select = renderIntoSelect(undefined);
    // Browsers always auto-select the first option; verify no option has an
    // explicit ?selected binding (hasAttribute vs the DOM .selected property).
    const explicitlySelected = Array.from(select.options).filter((o) => o.hasAttribute("selected"));
    expect(explicitlySelected).toHaveLength(0);
  });

  it("renders all configured models as options", () => {
    const select = renderIntoSelect("github-copilot/claude-sonnet-4.6");
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toContain("github-copilot/claude-sonnet-4.6");
    expect(values).toContain("openai-codex/gpt-5.3-codex");
    expect(values).toContain("google/gemini-3-pro-preview");
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
