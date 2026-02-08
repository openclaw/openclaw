import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderAgents, type AgentsProps } from "./agents.ts";

function noop() {
  /* no-op */
}

function buildProps(overrides: Partial<AgentsProps> = {}): AgentsProps {
  return {
    loading: false,
    error: null,
    agentsList: {
      defaultId: "main",
      mainKey: "agent:main:main",
      scope: "default",
      agents: [{ id: "main" }],
    },
    selectedAgentId: "main",
    activePanel: "overview",
    configForm: null,
    configLoading: false,
    configSaving: false,
    configDirty: false,
    channelsLoading: false,
    channelsError: null,
    channelsSnapshot: null,
    channelsLastSuccess: null,
    cronLoading: false,
    cronStatus: null,
    cronJobs: [],
    cronError: null,
    agentFilesLoading: false,
    agentFilesError: null,
    agentFilesList: null,
    agentFileActive: null,
    agentFileContents: {},
    agentFileDrafts: {},
    agentFileSaving: false,
    agentIdentityLoading: false,
    agentIdentityError: null,
    agentIdentityById: {},
    agentSkillsLoading: false,
    agentSkillsReport: null,
    agentSkillsError: null,
    agentSkillsAgentId: null,
    skillsFilter: "",
    onRefresh: noop,
    onSelectAgent: noop,
    onSelectPanel: noop,
    onLoadFiles: noop,
    onSelectFile: noop,
    onFileDraftChange: noop,
    onFileReset: noop,
    onFileSave: noop,
    onToolsProfileChange: noop,
    onToolsOverridesChange: noop,
    onConfigReload: noop,
    onConfigSave: noop,
    onModelChange: noop,
    onModelFallbacksChange: noop,
    onChannelsRefresh: noop,
    onCronRefresh: noop,
    onSkillsFilterChange: noop,
    onSkillsRefresh: noop,
    onAgentSkillToggle: noop,
    onAgentSkillsClear: noop,
    onAgentSkillsDisableAll: noop,
    ...overrides,
  };
}

describe("agents view", () => {
  it("selects the configured primary model in the dropdown", async () => {
    const container = document.createElement("div");
    render(
      renderAgents(
        buildProps({
          configForm: {
            agents: {
              defaults: {
                model: "groq/openai/gpt-oss-120b",
                models: {
                  "cloudflare/claude-sonnet-4-5": {},
                  "groq/openai/gpt-oss-120b": {},
                  "anthropic/claude-opus-4": { alias: "Opus" },
                },
              },
              list: [{ id: "main" }],
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const primarySelect = container.querySelector<HTMLSelectElement>(".agent-model-select select");
    expect(primarySelect).not.toBeNull();
    expect(primarySelect!.value).toBe("groq/openai/gpt-oss-120b");
  });

  it("selects agent-specific primary when it differs from default", async () => {
    const container = document.createElement("div");
    render(
      renderAgents(
        buildProps({
          agentsList: {
            defaultId: "main",
            mainKey: "agent:main:main",
            scope: "default",
            agents: [{ id: "main" }, { id: "helper" }],
          },
          selectedAgentId: "helper",
          configForm: {
            agents: {
              defaults: {
                model: "cloudflare/claude-sonnet-4-5",
                models: {
                  "cloudflare/claude-sonnet-4-5": {},
                  "groq/openai/gpt-oss-120b": {},
                },
              },
              list: [{ id: "main" }, { id: "helper", model: "groq/openai/gpt-oss-120b" }],
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const primarySelect = container.querySelector<HTMLSelectElement>(".agent-model-select select");
    expect(primarySelect).not.toBeNull();
    expect(primarySelect!.value).toBe("groq/openai/gpt-oss-120b");
  });

  it("non-default agent without own model inherits the default primary", async () => {
    const container = document.createElement("div");
    render(
      renderAgents(
        buildProps({
          agentsList: {
            defaultId: "main",
            mainKey: "agent:main:main",
            scope: "default",
            agents: [{ id: "main" }, { id: "helper" }],
          },
          selectedAgentId: "helper",
          configForm: {
            agents: {
              defaults: {
                model: "cloudflare/claude-sonnet-4-5",
                models: {
                  "cloudflare/claude-sonnet-4-5": {},
                  "groq/openai/gpt-oss-120b": {},
                },
              },
              list: [{ id: "main" }, { id: "helper" }],
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const primarySelect = container.querySelector<HTMLSelectElement>(".agent-model-select select");
    expect(primarySelect).not.toBeNull();
    // effectivePrimary falls through to defaultPrimary, so the default model is selected
    expect(primarySelect!.value).toBe("cloudflare/claude-sonnet-4-5");
    // The "Inherit default" option should still be present for non-default agents
    const inheritOption = primarySelect!.querySelector<HTMLOptionElement>('option[value=""]');
    expect(inheritOption).toBeDefined();
    expect(inheritOption?.textContent).toContain("Inherit default");
  });

  it("shows current model even when not in configured models list", async () => {
    const container = document.createElement("div");
    render(
      renderAgents(
        buildProps({
          configForm: {
            agents: {
              defaults: {
                model: "some-unlisted/model",
                models: {
                  "cloudflare/claude-sonnet-4-5": {},
                },
              },
              list: [{ id: "main" }],
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const primarySelect = container.querySelector<HTMLSelectElement>(".agent-model-select select");
    expect(primarySelect).not.toBeNull();
    expect(primarySelect!.value).toBe("some-unlisted/model");
    // Should have a "Current (...)" option prepended
    const currentOption = primarySelect!.querySelector<HTMLOptionElement>(
      'option[value="some-unlisted/model"]',
    );
    expect(currentOption).toBeDefined();
    expect(currentOption?.textContent).toContain("Current");
  });
});
