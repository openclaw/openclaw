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
    devicePairSetupOpen: false,
    devicePairSetupLoading: false,
    devicePairSetupError: null,
    devicePairSetup: null,
    canPairDevice: true,
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
    onDevicePairSetupOpen: () => undefined,
    onDevicePairSetupRefresh: () => undefined,
    onDevicePairSetupClose: () => undefined,
    onDevicePairSetupCopy: () => undefined,
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

describe("nodes mobile device pairing", () => {
  it("opens pairing from the Devices card", () => {
    const onOpen = vi.fn();
    const container = renderNodesContainer({ onDevicePairSetupOpen: onOpen });

    const button = getDevicesCard(container).querySelector<HTMLButtonElement>("button.primary");
    expect(button?.textContent).toContain("Pair mobile device");
    button?.click();

    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("disables setup-code creation without administrator access", () => {
    const container = renderNodesContainer({ canPairDevice: false });
    const button = getDevicesCard(container).querySelector<HTMLButtonElement>("button.primary");

    expect(button?.disabled).toBe(true);
    expect(button?.title).toBe("Administrator access is required to create setup codes.");
  });

  it("renders the QR and pending approval state in the pairing dialog", () => {
    const setupCode = "OPENCLAW-SETUP-CODE";
    const container = renderNodesContainer({
      devicePairSetupOpen: true,
      devicePairSetup: {
        setupCode,
        qrDataUrl: "data:image/png;base64,cXItZGF0YQ==",
        gatewayUrl: "wss://gateway.example.com",
        auth: "token",
        urlSource: "config",
      },
      devicesList: {
        pending: [
          {
            requestId: "req-1",
            deviceId: "phone-1",
            publicKey: "key-1",
            ts: Date.now(),
          },
        ],
        paired: [],
      },
    });

    expect(container.querySelector<HTMLImageElement>(".device-pair-setup__qr")?.src).toBe(
      "data:image/png;base64,cXItZGF0YQ==",
    );
    expect(container.querySelector(".device-pair-setup__pending")?.textContent).toContain(
      "Device requests waiting for review: 1",
    );
    expect(container.querySelector(".device-pair-setup__fallback code")?.textContent).toBe(
      setupCode,
    );
  });
});
