/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderNodes, type NodesProps } from "./nodes.ts";

function baseProps(overrides: Partial<NodesProps> = {}): NodesProps {
  return {
    loading: false,
    nodes: [],
    devicesLoading: false,
    devicesError: null,
    devicesList: {
      pending: [],
      paired: [],
    },
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
    onRefresh: () => undefined,
    onDevicesRefresh: () => undefined,
    onDeviceApprove: () => undefined,
    onDeviceReject: () => undefined,
    onDeviceRotate: () => undefined,
    onDeviceRevoke: () => undefined,
    onLoadConfig: () => undefined,
    onLoadExecApprovals: () => undefined,
    onBindDefault: () => undefined,
    onBindAgent: () => undefined,
    onSaveBindings: () => undefined,
    onExecApprovalsTargetChange: () => undefined,
    onExecApprovalsSelectAgent: () => undefined,
    onExecApprovalsPatch: () => undefined,
    onExecApprovalsRemove: () => undefined,
    onSaveExecApprovals: () => undefined,
    ...overrides,
  };
}

function renderNodesContainer(overrides: Partial<NodesProps>): HTMLDivElement {
  const container = document.createElement("div");
  render(renderNodes(baseProps(overrides)), container);
  return container;
}

function getDevicesCard(container: Element): Element {
  const card = Array.from(container.querySelectorAll(".card")).find(
    (candidate) => candidate.querySelector(".card-title")?.textContent?.trim() === "Devices",
  );
  expect(card).toBeInstanceOf(Element);
  if (!(card instanceof Element)) {
    throw new Error("Expected devices card");
  }
  return card;
}

function getExecApprovalsCard(container: Element): Element {
  const card = Array.from(container.querySelectorAll(".card")).find(
    (candidate) => candidate.querySelector(".card-title")?.textContent?.trim() === "Exec approvals",
  );
  expect(card).toBeInstanceOf(Element);
  if (!(card instanceof Element)) {
    throw new Error("Expected exec approvals card");
  }
  return card;
}

function getPendingDeviceDetails(container: Element): string[] {
  const item = getDevicesCard(container).querySelector(".list-item");
  expect(item).toBeInstanceOf(Element);
  if (!(item instanceof Element)) {
    throw new Error("Expected pending device item");
  }
  return Array.from(item.querySelectorAll(".list-main > .muted")).map(
    (line) => line.textContent?.trim() ?? "",
  );
}

describe("nodes exec approvals rendering", () => {
  it("shows denylist mode and per-agent denylist rules", () => {
    const container = renderNodesContainer({
      execApprovalsSelectedAgent: "*",
      execApprovalsSnapshot: {
        path: "~/.openclaw/exec-approvals.json",
        exists: true,
        hash: "hash",
        file: {
          version: 1,
          agents: {
            "*": {
              security: "denylist",
              denylist: [
                {
                  id: "default-shell-network-fetch",
                  pattern: "(?:^|[\\s;&|()<>])(?:curl|wget)(?:$|[\\s;&|()<>])",
                  reason: "Block shell network fetch commands.",
                },
              ],
            },
          },
        },
      },
    });
    const card = getExecApprovalsCard(container);

    expect(card.textContent).toContain("Denylist");
    expect(card.textContent).toContain("default-shell-network-fetch");
    expect(card.textContent).toContain("(?:^|[\\s;&|()<>])(?:curl|wget)(?:$|[\\s;&|()<>])");
    expect(card.textContent).toContain("Block shell network fetch commands.");
    expect(
      Array.from(card.querySelectorAll("option")).some(
        (option) => option.value === "denylist" && option.textContent?.trim() === "Denylist",
      ),
    ).toBe(true);
  });

  it("disables saving while a denylist rule is blank", () => {
    const container = renderNodesContainer({
      execApprovalsSelectedAgent: "*",
      execApprovalsDirty: true,
      execApprovalsSnapshot: {
        path: "~/.openclaw/exec-approvals.json",
        exists: true,
        hash: "hash",
        file: {
          version: 1,
          agents: {
            "*": {
              security: "denylist",
              denylist: [{ pattern: "" }],
            },
          },
        },
      },
    });
    const card = getExecApprovalsCard(container);
    const saveButton = Array.from(card.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Save",
    );

    expect(saveButton).toBeInstanceOf(HTMLButtonElement);
    expect(saveButton?.disabled).toBe(true);
    expect(card.textContent).toContain("Denylist rules need a pattern and only i, m, or u flags");
  });

  it("disables saving while a denylist rule has invalid regex flags", () => {
    const container = renderNodesContainer({
      execApprovalsSelectedAgent: "*",
      execApprovalsDirty: true,
      execApprovalsSnapshot: {
        path: "~/.openclaw/exec-approvals.json",
        exists: true,
        hash: "hash",
        file: {
          version: 1,
          agents: {
            "*": {
              security: "denylist",
              denylist: [{ pattern: "curl", flags: "g" }],
            },
          },
        },
      },
    });
    const card = getExecApprovalsCard(container);
    const saveButton = Array.from(card.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Save",
    );

    expect(saveButton).toBeInstanceOf(HTMLButtonElement);
    expect(saveButton?.disabled).toBe(true);
    expect(card.textContent).toContain("Denylist rules need a pattern and only i, m, or u flags");
  });

  it("renders malformed denylist flags as invalid without crashing", () => {
    const container = renderNodesContainer({
      execApprovalsSelectedAgent: "*",
      execApprovalsDirty: true,
      execApprovalsSnapshot: {
        path: "~/.openclaw/exec-approvals.json",
        exists: true,
        hash: "hash",
        file: {
          version: 1,
          agents: {
            "*": {
              security: "denylist",
              denylist: [{ pattern: "curl", flags: 1 } as never],
            },
          },
        },
      },
    });
    const card = getExecApprovalsCard(container);
    const saveButton = Array.from(card.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Save",
    );

    expect(saveButton).toBeInstanceOf(HTMLButtonElement);
    expect(saveButton?.disabled).toBe(true);
    expect(card.textContent).toContain("Denylist rules need a pattern and only i, m, or u flags");
  });

  it("keeps legacy string denylist rules editable", () => {
    const onPatch = vi.fn();
    const container = renderNodesContainer({
      execApprovalsSelectedAgent: "*",
      execApprovalsDirty: true,
      onExecApprovalsPatch: onPatch,
      execApprovalsSnapshot: {
        path: "~/.openclaw/exec-approvals.json",
        exists: true,
        hash: "hash",
        file: {
          version: 1,
          agents: {
            "*": {
              security: "denylist",
              denylist: ["curl"],
            },
          },
        },
      },
    });
    const card = getExecApprovalsCard(container);
    const saveButton = Array.from(card.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Save",
    );
    const patternInput = Array.from(card.querySelectorAll("input")).find(
      (input) => input.value === "curl",
    );

    expect(saveButton).toBeInstanceOf(HTMLButtonElement);
    expect(saveButton?.disabled).toBe(false);
    expect(card.textContent).not.toContain(
      "Denylist rules need a pattern and only i, m, or u flags",
    );
    expect(patternInput).toBeInstanceOf(HTMLInputElement);

    (patternInput as HTMLInputElement).value = "wget";
    patternInput?.dispatchEvent(new InputEvent("input", { bubbles: true }));

    expect(onPatch).toHaveBeenCalledWith(["agents", "*", "denylist", 0], { pattern: "wget" });
  });
});

describe("nodes devices pending rendering", () => {
  it("shows requested and approved access for a scope upgrade", () => {
    const container = renderNodesContainer({
      devicesList: {
        pending: [
          {
            requestId: "req-1",
            deviceId: "device-1",
            displayName: "Device One",
            role: "operator",
            scopes: ["operator.admin", "operator.read"],
            ts: Date.now(),
          },
        ],
        paired: [
          {
            deviceId: "device-1",
            displayName: "Device One",
            roles: ["operator"],
            scopes: ["operator.read"],
          },
        ],
      },
    });
    const details = getPendingDeviceDetails(container);

    expect(details[0]).toMatch(/^scope upgrade requires approval \u00b7 requested /u);
    expect(details.slice(1)).toEqual([
      "requested: roles: operator \u00b7 scopes: operator.admin, operator.read, operator.write",
      "approved now: roles: operator \u00b7 scopes: operator.read",
    ]);
  });

  it("normalizes pending device ids before matching paired access", () => {
    const container = renderNodesContainer({
      devicesList: {
        pending: [
          {
            requestId: "req-1",
            deviceId: " device-1 ",
            displayName: "Device One",
            role: "operator",
            scopes: ["operator.admin", "operator.read"],
            ts: Date.now(),
          },
        ],
        paired: [
          {
            deviceId: "device-1",
            displayName: "Device One",
            roles: ["operator"],
            scopes: ["operator.read"],
          },
        ],
      },
    });
    const details = getPendingDeviceDetails(container);

    expect(details[0]).toMatch(/^scope upgrade requires approval \u00b7 requested /u);
    expect(details.at(-1)).toBe("approved now: roles: operator \u00b7 scopes: operator.read");
  });

  it("does not show upgrade context for key-mismatched pending requests", () => {
    const container = renderNodesContainer({
      devicesList: {
        pending: [
          {
            requestId: "req-1",
            deviceId: "device-1",
            publicKey: "new-key",
            displayName: "Device One",
            role: "operator",
            scopes: ["operator.admin"],
            ts: Date.now(),
          },
        ],
        paired: [
          {
            deviceId: "device-1",
            publicKey: "old-key",
            displayName: "Device One",
            roles: ["operator"],
            scopes: ["operator.read"],
          },
        ],
      },
    });
    const details = getPendingDeviceDetails(container);

    expect(details[0]).toMatch(/^new device pairing request \u00b7 requested /u);
    expect(details).toEqual([
      details[0] ?? "",
      "requested: roles: operator \u00b7 scopes: operator.admin, operator.read, operator.write",
    ]);
  });

  it("falls back to roles when role is absent", () => {
    const container = renderNodesContainer({
      devicesList: {
        pending: [
          {
            requestId: "req-2",
            deviceId: "device-2",
            roles: ["node", "operator"],
            scopes: ["operator.read"],
            ts: Date.now(),
          },
        ],
        paired: [],
      },
    });
    const details = getPendingDeviceDetails(container);

    expect(details[1]).toBe("requested: roles: node, operator \u00b7 scopes: operator.read");
  });
});
