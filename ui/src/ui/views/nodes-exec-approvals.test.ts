import { describe, expect, it } from "vitest";
import { resolveExecApprovalsState } from "./nodes-exec-approvals.ts";
import type { NodesProps } from "./nodes.ts";

function makeProps(overrides: Partial<NodesProps> = {}): NodesProps {
  return {
    loading: false,
    nodes: [],
    devicesLoading: false,
    devicesError: null,
    devicesList: null,
    configForm: null,
    configLoading: false,
    configSaving: false,
    configDirty: false,
    configFormMode: "form",
    execApprovalsLoading: false,
    execApprovalsSaving: false,
    execApprovalsDirty: false,
    execApprovalsSnapshot: null,
    execApprovalsForm: null,
    execApprovalsSelectedAgent: null,
    execApprovalsTarget: "gateway",
    execApprovalsTargetNodeId: null,
    onRefresh: () => {},
    onDevicesRefresh: () => {},
    onDeviceApprove: () => {},
    onDeviceReject: () => {},
    onDeviceRotate: () => {},
    onDeviceRevoke: () => {},
    onLoadConfig: () => {},
    onLoadExecApprovals: () => {},
    onBindDefault: () => {},
    onBindAgent: () => {},
    onSaveBindings: () => {},
    onExecApprovalsTargetChange: () => {},
    onExecApprovalsSelectAgent: () => {},
    onExecApprovalsPatch: () => {},
    onExecApprovalsRemove: () => {},
    onSaveExecApprovals: () => {},
    ...overrides,
  };
}

describe("resolveExecApprovalsState", () => {
  it("surfaces snapshot path so UI can clearly show active approvals file", () => {
    const props = makeProps({
      execApprovalsSnapshot: {
        path: "/home/node/.openclaw/exec-approvals.json",
        exists: true,
        hash: "abc",
        file: { defaults: { security: "full", ask: "off" } },
      },
    });

    const state = resolveExecApprovalsState(props);

    expect(state.snapshotPath).toBe("/home/node/.openclaw/exec-approvals.json");
  });

  it("clears stale target node id when selected node no longer supports exec approvals", () => {
    const props = makeProps({
      execApprovalsTarget: "node",
      execApprovalsTargetNodeId: "missing-node",
      nodes: [
        {
          nodeId: "node-1",
          displayName: "Node 1",
          commands: ["system.execApprovals.get", "system.execApprovals.set"],
        },
      ],
    });

    const state = resolveExecApprovalsState(props);

    expect(state.target).toBe("node");
    expect(state.targetNodeId).toBeNull();
  });
});
