import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderAgentSkills, renderAgentTools } from "./agents-panels-tools-skills.ts";

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
    toolsEffectiveLoading: false,
    toolsEffectiveError: null,
    toolsEffectiveResult: null,
    runtimeSessionKey: "main",
    runtimeSessionMatchesSelectedAgent: true,
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

  it("renders effective runtime tools separately from the config catalog", async () => {
    const container = document.createElement("div");
    render(
      renderAgentTools(
        createBaseParams({
          toolsEffectiveResult: {
            agentId: "main",
            profile: "messaging",
            groups: [
              {
                id: "channel",
                label: "Channel tools",
                source: "channel",
                tools: [
                  {
                    id: "message",
                    label: "Message Actions",
                    description: "Send and manage messages in this channel",
                    rawDescription: "Send and manage messages in this channel",
                    source: "channel",
                    channelId: "discord",
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
    expect(text).toContain("Available Right Now");
    expect(text).toContain("Message Actions");
    expect(text).toContain("Channel: discord");
  });

  it("renders the skill filter as a search input with autofill-resistant attributes", async () => {
    const container = document.createElement("div");
    render(
      renderAgentSkills({
        agentId: "main",
        activeAgentId: "main",
        report: {
          workspaceDir: "/tmp/openclaw-workspace",
          managedSkillsDir: "/tmp/openclaw-workspace/skills",
          skills: [
            {
              skillKey: "github",
              name: "GitHub",
              description: "GitHub operations",
              source: "workspace",
              filePath: "/tmp/openclaw-workspace/skills/github/SKILL.md",
              baseDir: "/tmp/openclaw-workspace/skills/github",
              disabled: false,
              eligible: true,
              bundled: false,
              always: false,
              blockedByAllowlist: false,
              requirements: { bins: [], env: [], config: [], os: [] },
              configChecks: [],
              install: [],
              missing: { bins: [], env: [], config: [], os: [] },
            },
          ],
        },
        loading: false,
        error: null,
        configForm: {
          agents: {
            list: [{ id: "main", skills: ["GitHub"] }],
          },
        } as Record<string, unknown>,
        configLoading: false,
        configSaving: false,
        configDirty: false,
        filter: "",
        onFilterChange: () => undefined,
        onRefresh: () => undefined,
        onToggle: () => undefined,
        onClear: () => undefined,
        onDisableAll: () => undefined,
        onConfigReload: () => undefined,
        onConfigSave: () => undefined,
      }),
      container,
    );
    await Promise.resolve();

    const input = container.querySelector<HTMLInputElement>('input[name="agent-skills-filter"]');
    expect(input).not.toBeNull();
    expect(input?.getAttribute("type")).toBe("search");
    expect(input?.getAttribute("autocomplete")).toBe("off");
    expect(input?.getAttribute("autocapitalize")).toBe("off");
    expect(input?.getAttribute("autocorrect")).toBe("off");
    expect(input?.getAttribute("spellcheck")).toBe("false");
  });
});
