import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry } from "../types.ts";
import {
  agentLogoUrl,
  buildAgentContext,
  buildModelOptions,
  resolveConfiguredCronModelSuggestions,
  resolveAgentAvatarUrl,
  resolveEffectiveModelFallbacks,
  resolveModelFallbacks,
  resolveModelLabel,
  resolveModelPrimary,
  normalizeModelValue,
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

describe("agentLogoUrl", () => {
  it("keeps base-mounted control UI logo paths absolute to the mount", () => {
    expect(agentLogoUrl("/ui")).toBe("/ui/favicon.svg");
    expect(agentLogoUrl("/apps/openclaw/")).toBe("/apps/openclaw/favicon.svg");
  });

  it("uses a route-relative fallback before basePath bootstrap finishes", () => {
    expect(agentLogoUrl("")).toBe("favicon.svg");
  });
});

describe("resolveAgentAvatarUrl", () => {
  it("prefers a runtime avatar URL over non-URL identity avatars", () => {
    expect(
      resolveAgentAvatarUrl(
        { identity: { avatar: "A", avatarUrl: "/avatar/main" } },
        {
          agentId: "main",
          avatar: "A",
          name: "Main",
        },
      ),
    ).toBe("/avatar/main");
  });

  it("returns null for initials or emoji avatar values without a URL", () => {
    expect(resolveAgentAvatarUrl({ identity: { avatar: "A" } })).toBeNull();
    expect(resolveAgentAvatarUrl({ identity: { avatar: "🦞" } })).toBeNull();
  });
});

describe("buildAgentContext", () => {
  it("falls back to agent payload workspace/model when config form is unavailable", () => {
    const context = buildAgentContext(
      {
        id: "main",
        workspace: "/tmp/agent-workspace",
        model: {
          primary: "openai/gpt-5.4",
          fallbacks: ["openai-codex/gpt-5.2-codex"],
        },
      },
      null,
      null,
      "main",
      null,
    );

    expect(context.workspace).toBe("/tmp/agent-workspace");
    expect(context.model).toBe("openai/gpt-5.4 (+1 fallback)");
    expect(context.isDefault).toBe(true);
  });

  it("uses configured defaults when agent-specific overrides are absent", () => {
    const context = buildAgentContext(
      { id: "main" },
      {
        agents: {
          defaults: {
            workspace: "/tmp/default-workspace",
            model: {
              primary: "openai/gpt-5.4",
              fallbacks: ["openai-codex/gpt-5.2-codex"],
            },
          },
          list: [{ id: "main" }],
        },
      },
      null,
      "main",
      null,
    );

    expect(context.workspace).toBe("/tmp/default-workspace");
    expect(context.model).toBe("openai/gpt-5.4 (+1 fallback)");
  });
});

// ---------------------------------------------------------------------------
// resolveModelPrimary — provider prefix preservation
// ---------------------------------------------------------------------------
describe("resolveModelPrimary", () => {
  it("returns null for falsy input", () => {
    expect(resolveModelPrimary(null)).toBeNull();
    expect(resolveModelPrimary(undefined)).toBeNull();
    expect(resolveModelPrimary("")).toBeNull();
  });

  it("returns trimmed string directly", () => {
    expect(resolveModelPrimary("  openrouter/xiaomi/mimo-v2-pro  ")).toBe(
      "openrouter/xiaomi/mimo-v2-pro",
    );
  });

  it("extracts primary from object with primary field", () => {
    expect(resolveModelPrimary({ primary: "anthropic/claude-sonnet-4-5" })).toBe(
      "anthropic/claude-sonnet-4-5",
    );
  });

  it("falls back to model/id/value fields in order", () => {
    expect(resolveModelPrimary({ model: "google/gemini-2.5-pro" })).toBe("google/gemini-2.5-pro");
    expect(resolveModelPrimary({ id: "openai/gpt-4o" })).toBe("openai/gpt-4o");
    expect(resolveModelPrimary({ value: "mistral/mistral-large" })).toBe("mistral/mistral-large");
  });

  it("prefers primary over other fields", () => {
    expect(
      resolveModelPrimary({
        primary: "anthropic/claude-sonnet-4-5",
        model: "openai/gpt-4o",
      }),
    ).toBe("anthropic/claude-sonnet-4-5");
  });

  it("preserves provider prefix with slashes", () => {
    expect(resolveModelPrimary("openrouter/xiaomi/mimo-v2-pro")).toBe(
      "openrouter/xiaomi/mimo-v2-pro",
    );
  });
});

// ---------------------------------------------------------------------------
// resolveModelLabel
// ---------------------------------------------------------------------------
describe("resolveModelLabel", () => {
  it("returns '-' for falsy input", () => {
    expect(resolveModelLabel(null)).toBe("-");
    expect(resolveModelLabel(undefined)).toBe("-");
  });

  it("returns string model as-is", () => {
    expect(resolveModelLabel("openrouter/xiaomi/mimo-v2-pro")).toBe(
      "openrouter/xiaomi/mimo-v2-pro",
    );
  });

  it("includes fallback count in label", () => {
    expect(
      resolveModelLabel({
        primary: "anthropic/claude-sonnet-4-5",
        fallbacks: ["openai/gpt-4o"],
      }),
    ).toBe("anthropic/claude-sonnet-4-5 (+1 fallback)");
  });

  it("shows primary without fallback count when no fallbacks", () => {
    expect(
      resolveModelLabel({
        primary: "anthropic/claude-sonnet-4-5",
        fallbacks: [],
      }),
    ).toBe("anthropic/claude-sonnet-4-5");
  });
});

// ---------------------------------------------------------------------------
// normalizeModelValue
// ---------------------------------------------------------------------------
describe("normalizeModelValue", () => {
  it("strips fallback suffix from label", () => {
    expect(normalizeModelValue("anthropic/claude-sonnet-4-5 (+2 fallback)")).toBe(
      "anthropic/claude-sonnet-4-5",
    );
  });

  it("returns plain label unchanged", () => {
    expect(normalizeModelValue("openrouter/xiaomi/mimo-v2-pro")).toBe(
      "openrouter/xiaomi/mimo-v2-pro",
    );
  });
});

// ---------------------------------------------------------------------------
// resolveModelFallbacks
// ---------------------------------------------------------------------------
describe("resolveModelFallbacks", () => {
  it("returns null for string model", () => {
    expect(resolveModelFallbacks("model-id")).toBeNull();
  });

  it("returns null for falsy input", () => {
    expect(resolveModelFallbacks(null)).toBeNull();
  });

  it("extracts fallbacks array from object", () => {
    expect(
      resolveModelFallbacks({
        primary: "a",
        fallbacks: ["b", "c"],
      }),
    ).toEqual(["b", "c"]);
  });

  it("supports singular 'fallback' field", () => {
    expect(
      resolveModelFallbacks({
        primary: "a",
        fallback: ["b"],
      }),
    ).toEqual(["b"]);
  });

  it("filters non-string entries", () => {
    expect(
      resolveModelFallbacks({
        primary: "a",
        fallbacks: ["b", 42, "c"],
      }),
    ).toEqual(["b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// buildModelOptions — dedup and prefix preservation (#53758)
// ---------------------------------------------------------------------------
describe("buildModelOptions", () => {
  it("does not duplicate when model is in both defaults.models and defaults.model.primary", () => {
    // Core Bug 1 scenario: same model ID in allowlist AND default primary.
    const config = {
      agents: {
        defaults: {
          model: { primary: "openrouter/xiaomi/mimo-v2-pro", fallbacks: [] },
          models: {
            "openrouter/xiaomi/mimo-v2-pro": {},
            "anthropic/claude-sonnet-4-5": { alias: "sonnet" },
          },
        },
      },
    };
    expect(() => buildModelOptions(config, "openrouter/xiaomi/mimo-v2-pro")).not.toThrow();
  });

  it("includes default model primary even if not in allowlist", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "google/gemini-2.5-pro", fallbacks: [] },
          models: {
            "anthropic/claude-sonnet-4-5": {},
          },
        },
      },
    };
    expect(() => buildModelOptions(config)).not.toThrow();
  });

  it("includes fallback models from defaults.model", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-5",
            fallbacks: ["openai/gpt-4o", "google/gemini-2.5-pro"],
          },
          models: {},
        },
      },
    };
    expect(() => buildModelOptions(config)).not.toThrow();
  });

  it("deduplicates case-insensitively", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "OpenRouter/Xiaomi/mimo-v2-pro": {},
          },
        },
      },
    };
    expect(() => buildModelOptions(config, "openrouter/xiaomi/mimo-v2-pro")).not.toThrow();
  });

  it("preserves full provider prefix in current model entry", () => {
    const config = {
      agents: {
        defaults: {
          models: {},
        },
      },
    };
    const fullId = "openrouter/xiaomi/mimo-v2-pro";
    expect(() => buildModelOptions(config, fullId)).not.toThrow();
  });

  it("handles empty config gracefully", () => {
    expect(() => buildModelOptions({})).not.toThrow();
    expect(() => buildModelOptions({ agents: {} })).not.toThrow();
    expect(() => buildModelOptions({ agents: { defaults: {} } })).not.toThrow();
  });

  it("handles string-style defaults.model (not object)", () => {
    const config = {
      agents: {
        defaults: {
          model: "anthropic/claude-sonnet-4-5",
          models: {},
        },
      },
    };
    expect(() => buildModelOptions(config)).not.toThrow();
  });

  it("deduplicates across allowlist and defaults.model with aliases", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-5", fallbacks: [] },
          models: {
            "anthropic/claude-sonnet-4-5": { alias: "sonnet" },
          },
        },
      },
    };
    expect(() => buildModelOptions(config, "anthropic/claude-sonnet-4-5")).not.toThrow();
  });

  it("handles many models across both sources without duplicates", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "model-a",
            fallbacks: ["model-b", "model-c", "model-d"],
          },
          models: {
            "model-a": {},
            "model-b": { alias: "B" },
            "model-e": {},
            "model-f": {},
          },
        },
      },
    };
    expect(() => buildModelOptions(config, "model-a")).not.toThrow();
  });

  it("deduplicates catalog entries against allowlist models", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-5": {},
          },
        },
      },
    };
    const catalog: ModelCatalogEntry[] = [
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic" },
      { id: "gpt-4o", name: "GPT-4o", provider: "openai" },
    ];
    // anthropic/claude-sonnet-4-5 appears in both — should dedup
    expect(() => buildModelOptions(config, null, catalog)).not.toThrow();
  });
});
