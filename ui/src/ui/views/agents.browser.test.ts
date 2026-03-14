import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayAgentRow } from "../types.ts";
import { renderAgents, type AgentsProps } from "./agents.ts";

function createConfigForm(list: Array<Record<string, unknown>> = []) {
  return {
    agents: {
      defaults: {
        model: "openai/gpt-4.1-mini",
        models: {
          "anthropic/claude-opus-4-6": {},
          "openai/gpt-4.1": {},
          "openai/gpt-4.1-mini": {},
        },
      },
      list,
    },
  };
}

function createAgent(id: string, name: string): GatewayAgentRow {
  return { id, name };
}

function createProps(overrides: Partial<AgentsProps> = {}): AgentsProps {
  return {
    basePath: "",
    loading: false,
    error: null,
    agentsList: {
      defaultId: "dev",
      mainKey: "main",
      scope: "workspace",
      agents: [createAgent("dev", "Dev"), createAgent("qa", "QA"), createAgent("ops", "Ops")],
    },
    selectedAgentId: "dev",
    activePanel: "overview",
    config: {
      form: createConfigForm([
        { id: "qa", model: "anthropic/claude-opus-4-6" },
        { id: "ops", model: "openai/gpt-4.1" },
      ]),
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

const mountedContainers = new Set<HTMLElement>();

function createContainer() {
  const container = document.createElement("div");
  mountedContainers.add(container);
  return container;
}

afterEach(() => {
  for (const container of mountedContainers) {
    render(null, container);
    container.remove();
  }
  mountedContainers.clear();
});

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

async function flushRender() {
  await Promise.resolve();
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await nextFrame();
  await Promise.resolve();
}

function getPrimaryModelSelect(container: HTMLElement) {
  const select = container.querySelector<HTMLSelectElement>(".agent-model-select select");
  expect(select).not.toBeNull();
  return select!;
}

describe("agents overview primary model select (browser)", () => {
  it("prefers an explicit model override on the default agent", async () => {
    const container = createContainer();

    render(
      renderAgents(
        createProps({
          selectedAgentId: "dev",
          config: {
            form: createConfigForm([{ id: "dev", model: "openai/gpt-4.1" }]),
            loading: false,
            saving: false,
            dirty: false,
          },
        }),
      ),
      container,
    );
    await flushRender();

    expect(getPrimaryModelSelect(container).value).toBe("openai/gpt-4.1");
  });

  it("keeps explicit non-default models selected when switching between agents", async () => {
    const container = createContainer();

    render(renderAgents(createProps({ selectedAgentId: "dev" })), container);
    await flushRender();

    render(renderAgents(createProps({ selectedAgentId: "qa" })), container);
    await flushRender();
    expect(getPrimaryModelSelect(container).value).toBe("anthropic/claude-opus-4-6");

    render(renderAgents(createProps({ selectedAgentId: "ops" })), container);
    await flushRender();
    expect(getPrimaryModelSelect(container).value).toBe("openai/gpt-4.1");

    render(renderAgents(createProps({ selectedAgentId: "qa" })), container);
    await flushRender();
    expect(getPrimaryModelSelect(container).value).toBe("anthropic/claude-opus-4-6");
  });

  it("shows the inherit-default option text instead of going blank", async () => {
    const container = createContainer();

    render(renderAgents(createProps({ selectedAgentId: "qa" })), container);
    await flushRender();
    expect(getPrimaryModelSelect(container).value).toBe("anthropic/claude-opus-4-6");

    render(
      renderAgents(
        createProps({
          selectedAgentId: "qa",
          config: {
            form: createConfigForm([{ id: "qa" }]),
            loading: false,
            saving: false,
            dirty: true,
          },
        }),
      ),
      container,
    );
    await flushRender();

    const select = getPrimaryModelSelect(container);
    expect(select.value).toBe("");
    expect(select.selectedOptions[0]?.textContent?.trim()).toBe(
      "Inherit default (openai/gpt-4.1-mini)",
    );
  });
});
