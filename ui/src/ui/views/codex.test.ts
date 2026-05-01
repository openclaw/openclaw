import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { CodexNativeStatus } from "../types.ts";
import { renderCodex, type CodexProps } from "./codex.ts";

function createStatus(): CodexNativeStatus {
  return {
    backend: "codex-sdk",
    healthy: true,
    defaultRoute: "codex/default",
    routes: [
      {
        id: "ship",
        label: "codex/ship",
        aliases: ["codex-ship"],
        modelReasoningEffort: "high",
      },
    ],
    sessions: [
      {
        sessionKey: "codex:proposal:test",
        backend: "codex-sdk",
        agent: "codex-ship",
        routeId: "ship",
        routeLabel: "codex/ship",
        model: "gpt-5.5",
        modelReasoningEffort: "high",
        lifecycle: "started",
        status: "active",
        createdAt: "2026-04-30T00:00:00.000Z",
        updatedAt: "2026-04-30T00:01:00.000Z",
        turnCount: 1,
      },
    ],
    inbox: [
      {
        id: "proposal-1",
        at: "2026-04-30T00:00:00.000Z",
        sessionKey: "source",
        routeId: "default",
        routeLabel: "codex/default",
        title: "Ship Codex UI",
        summary: "Add the control plane.",
        status: "new",
        sourceEventId: "event-1",
      },
    ],
    backchannel: {
      enabled: true,
      server: "openclaw-codex",
      gatewayUrlConfigured: true,
      stateDirConfigured: true,
      allowedMethods: ["codex.status", "codex.proposal.create"],
      safeWriteMethods: ["codex.proposal.create"],
      requireWriteToken: true,
      writeTokenEnv: "OPENCLAW_CODEX_BACKCHANNEL_WRITE_TOKEN",
    },
  };
}

function createProps(overrides: Partial<CodexProps> = {}): CodexProps {
  return {
    loading: false,
    error: null,
    status: createStatus(),
    doctor: null,
    eventsLoading: false,
    eventsSessionKey: "codex:proposal:test",
    events: [],
    busyProposalId: null,
    executionResult: null,
    exportText: null,
    onRefresh: () => undefined,
    onDoctor: () => undefined,
    onLoadEvents: () => undefined,
    onProposalStatus: () => undefined,
    onExecuteProposal: () => undefined,
    onExportSession: () => undefined,
    onClearExport: () => undefined,
    ...overrides,
  };
}

describe("codex view", () => {
  it("renders routes, proposals, sessions, and action buttons", () => {
    const container = document.createElement("div");
    render(renderCodex(createProps()), container);

    expect(container.textContent).toContain("Native Codex SDK");
    expect(container.textContent).toContain("Backchannel enabled");
    expect(container.textContent).toContain("codex/ship");
    expect(container.textContent).toContain("model gpt-5.5");
    expect(container.textContent).toContain("reasoning high");
    expect(container.textContent).toContain("Ship Codex UI");
    expect(container.textContent).toContain("codex:proposal:test");
    expect(container.textContent).toContain("Execute");
  });

  it("executes a proposal with its route id", () => {
    const container = document.createElement("div");
    const onExecuteProposal = vi.fn();
    render(renderCodex(createProps({ onExecuteProposal })), container);

    const execute = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Execute"),
    );
    execute?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onExecuteProposal).toHaveBeenCalledWith("proposal-1", "default");
  });
});
