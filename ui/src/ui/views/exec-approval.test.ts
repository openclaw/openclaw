/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { AppViewState } from "../app-view-state.ts";
import type { ExecApprovalRequest } from "../controllers/exec-approval.ts";
import { renderExecApprovalPrompt } from "./exec-approval.ts";

function createApprovalState(queue: ExecApprovalRequest[]): AppViewState {
  return {
    execApprovalQueue: queue,
    execApprovalBusy: false,
    execApprovalError: null,
    handleExecApprovalDecision: vi.fn(),
  } as unknown as AppViewState;
}

describe("exec approval prompt", () => {
  it("renders a high-risk badge for destructive exec commands", () => {
    const container = document.createElement("div");
    render(
      renderExecApprovalPrompt(
        createApprovalState([
          {
            id: "exec-1",
            kind: "exec",
            request: {
              command: "rm -rf ./dist",
              cwd: "/workspace/project",
              resolvedPath: "/workspace/project/dist",
              agentId: "main",
              sessionKey: "main",
            },
            createdAtMs: Date.now(),
            expiresAtMs: Date.now() + 60_000,
          },
        ]),
      ),
      container,
    );

    expect(container.textContent).toContain("High risk");
    expect(container.textContent).toContain("destructive or highly privileged operations");
    expect(container.textContent).toContain("rm -rf ./dist");
    expect(container.textContent).toContain("Why this was flagged");
    expect(container.textContent).toContain("Matched a destructive command pattern");
  });

  it("renders plugin approvals with the plugin risk framing", () => {
    const container = document.createElement("div");
    render(
      renderExecApprovalPrompt(
        createApprovalState([
          {
            id: "plugin-1",
            kind: "plugin",
            request: {
              command: "Install screen-capture plugin",
              agentId: "main",
              sessionKey: "main",
            },
            pluginTitle: "Install screen-capture plugin",
            pluginDescription: "Requests screen recording permissions.",
            pluginSeverity: "medium",
            pluginId: "screen-capture",
            createdAtMs: Date.now(),
            expiresAtMs: Date.now() + 60_000,
          },
        ]),
      ),
      container,
    );

    expect(container.textContent).toContain("Medium risk");
    expect(container.textContent).toContain("Requests screen recording permissions.");
    expect(container.textContent).toContain("Plugin request");
    expect(container.textContent).toContain("Plugin severity is marked medium.");
  });
});
