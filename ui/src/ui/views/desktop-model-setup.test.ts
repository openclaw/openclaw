/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { AppViewState } from "../app-view-state.ts";
import { createDesktopModelSetupForm } from "../controllers/desktop-model-setup.ts";
import { renderDesktopModelSetup } from "./desktop-model-setup.ts";

function createState(overrides: Partial<AppViewState> = {}): AppViewState {
  return {
    desktopModelSetupChecked: true,
    desktopModelSetupLoading: false,
    desktopModelSetupSaving: false,
    desktopModelSetupRequired: true,
    desktopModelSetupError: null,
    desktopModelSetupForm: {
      ...createDesktopModelSetupForm("openai"),
      apiKey: "test-key",
    },
    settings: {
      gatewayUrl: "ws://127.0.0.1:18789",
      token: "",
    },
    password: "",
    desktopStatus: {
      permissions: {
        entries: [
          {
            id: "notifications",
            label: "Notifications",
            status: "granted",
            settings_url: "x-apple.systempreferences:notifications",
          },
        ],
      },
    },
    desktopCliStatus: {
      installed: false,
      preferred_manager: "npm",
      install_spec: "openclaw@2026.5.25",
    },
    desktopCliLoading: false,
    desktopCliInstalling: false,
    desktopCliMessage: null,
    desktopWizardSessionId: null,
    desktopWizardBusy: false,
    desktopWizardError: null,
    desktopWizardStep: null,
    desktopWizardDone: false,
    desktopWizardAnswer: null,
    desktopNotificationPermission: "granted",
    desktopNotificationLoading: false,
    updateDesktopModelSetupForm: () => undefined,
    saveDesktopModelSetup: async () => undefined,
    startDesktopGateway: () => undefined,
    connect: () => undefined,
    applySettings: () => undefined,
    refreshDesktopCliStatus: async () => undefined,
    installDesktopCliHelper: async () => undefined,
    startDesktopSetupWizard: async () => undefined,
    submitDesktopSetupWizard: async () => undefined,
    cancelDesktopSetupWizard: async () => undefined,
    updateDesktopSetupWizardAnswer: () => undefined,
    handleDesktopNotificationEnable: async () => undefined,
    handleDesktopNotificationTest: async () => undefined,
    openDesktopPermissionSettings: async () => undefined,
    openDesktopModelAdvancedSettings: () => undefined,
    ...overrides,
  } as unknown as AppViewState;
}

describe("renderDesktopModelSetup", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  it("renders model setup fields and saves", async () => {
    const container = document.createElement("div");
    const saveDesktopModelSetup = vi.fn(async () => undefined);
    const state = createState({ saveDesktopModelSetup });

    render(renderDesktopModelSetup(state), container);
    await Promise.resolve();

    expect(container.textContent).toContain("Configure model");
    expect(container.textContent).toContain("Gateway connection");
    expect(container.textContent).toContain("CLI helper");
    expect(container.textContent).toContain("Setup wizard");
    expect(container.textContent).toContain("Desktop permissions");
    expect(container.textContent).toContain("OpenAI API key");
    expect(container.querySelectorAll("input")).toHaveLength(6);

    container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await Promise.resolve();

    expect(saveDesktopModelSetup).toHaveBeenCalledOnce();
  });

  it("renders a provider-owned wizard step and continues it", async () => {
    const container = document.createElement("div");
    const submitDesktopSetupWizard = vi.fn(async () => undefined);
    const updateDesktopSetupWizardAnswer = vi.fn();
    const state = createState({
      desktopWizardSessionId: "wiz-1",
      desktopWizardStep: {
        id: "flow",
        type: "select",
        title: "Setup mode",
        message: "Choose setup mode",
        options: [
          { value: "quickstart", label: "Quickstart" },
          { value: "advanced", label: "Advanced" },
        ],
      },
      desktopWizardAnswer: "quickstart",
      submitDesktopSetupWizard,
      updateDesktopSetupWizardAnswer,
    });

    render(renderDesktopModelSetup(state), container);
    await Promise.resolve();

    expect(container.textContent).toContain("Setup mode");
    const select = container.querySelector<HTMLSelectElement>("select");
    expect(select?.value).toBe("quickstart");
    select!.value = "advanced";
    select!.dispatchEvent(new Event("change"));

    expect(updateDesktopSetupWizardAnswer).toHaveBeenCalledWith("advanced");
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Continue"))
      ?.click();
    await Promise.resolve();

    expect(submitDesktopSetupWizard).toHaveBeenCalledOnce();
  });
});
