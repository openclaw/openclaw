import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { AgentsFilesListResult } from "../types.ts";
import { renderAgentFiles } from "./agents-panels-status-files.ts";

function createFilesList(): AgentsFilesListResult {
  return {
    agentId: "main",
    workspace: "/tmp/openclaw-workspace",
    files: [
      {
        name: "USER.md",
        path: "/tmp/openclaw-workspace/USER.md",
        missing: false,
        size: 42,
        updatedAtMs: 1_700_000_000_000,
      },
    ],
  };
}

describe("agents files panel", () => {
  it("uses a larger default editor textarea footprint", () => {
    const container = document.createElement("div");
    const list = createFilesList();
    render(
      renderAgentFiles({
        agentId: "main",
        agentFilesList: list,
        agentFilesLoading: false,
        agentFilesError: null,
        agentFileActive: "USER.md",
        agentFileContents: { "USER.md": "# Existing content" },
        agentFileDrafts: {},
        agentFileSaving: false,
        onLoadFiles: vi.fn(),
        onSelectFile: vi.fn(),
        onFileDraftChange: vi.fn(),
        onFileReset: vi.fn(),
        onFileSave: vi.fn(),
      }),
      container,
    );

    const textarea = container.querySelector("textarea.agent-file-content-textarea");
    expect(textarea).not.toBeNull();
    expect(textarea?.getAttribute("rows")).toBe("18");
  });
});
