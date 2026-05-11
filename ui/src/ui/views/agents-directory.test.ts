import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderAgents, type AgentsProps } from "./agents.ts";

function createProps(overrides: Partial<AgentsProps> = {}): AgentsProps {
  return {
    basePath: "",
    loading: false,
    error: null,
    agentsList: {
      defaultId: "alpha",
      mainKey: "main",
      scope: "workspace",
      agents: [
        { id: "alpha", name: "Alpha", description: "First agent", scope: "workspace" } as any,
        { id: "beta", name: "Beta", description: "Second agent", scope: "workspace" } as any,
        { id: "gamma", name: "Gamma", description: "Third agent", scope: "runtime" } as any,
      ],
    },
    selectedAgentId: null, // Directory view
    activePanel: "overview",
    directory: {
      query: "",
      sortDir: "asc",
      defaultFilter: "all",
    },
    config: { form: null, loading: false, saving: false, dirty: false },
    channels: { snapshot: null, loading: false, error: null, lastSuccess: null },
    cron: { status: null, jobs: [], loading: false, error: null },
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
    toolsCatalog: { loading: false, error: null, result: null },
    toolsEffective: { loading: false, error: null, result: null },
    runtimeSessionKey: "main",
    runtimeSessionMatchesSelectedAgent: false,
    modelCatalog: [],
    onRefresh: vi.fn(),
    onOpenAgent: vi.fn(),
    onBackToDirectory: vi.fn(),
    onSelectPanel: vi.fn(),
    onDirectoryChange: vi.fn(),
    onLoadFiles: vi.fn(),
    onSelectFile: vi.fn(),
    onFileDraftChange: vi.fn(),
    onFileReset: vi.fn(),
    onFileSave: vi.fn(),
    onToolsProfileChange: vi.fn(),
    onToolsOverridesChange: vi.fn(),
    onConfigReload: vi.fn(),
    onConfigSave: vi.fn(),
    onModelChange: vi.fn(),
    onModelFallbacksChange: vi.fn(),
    onChannelsRefresh: vi.fn(),
    onCronRefresh: vi.fn(),
    onCronRunNow: vi.fn(),
    onSkillsFilterChange: vi.fn(),
    onSkillsRefresh: vi.fn(),
    onAgentSkillToggle: vi.fn(),
    onAgentSkillsClear: vi.fn(),
    onAgentSkillsDisableAll: vi.fn(),
    onSetDefault: vi.fn(),
    ...overrides,
  };
}

describe("Agents Directory View", () => {
  it("renders the directory grid when no agent is selected", async () => {
    const container = document.createElement("div");
    const props = createProps();
    render(renderAgents(props), container);

    const cards = container.querySelectorAll(".agent-card");
    expect(cards.length).toBe(3);
    expect(container.querySelector(".agents-card-grid")).not.toBeNull();
  });

  it("filters agents by search query", async () => {
    const container = document.createElement("div");
    const props = createProps({
      directory: {
        query: "bet",
        sortDir: "asc",
        defaultFilter: "all",
      },
    });
    render(renderAgents(props), container);

    const cards = container.querySelectorAll(".agent-card");
    expect(cards.length).toBe(1);
    expect(cards[0].textContent).toContain("Beta");
    expect(container.querySelector(".agents-directory-meta")?.textContent).toContain("1 agents");
  });

  it("filters agents by default status", async () => {
    const container = document.createElement("div");
    
    // Default only
    render(renderAgents(createProps({
      directory: {
        query: "",
        sortDir: "asc",
        defaultFilter: "default",
      },
    })), container);
    expect(container.querySelectorAll(".agent-card").length).toBe(1);
    expect(container.querySelector(".agent-card")?.textContent).toContain("Alpha");

    // Non-default only
    render(renderAgents(createProps({
      directory: {
        query: "",
        sortDir: "asc",
        defaultFilter: "non-default",
      },
    })), container);
    expect(container.querySelectorAll(".agent-card").length).toBe(2);
  });

  it("sorts agents by priority and name", async () => {
    const container = document.createElement("div");
    
    // ASC
    render(renderAgents(createProps({
      directory: {
        query: "",
        sortDir: "asc",
        defaultFilter: "all",
      },
    })), container);
    let titles = Array.from(container.querySelectorAll(".agent-card-title span.mono"));
    // alpha is default (priority 100), so it should be first
    expect(titles[0].textContent?.trim()).toBe("alpha");
    expect(titles[1].textContent?.trim()).toBe("beta");
    expect(titles[2].textContent?.trim()).toBe("gamma");
  });

  it("triggers onOpenAgent when a card is clicked", async () => {
    const container = document.createElement("div");
    const onOpenAgent = vi.fn();
    const props = createProps({ onOpenAgent });
    render(renderAgents(props), container);

    const betaCardMain = Array.from(container.querySelectorAll(".agent-card-main")).find(
      el => el.querySelector(".mono")?.textContent?.trim() === "beta"
    );
    (betaCardMain as HTMLElement)?.click();

    expect(onOpenAgent).toHaveBeenCalledWith("beta", "overview");
  });

  it("triggers onBackToDirectory when back button is clicked in detail view", async () => {
    const container = document.createElement("div");
    const onBackToDirectory = vi.fn();
    const props = createProps({ 
      selectedAgentId: "alpha",
      onBackToDirectory 
    });
    render(renderAgents(props), container);

    const backBtn = container.querySelector(".agents-control-detail .btn");
    expect(backBtn).not.toBeNull();
    (backBtn as HTMLElement)?.click();

    expect(onBackToDirectory).toHaveBeenCalled();
  });

  it("triggers onDirectoryChange when search query is typed", async () => {
    const container = document.createElement("div");
    const onDirectoryChange = vi.fn();
    const props = createProps({ onDirectoryChange });
    render(renderAgents(props), container);

    const searchInput = container.querySelector(".agents-directory-search input");
    expect(searchInput).not.toBeNull();
    
    (searchInput as HTMLInputElement).value = "new query";
    searchInput?.dispatchEvent(new Event("input"));

    expect(onDirectoryChange).toHaveBeenCalledWith({ query: "new query" });
  });
});
