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
});
