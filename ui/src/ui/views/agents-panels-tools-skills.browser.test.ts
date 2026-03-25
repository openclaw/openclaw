import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderAgentTools } from "./agents-panels-tools-skills.ts";

function createBaseParams(overrides: Partial<Parameters<typeof renderAgentTools>[0]> = {}) {
  return {
    agentId: "main",
    configForm: {
      agents: {
        list: [{ id: "main", tools: { profile: "full" } }],
      },
    } as Record<string, unknown>,
    configLoading: false,
    configSaving: false,
    configDirty: false,
    toolsCatalogLoading: false,
    toolsCatalogError: null,
    toolsCatalogResult: null,
    onProfileChange: () => undefined,
    onOverridesChange: () => undefined,
    onConfigReload: () => undefined,
    onConfigSave: () => undefined,
    ...overrides,
  };
}

describe("agents tools panel (browser)", () => {
  it("renders per-tool provenance badges and optional marker", async () => {
    const container = document.createElement("div");
    render(
      renderAgentTools(
        createBaseParams({
          toolsCatalogResult: {
            agentId: "main",
            profiles: [
              { id: "minimal", label: "Minimal" },
              { id: "coding", label: "Coding" },
              { id: "messaging", label: "Messaging" },
              { id: "full", label: "Full" },
            ],
            groups: [
              {
                id: "media",
                label: "Media",
                source: "core",
                tools: [
                  {
                    id: "tts",
                    label: "tts",
                    description: "Text-to-speech conversion",
                    source: "core",
                    defaultProfiles: [],
                  },
                ],
              },
              {
                id: "plugin:voice-call",
                label: "voice-call",
                source: "plugin",
                pluginId: "voice-call",
                tools: [
                  {
                    id: "voice_call",
                    label: "voice_call",
                    description: "Voice call tool",
                    source: "plugin",
                    pluginId: "voice-call",
                    optional: true,
                    defaultProfiles: [],
                  },
                ],
              },
            ],
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const text = container.textContent ?? "";
    expect(text).toContain("core");
    expect(text).toContain("plugin:voice-call");
    expect(text).toContain("optional");
  });

  it("shows fallback warning when runtime catalog fails", async () => {
    const container = document.createElement("div");
    render(
      renderAgentTools(
        createBaseParams({
          toolsCatalogError: "unavailable",
          toolsCatalogResult: null,
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent ?? "").toContain("Could not load runtime tool catalog");
  });
});
