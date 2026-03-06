import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { ChannelsProps } from "./channels.types.ts";
import { renderWhatsAppCard } from "./channels.whatsapp.ts";

function createProps(overrides: Partial<ChannelsProps> = {}): ChannelsProps {
  return {
    connected: true,
    loading: false,
    snapshot: null,
    lastError: null,
    lastSuccessAt: null,
    whatsappWebLoginAvailable: true,
    whatsappMessage: null,
    whatsappQrDataUrl: null,
    whatsappConnected: null,
    whatsappBusy: false,
    configSchema: null,
    configSchemaLoading: true,
    configForm: null,
    configUiHints: {},
    configSaving: false,
    configFormDirty: false,
    nostrProfileFormState: null,
    nostrProfileAccountId: null,
    onRefresh: () => undefined,
    onWhatsAppStart: () => undefined,
    onWhatsAppWait: () => undefined,
    onWhatsAppLogout: () => undefined,
    onConfigPatch: () => undefined,
    onConfigSave: () => undefined,
    onConfigReload: () => undefined,
    onNostrProfileEdit: () => undefined,
    onNostrProfileCancel: () => undefined,
    onNostrProfileFieldChange: () => undefined,
    onNostrProfileSave: () => undefined,
    onNostrProfileImport: () => undefined,
    onNostrProfileToggleAdvanced: () => undefined,
    ...overrides,
  };
}

describe("whatsapp channel view", () => {
  it("disables QR login actions and shows a callout when web login is unavailable", () => {
    const container = document.createElement("div");
    render(
      renderWhatsAppCard({
        props: createProps({
          whatsappWebLoginAvailable: false,
          whatsappMessage: "WhatsApp web login is not available in this gateway.",
        }),
        whatsapp: {
          configured: false,
          linked: false,
          running: false,
          connected: false,
          reconnectAttempts: 0,
        },
        accountCountLabel: null,
      }),
      container,
    );

    expect(container.textContent).toContain("WhatsApp web login is not available in this gateway.");

    const buttons = Array.from(container.querySelectorAll("button"));
    const showQr = buttons.find((button) => button.textContent?.includes("Show QR"));
    const relink = buttons.find((button) => button.textContent?.includes("Relink"));
    const wait = buttons.find((button) => button.textContent?.includes("Wait for scan"));
    const refresh = buttons.find((button) => button.textContent?.includes("Refresh"));

    expect(showQr?.hasAttribute("disabled")).toBe(true);
    expect(relink?.hasAttribute("disabled")).toBe(true);
    expect(wait?.hasAttribute("disabled")).toBe(true);
    expect(refresh?.hasAttribute("disabled")).toBe(false);
  });

  it("keeps QR login actions enabled when web login is available", () => {
    const container = document.createElement("div");
    render(
      renderWhatsAppCard({
        props: createProps(),
        whatsapp: {
          configured: true,
          linked: false,
          running: false,
          connected: false,
          reconnectAttempts: 0,
        },
        accountCountLabel: null,
      }),
      container,
    );

    const buttons = Array.from(container.querySelectorAll("button"));
    const showQr = buttons.find((button) => button.textContent?.includes("Show QR"));
    const relink = buttons.find((button) => button.textContent?.includes("Relink"));
    const wait = buttons.find((button) => button.textContent?.includes("Wait for scan"));

    expect(showQr?.hasAttribute("disabled")).toBe(false);
    expect(relink?.hasAttribute("disabled")).toBe(false);
    expect(wait?.hasAttribute("disabled")).toBe(false);
  });
});