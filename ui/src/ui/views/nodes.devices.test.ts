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
    onDeviceRename: () => undefined,
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

describe("nodes paired device labels", () => {
  it("renders operator labels before client display names", () => {
    const container = renderNodesContainer({
      devicesList: {
        pending: [],
        paired: [
          {
            deviceId: "device-1",
            label: "Kitchen iPad",
            displayName: "Client iPad",
            roles: ["operator"],
            scopes: ["operator.read"],
          },
        ],
      },
    });
    const item = getDevicesCard(container).querySelector(".list-item");

    expect(item?.querySelector(".list-title")?.textContent?.trim()).toBe("Kitchen iPad");
    expect(item?.querySelector(".list-sub")?.textContent).toContain("device-1");
    expect(item?.querySelector(".list-sub")?.textContent).toContain("client: Client iPad");
  });

  it("prompts for a paired-device label and clears on blank input", () => {
    const onDeviceRename = vi.fn();
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("   ");
    const container = renderNodesContainer({
      onDeviceRename,
      devicesList: {
        pending: [],
        paired: [
          {
            deviceId: "device-1",
            label: "Kitchen iPad",
            displayName: "Client iPad",
            roles: ["operator"],
            scopes: ["operator.read"],
          },
        ],
      },
    });

    const renameButton = Array.from(getDevicesCard(container).querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Rename",
    );
    expect(renameButton).toBeInstanceOf(HTMLButtonElement);
    (renameButton as HTMLButtonElement).click();

    expect(prompt).toHaveBeenCalledWith("Device label", "Kitchen iPad");
    expect(onDeviceRename).toHaveBeenCalledWith("device-1", null);
    prompt.mockRestore();
  });

  it("does not rename when the prompt is cancelled", () => {
    const onDeviceRename = vi.fn();
    const prompt = vi.spyOn(window, "prompt").mockReturnValue(null);
    const container = renderNodesContainer({
      onDeviceRename,
      devicesList: {
        pending: [],
        paired: [{ deviceId: "device-1", label: "Kitchen iPad" }],
      },
    });

    const renameButton = Array.from(getDevicesCard(container).querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Rename",
    );
    expect(renameButton).toBeInstanceOf(HTMLButtonElement);
    (renameButton as HTMLButtonElement).click();

    expect(onDeviceRename).not.toHaveBeenCalled();
    prompt.mockRestore();
  });
});
