// Control UI tests cover Code Farm view behavior.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { getCodefarmState } from "../controllers/codefarm.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import { renderCodefarm } from "./codefarm.ts";

type CodefarmRenderProps = Parameters<typeof renderCodefarm>[0];

function renderInto(container: HTMLElement, props: CodefarmRenderProps) {
  render(renderCodefarm(props), container);
}

describe("renderCodefarm", () => {
  it("renders discovered repos first and loads jobs when a repo is selected", async () => {
    const host = {};
    const state = getCodefarmState(host);
    state.loaded = true;
    state.activeSection = "jobs";
    state.repos = [
      {
        repo: "/Users/me/agent-space",
        name: "agent-space",
        totalJobs: 2,
        activeJobs: 1,
        reviewJobs: 1,
        blockedJobs: 0,
        latestUpdatedAt: "2026-06-25T12:00:00.000Z",
        statuses: { running: 1, ready_for_review: 1 },
      },
      {
        repo: "/Users/me/caseworkup",
        name: "caseworkup",
        totalJobs: 1,
        activeJobs: 0,
        reviewJobs: 0,
        blockedJobs: 1,
        statuses: { blocked: 1 },
      },
    ];
    state.selectedRepo = "/Users/me/agent-space";
    state.jobs = [
      {
        id: "cf_20260625_001",
        status: "running",
        runtime: "codex-cli",
        taskIntent: "Run focused tests",
      },
    ];
    const request = vi.fn(async () => ({ jobs: [] }));
    const container = document.createElement("div");
    const props = {
      host,
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
      onRequestUpdate: () => renderInto(container, props),
    } satisfies CodefarmRenderProps;

    renderInto(container, props);

    expect(container.querySelector(".codefarm")?.textContent).toContain("agent-space");
    expect(container.querySelector(".codefarm")?.textContent).toContain("caseworkup");
    expect(container.querySelector(".codefarm")?.textContent).toContain("cf_20260625_001");
    expect(container.querySelector(".codefarm")?.textContent).toContain("Run focused tests");

    const repoButtons = container.querySelectorAll<HTMLButtonElement>(".codefarm-repo");
    repoButtons[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledWith("codefarm.list", { repo: "/Users/me/caseworkup" });
  });

  it("renders a terminal snapshot and attach command for observed jobs", () => {
    const host = {};
    const state = getCodefarmState(host);
    state.loaded = true;
    state.activeSection = "jobs";
    state.selectedRepo = "/Users/me/agent-space";
    state.jobs = [{ id: "cf_20260625_001", status: "running" }];
    state.selectedJobId = "cf_20260625_001";
    state.observation = {
      jobId: "cf_20260625_001",
      repo: "/Users/me/agent-space",
      status: "running",
      terminal: { source: "tmux", truncated: false, lines: ["worker booted", "running tests"] },
      tmux: {
        available: true,
        enabled: true,
        session: "codefarm_agent-space-12345678",
        window: "cf_20260625_001",
        pane: "%1",
        attachCommand: "tmux attach -t codefarm_agent-space-12345678",
        note: null,
      },
    };
    const container = document.createElement("div");

    renderInto(container, {
      host,
      client: null,
      connected: true,
    });

    expect(container.querySelector(".codefarm-terminal")?.textContent).toContain("worker booted");
    expect(container.querySelector(".codefarm-detail")?.textContent).toContain(
      "tmux attach -t codefarm_agent-space-12345678",
    );
  });

  it("renders a Projects tab with project context, GSD state, and project tmux status", () => {
    const host = {};
    const state = getCodefarmState(host);
    state.loaded = true;
    state.activeSection = "projects";
    state.repos = [
      {
        repo: "/Users/me/agent-space",
        name: "agent-space",
        totalJobs: 2,
        activeJobs: 1,
        reviewJobs: 1,
        blockedJobs: 0,
        statuses: { running: 1, ready_for_review: 1 },
      },
    ];
    state.selectedRepo = "/Users/me/agent-space";
    state.jobs = [
      {
        id: "cf_20260625_001",
        status: "running",
        runtime: "codex-cli",
        taskIntent: "Add pool-lazy proof",
      },
    ];
    state.project = {
      repo: "/Users/me/agent-space",
      name: "agent-space",
      jobs: { totalJobs: 2, activeJobs: 1, statuses: { running: 1, ready_for_review: 1 } },
      contextFiles: [
        {
          path: "AGENTS.md",
          title: "AGENTS.md",
          kind: "agent_context",
          content: "Keep pool work bounded and proof-backed.",
          truncated: false,
        },
      ],
      gsd: {
        available: true,
        files: [
          {
            path: ".gsd/STATE.md",
            title: "STATE.md",
            kind: "gsd_state",
            content: "Milestone: S02 proof",
            truncated: false,
          },
        ],
      },
      projectTerminal: {
        session: "codefarm_agent-space-12345678",
        attachCommand: "tmux attach -t codefarm_agent-space-12345678",
        running: true,
        pane: "%1",
        cwd: "/Users/me/agent-space",
        terminal: {
          source: "tmux",
          truncated: false,
          lines: ["project booted", "npm test -- --run tests/spaces.test.ts"],
        },
      },
    };
    const container = document.createElement("div");

    renderInto(container, {
      host,
      client: null,
      connected: true,
    });

    expect(container.querySelector(".codefarm-tabs")?.textContent).toContain("Projects");
    expect(container.querySelector(".codefarm-project")?.textContent).toContain("AGENTS.md");
    expect(container.querySelector(".codefarm-project")?.textContent).toContain(
      "Keep pool work bounded",
    );
    expect(container.querySelector(".codefarm-project")?.textContent).toContain(".gsd/STATE.md");
    expect(container.querySelector(".codefarm-project")?.textContent).toContain("S02 proof");
    expect(container.querySelector(".codefarm-project")?.textContent).toContain(
      "codefarm_agent-space-12345678",
    );
    expect(container.querySelector(".codefarm-project")?.textContent).toContain(
      "/Users/me/agent-space",
    );
    expect(container.querySelector(".codefarm-terminal")?.textContent).toContain("project booted");
    expect(container.querySelector(".codefarm-terminal")?.textContent).toContain(
      "npm test -- --run tests/spaces.test.ts",
    );
    expect(container.querySelector(".codefarm-project")?.textContent).toContain("cf_20260625_001");
    expect(container.querySelector(".codefarm-project")?.textContent).toContain(
      "Add pool-lazy proof",
    );
  });

  it("sends input from the Project Terminal card", async () => {
    const host = {};
    const state = getCodefarmState(host);
    state.loaded = true;
    state.activeSection = "projects";
    state.selectedRepo = "/Users/me/agent-space";
    state.project = {
      repo: "/Users/me/agent-space",
      name: "agent-space",
      jobs: { totalJobs: 0, activeJobs: 0, statuses: {} },
      contextFiles: [],
      gsd: { available: true, files: [] },
      projectTerminal: {
        session: "codefarm_agent-space-12345678",
        attachCommand: "tmux attach -t codefarm_agent-space-12345678",
        running: true,
        persistent: true,
        terminal: {
          source: "tmux",
          truncated: false,
          lines: ["ready"],
        },
      },
    };
    const request = vi.fn(async () => ({
      ...state.project,
      projectTerminal: {
        ...state.project?.projectTerminal,
        terminal: { source: "tmux", truncated: false, lines: ["echo hello", "hello"] },
      },
    }));
    const container = document.createElement("div");
    const props = {
      host,
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
      onRequestUpdate: () => renderInto(container, props),
    } satisfies CodefarmRenderProps;

    renderInto(container, props);

    const input = container.querySelector<HTMLInputElement>(".codefarm-terminal-input");
    input!.value = "echo hello";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    container
      .querySelector<HTMLButtonElement>(".codefarm-terminal-send")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledWith("codefarm.project.terminal.send", {
      repo: "/Users/me/agent-space",
      input: "echo hello",
      enter: true,
    });
    expect(container.querySelector(".codefarm-terminal")?.textContent).toContain("hello");
  });

  it("renders project archive controls in the Projects tab", async () => {
    const host = {};
    const state = getCodefarmState(host);
    state.loaded = true;
    state.activeSection = "projects";
    state.selectedRepo = "/Users/me/agent-space";
    state.project = {
      repo: "/Users/me/agent-space",
      name: "agent-space",
      status: "active",
      archived: false,
      jobs: { totalJobs: 1, activeJobs: 0, statuses: { ready_for_review: 1 } },
      contextFiles: [],
      gsd: { available: false, files: [] },
    };
    const request = vi.fn(async () => ({
      repo: "/Users/me/agent-space",
      name: "agent-space",
      status: "archived",
      archived: true,
      jobs: { totalJobs: 1, activeJobs: 0, statuses: { ready_for_review: 1 } },
      contextFiles: [],
      gsd: { available: false, files: [] },
    }));
    const container = document.createElement("div");
    const props = {
      host,
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
      onRequestUpdate: () => renderInto(container, props),
    } satisfies CodefarmRenderProps;

    renderInto(container, props);
    const archive = container.querySelector<HTMLButtonElement>(".codefarm-project-archive");
    expect(archive?.textContent).toContain("Archive");

    archive?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledWith("codefarm.project.archive", {
      repo: "/Users/me/agent-space",
    });
  });

  it("renders the project form and Project Foreman profile in the Projects tab", async () => {
    const host = {};
    const state = getCodefarmState(host);
    state.loaded = true;
    state.activeSection = "projects";
    state.selectedRepo = "/Users/me/agent-space";
    state.projectForm = {
      projectName: "Agent Space",
      mission: "Make Code Farm observable.",
      currentMilestone: "Persistent project terminals",
      currentSlice: "Project Foreman profile and form",
    };
    state.project = {
      repo: "/Users/me/agent-space",
      name: "Agent Space",
      jobs: { totalJobs: 0, activeJobs: 0, statuses: {} },
      contextFiles: [],
      gsd: { available: true, files: [] },
      projectForm: state.projectForm,
      runtime: {
        selected: "codex-cli",
        options: [
          { id: "codex-cli", label: "Codex CLI" },
          { id: "claude-code", label: "Claude Code" },
        ],
      },
      profile: {
        id: "project-foreman",
        name: "Project Foreman",
        status: "configured",
        workspace: "/Users/me/.openclaw/workspaces/project-foreman",
        agentDir: "/Users/me/.openclaw/agents/project-foreman/agent",
        contract: ["GSD-first", "CodeFarm execution", "Persistent tmux"],
      },
    };
    const request = vi.fn(async () => ({
      ...state.project,
      projectForm: {
        ...state.projectForm,
        mission: "Keep the project state live.",
      },
      runtime: {
        selected: "claude-code",
        options: [
          { id: "codex-cli", label: "Codex CLI" },
          { id: "claude-code", label: "Claude Code" },
        ],
      },
    }));
    const container = document.createElement("div");
    const props = {
      host,
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
      onRequestUpdate: () => renderInto(container, props),
    } satisfies CodefarmRenderProps;

    renderInto(container, props);

    const project = container.querySelector(".codefarm-project");
    expect(project?.textContent).toContain("Project Form");
    expect(project?.textContent).toContain("Project Foreman");
    expect(project?.textContent).toContain("Runtime");
    expect(project?.textContent).toContain("GSD-first");
    expect(project?.textContent).toContain("Persistent tmux");
    expect(container.querySelector<HTMLInputElement>(".codefarm-project-form__name")?.value).toBe(
      "Agent Space",
    );
    expect(
      container.querySelector<HTMLTextAreaElement>(".codefarm-project-form__mission")?.value,
    ).toBe("Make Code Farm observable.");
    expect(container.querySelector<HTMLSelectElement>(".codefarm-runtime-select")?.value).toBe(
      "codex-cli",
    );

    const runtime = container.querySelector<HTMLSelectElement>(".codefarm-runtime-select");
    if (runtime) {
      runtime.value = "claude-code";
      runtime.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledWith("codefarm.project.runtime.set", {
      repo: "/Users/me/agent-space",
      runtime: "claude-code",
    });

    const mission = container.querySelector<HTMLTextAreaElement>(".codefarm-project-form__mission");
    if (mission) {
      mission.value = "Keep the project state live.";
      mission.dispatchEvent(new Event("input", { bubbles: true }));
    }
    container
      .querySelector<HTMLButtonElement>(".codefarm-project-form__save")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledWith("codefarm.project.configure", {
      repo: "/Users/me/agent-space",
      form: expect.objectContaining({
        projectName: "Agent Space",
        mission: "Keep the project state live.",
      }),
    });
  });
});
