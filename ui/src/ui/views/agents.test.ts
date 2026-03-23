import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderAgents, type AgentsProps } from "./agents.ts";

function createSkill() {
  return {
    name: "Repo Skill",
    description: "Skill description",
    source: "workspace",
    filePath: "/tmp/skill",
    baseDir: "/tmp",
    skillKey: "repo-skill",
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    eligible: true,
    requirements: {
      bins: [],
      env: [],
      config: [],
      os: [],
    },
    missing: {
      bins: [],
      env: [],
      config: [],
      os: [],
    },
    configChecks: [],
    install: [],
  };
}

function createProps(overrides: Partial<AgentsProps> = {}): AgentsProps {
  return {
    basePath: "",
    loading: false,
    error: null,
    agentsList: {
      defaultId: "alpha",
      mainKey: "main",
      scope: "workspace",
      agents: [{ id: "alpha", name: "Alpha" } as never, { id: "beta", name: "Beta" } as never],
    },
    selectedAgentId: "beta",
    activePanel: "overview",
    config: {
      form: null,
      loading: false,
      saving: false,
      dirty: false,
    },
    channels: {
      snapshot: null,
      loading: false,
      error: null,
      lastSuccess: null,
    },
    cron: {
      status: null,
      jobs: [],
      loading: false,
      error: null,
    },
    agentFiles: {
      list: null,
      loading: false,
      error: null,
      active: null,
      contents: {},
      drafts: {},
      saving: false,
    },
    agentIdentityLoading: false,
    agentIdentityError: null,
    agentIdentityById: {},
    agentSkills: {
      report: null,
      loading: false,
      error: null,
      agentId: null,
      filter: "",
    },
    toolsCatalog: {
      loading: false,
      error: null,
      result: null,
    },
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
    onCronRunNow: () => undefined,
    onSkillsFilterChange: () => undefined,
    onSkillsRefresh: () => undefined,
    onAgentSkillToggle: () => undefined,
    onAgentSkillsClear: () => undefined,
    onAgentSkillsDisableAll: () => undefined,
    onSetDefault: () => undefined,
    ...overrides,
  };
}

describe("renderAgents", () => {
  it("shows the skills count only for the selected agent's report", async () => {
    const container = document.createElement("div");
    render(
      renderAgents(
        createProps({
          agentSkills: {
            report: {
              workspaceDir: "/tmp/workspace",
              managedSkillsDir: "/tmp/skills",
              skills: [createSkill()],
            },
            loading: false,
            error: null,
            agentId: "alpha",
            filter: "",
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const skillsTab = Array.from(container.querySelectorAll<HTMLButtonElement>(".agent-tab")).find(
      (button) => button.textContent?.includes("Skills"),
    );

    expect(skillsTab?.textContent?.trim()).toBe("Skills");
  });

  it("shows the selected agent's skills count when the report matches", async () => {
    const container = document.createElement("div");
    render(
      renderAgents(
        createProps({
          agentSkills: {
            report: {
              workspaceDir: "/tmp/workspace",
              managedSkillsDir: "/tmp/skills",
              skills: [createSkill()],
            },
            loading: false,
            error: null,
            agentId: "beta",
            filter: "",
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const skillsTab = Array.from(container.querySelectorAll<HTMLButtonElement>(".agent-tab")).find(
      (button) => button.textContent?.includes("Skills"),
    );

    expect(skillsTab?.textContent?.trim()).toContain("1");
  });

  it("lists configured provider-qualified model ids in the overview picker", async () => {
    const container = document.createElement("div");
    render(
      renderAgents(
        createProps({
          config: {
            form: {
              agents: {
                defaults: {
                  model: {
                    primary: "minimax-cn/MiniMax-M2.7",
                    fallbacks: ["google/gemini-3-flash-preview"],
                  },
                  models: {
                    "custom-dashscope-aliyuncs-com/qwen3.5-flash": { alias: "bailian" },
                  },
                },
                list: [{ id: "beta" }],
              },
            },
            loading: false,
            saving: false,
            dirty: false,
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const modelSelect = container.querySelector<HTMLSelectElement>(".agent-model-select select");
    expect(modelSelect).not.toBeNull();

    const options = Array.from(modelSelect?.querySelectorAll("option") ?? []).map((option) => ({
      value: option.value,
      label: option.textContent?.trim(),
    }));

    expect(options).toEqual(
      expect.arrayContaining([
        { value: "", label: "Inherit default (minimax-cn/MiniMax-M2.7)" },
        {
          value: "custom-dashscope-aliyuncs-com/qwen3.5-flash",
          label: "bailian (custom-dashscope-aliyuncs-com/qwen3.5-flash)",
        },
        { value: "google/gemini-3-flash-preview", label: "google/gemini-3-flash-preview" },
        { value: "minimax-cn/MiniMax-M2.7", label: "minimax-cn/MiniMax-M2.7" },
      ]),
    );
    expect(options).not.toContainEqual({
      value: "minimax-cn/MiniMax-M2.7",
      label: "Current (minimax-cn/MiniMax-M2.7)",
    });
  });
});
