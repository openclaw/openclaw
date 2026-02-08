/**
 * Visual demo test for the model dropdown fix.
 * Records a video showing the dropdown correctly reflects the configured
 * primary model instead of falling back to the first option.
 *
 * Run with:
 *   npx vitest run --config vitest.video.config.ts src/ui/views/agents.visual-demo.test.ts
 */
import "../../styles.css";
import { render } from "lit";
import { describe, it, expect } from "vitest";
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

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("model dropdown visual demo", () => {
  it("shows configured primary model is correctly selected", async () => {
    // Set dark background matching the app theme
    document.documentElement.style.colorScheme = "dark";
    document.body.style.background = "var(--bg, #12141a)";
    document.body.style.color = "var(--text, #e4e4e7)";
    document.body.style.margin = "0";
    document.body.style.padding = "24px";

    const container = document.createElement("div");
    document.body.appendChild(container);

    render(
      renderAgents(
        buildProps({
          configForm: {
            agents: {
              defaults: {
                model: "groq/openai/gpt-oss-120b",
                models: {
                  "cloudflare/claude-sonnet-4-5": { alias: "Sonnet 4.5" },
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

    // Wait for Lit rendering + CSS
    await sleep(500);

    // Verify the dropdown shows the correct model
    const select = container.querySelector<HTMLSelectElement>(".agent-model-select select");
    expect(select).not.toBeNull();
    expect(select!.value).toBe("groq/openai/gpt-oss-120b");

    // Highlight the model selection area for the video
    const modelSection = container.querySelector<HTMLElement>(".agent-model-select");
    if (modelSection) {
      modelSection.style.outline = "2px solid var(--accent, #ff5c5c)";
      modelSection.style.outlineOffset = "6px";
      modelSection.style.borderRadius = "8px";
    }

    // Scroll the model section into view
    modelSection?.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(1500);

    // Expand the dropdown to show all options
    if (select) {
      select.setAttribute("size", String(select.options.length));
      select.style.position = "relative";
      select.style.zIndex = "999";
    }
    await sleep(3000);

    // Collapse
    select?.removeAttribute("size");
    await sleep(1000);

    // Clean up
    container.remove();
  });
});
