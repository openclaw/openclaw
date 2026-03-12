import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderAgents, type AgentsProps } from "./agents.ts";

function createProps(
  configForm: Record<string, unknown>,
  overrides: Partial<AgentsProps> = {},
): AgentsProps {
  return {
    loading: false,
    error: null,
    agentsList: {
      defaultId: "main",
      mainKey: "main",
      scope: "global",
      agents: [{ id: "main", name: "Main" }],
    },
    selectedAgentId: "main",
    activePanel: "overview",
    configForm,
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
    toolsCatalogLoading: false,
    toolsCatalogError: null,
    toolsCatalogResult: null,
    skillsFilter: "",
    onRefresh: () => undefined,
    onSelectAgent: () => undefined,
    onSelectPanel: () => undefined,
    onLoadFiles: () => undefined,
    onSelectFile: () => undefined,
    onFileDraftChange: () => undefined,
    onFileReset: () => undefined,
    onFileSave: () => undefined,
    onToolsProfileChange: () => undefined,
    onToolsOverridesChange: () => undefined,
    onConfigReload: () => undefined,
    onConfigSave: () => undefined,
    onModelChange: () => undefined,
    onModelFallbacksChange: () => undefined,
    onChannelsRefresh: () => undefined,
    onCronRefresh: () => undefined,
    onSkillsFilterChange: () => undefined,
    onSkillsRefresh: () => undefined,
    onAgentSkillToggle: () => undefined,
    onAgentSkillsClear: () => undefined,
    onAgentSkillsDisableAll: () => undefined,
    ...overrides,
  };
}

describe("agents overview model selection (browser)", () => {
  it("updates the selected model when config changes on rerender", async () => {
    const container = document.createElement("div");
    const modelCatalog = {
      "anthropic/claude-opus-4-6": { alias: "opus" },
      "ollama/qwen3-coder:30b-64k": { alias: "qwen3-coder:30b-64k" },
    };

    render(
      renderAgents(
        createProps({
          agents: {
            defaults: {
              models: modelCatalog,
              model: { primary: "anthropic/claude-opus-4-6" },
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    render(
      renderAgents(
        createProps({
          agents: {
            defaults: {
              models: modelCatalog,
              model: { primary: "ollama/qwen3-coder:30b-64k" },
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const select = container.querySelector<HTMLSelectElement>(".agent-model-select select");
    expect(select).not.toBeNull();
    expect(select?.value).toBe("ollama/qwen3-coder:30b-64k");
    expect(select?.selectedOptions[0]?.textContent?.trim()).toContain("qwen3-coder:30b-64k");
  });
});
