import { describe, expect, it } from "vitest";
import {
  agentLogoUrl,
  resolveConfiguredCronModelSuggestions,
  resolveAgentAvatarUrl,
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
        { id: "main", identity: { avatar: "A", avatarUrl: "/avatar/main" } },
        {
          agentId: "main",
          avatar: "A",
          name: "Main",
        },
      ),
    ).toBe("/avatar/main");
  });

  it("returns null for initials or emoji avatar values without a URL", () => {
    expect(resolveAgentAvatarUrl({ id: "main", identity: { avatar: "A" } })).toBeNull();
    expect(resolveAgentAvatarUrl({ id: "main", identity: { avatar: "🦞" } })).toBeNull();
  });

  it("resolves workspace-relative avatar paths to the avatar endpoint", () => {
    expect(
      resolveAgentAvatarUrl({ id: "main", identity: { avatar: "avatars/openclaw.png" } }),
    ).toBe("/avatar/main");
    expect(
      resolveAgentAvatarUrl({ id: "my-agent", identity: { avatar: "images/avatar.jpg" } }),
    ).toBe("/avatar/my-agent");
  });

  it("resolves avatar filenames with extensions to the avatar endpoint", () => {
    expect(resolveAgentAvatarUrl({ id: "test", identity: { avatar: "avatar.png" } })).toBe(
      "/avatar/test",
    );
    expect(resolveAgentAvatarUrl({ id: "test", identity: { avatar: "photo.jpeg" } })).toBe(
      "/avatar/test",
    );
    expect(resolveAgentAvatarUrl({ id: "test", identity: { avatar: "icon.svg" } })).toBe(
      "/avatar/test",
    );
  });

  it("returns null for workspace-relative paths when agent id is missing", () => {
    expect(resolveAgentAvatarUrl({ identity: { avatar: "avatars/openclaw.png" } })).toBeNull();
  });

  it("prefers HTTP/HTTPS URLs over workspace-relative paths", () => {
    expect(
      resolveAgentAvatarUrl({ id: "main", identity: { avatar: "https://example.com/avatar.png" } }),
    ).toBe("https://example.com/avatar.png");
  });

  it("prefers data URIs over workspace-relative paths", () => {
    const dataUri = "data:image/png;base64,iVBORw0KGgo=";
    expect(resolveAgentAvatarUrl({ id: "main", identity: { avatar: dataUri } })).toBe(dataUri);
  });
});
