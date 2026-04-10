/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { SourceViewProps } from "./source.ts";
import { renderSource } from "./source.ts";

function normalizeText(node: Element | DocumentFragment): string {
  return node.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function createProps(overrides: Partial<SourceViewProps> = {}): SourceViewProps {
  return {
    loading: false,
    error: null,
    tasks: [],
    taskSummary: {
      total: 0,
      active: 0,
      terminal: 0,
      failures: 0,
      byStatus: {
        queued: 0,
        running: 0,
        succeeded: 0,
        failed: 0,
        timed_out: 0,
        cancelled: 0,
        lost: 0,
      },
      byRuntime: {
        subagent: 0,
        acp: 0,
        cli: 0,
        cron: 0,
      },
    },
    flows: [],
    selectedTaskId: null,
    selectedTask: null,
    selectedTaskLoading: false,
    onRefresh: () => undefined,
    onSelectTask: () => undefined,
    onClearSelection: () => undefined,
    ...overrides,
  };
}

describe("renderSource", () => {
  it("renders blocked and waiting flows with their summaries", async () => {
    const container = document.createElement("div");

    render(
      renderSource(
        createProps({
          flows: [
            {
              id: "flow-blocked",
              ownerKey: "agent:main:main",
              status: "blocked",
              notifyPolicy: "state_changes",
              goal: "Finish auth flow",
              createdAt: 1,
              updatedAt: 2,
              blocked: { summary: "Need auth." },
              tasks: [],
              taskSummary: {
                total: 0,
                active: 0,
                terminal: 0,
                failures: 0,
                byStatus: {
                  queued: 0,
                  running: 0,
                  succeeded: 0,
                  failed: 0,
                  timed_out: 0,
                  cancelled: 0,
                  lost: 0,
                },
                byRuntime: {
                  subagent: 0,
                  acp: 0,
                  cli: 0,
                  cron: 0,
                },
              },
            },
            {
              id: "flow-waiting",
              ownerKey: "agent:main:main",
              status: "waiting",
              notifyPolicy: "state_changes",
              goal: "Wait for review",
              currentStep: "Pending approval",
              createdAt: 1,
              updatedAt: 3,
              tasks: [],
              taskSummary: {
                total: 0,
                active: 0,
                terminal: 0,
                failures: 0,
                byStatus: {
                  queued: 0,
                  running: 0,
                  succeeded: 0,
                  failed: 0,
                  timed_out: 0,
                  cancelled: 0,
                  lost: 0,
                },
                byRuntime: {
                  subagent: 0,
                  acp: 0,
                  cli: 0,
                  cron: 0,
                },
              },
            },
          ],
        }),
      ),
      container,
    );
    await Promise.resolve();

    const text = normalizeText(container);
    expect(text).toContain("Finish auth flow");
    expect(text).toContain("Need auth.");
    expect(text).toContain("blocked");
    expect(text).toContain("Wait for review");
    expect(text).toContain("Pending approval");
    expect(text).toContain("waiting");
  });

  it("renders the empty selected-task panel by default", async () => {
    const container = document.createElement("div");

    render(renderSource(createProps()), container);
    await Promise.resolve();

    const text = normalizeText(container);
    expect(text).toContain("Selected task");
    expect(text).toContain("Select a run to inspect its detail.");
  });
});
