import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { ChannelAccountSnapshot, NostrStatus } from "../types.ts";
import { renderNostrCard } from "./channels.nostr.ts";
import type { ChannelsProps } from "./channels.types.ts";

function createBaseProps(overrides: Partial<ChannelsProps> = {}): ChannelsProps {
  return {
    onboarding: false,
    connected: true,
    loading: false,
    snapshot: null,
    lastError: null,
    lastSuccessAt: null,
    whatsappMessage: null,
    whatsappQrDataUrl: null,
    whatsappConnected: null,
    whatsappBusy: false,
    configSchema: null,
    configSchemaLoading: false,
    configForm: null,
    configUiHints: {},
    configSaving: false,
    configFormDirty: false,
    nostrProfileFormState: null,
    nostrProfileAccountId: null,
    onRefresh: vi.fn(),
    onWhatsAppStart: vi.fn(),
    onWhatsAppWait: vi.fn(),
    onWhatsAppLogout: vi.fn(),
    onConfigPatch: vi.fn(),
    onConfigSave: vi.fn(),
    onConfigReload: vi.fn(),
    onNostrProfileEdit: vi.fn(),
    onNostrProfileCancel: vi.fn(),
    onNostrProfileFieldChange: vi.fn(),
    onNostrProfileSave: vi.fn(),
    onNostrProfileImport: vi.fn(),
    onNostrProfileToggleAdvanced: vi.fn(),
    ...overrides,
  };
}

function renderNostrChannel(overrides: {
  props?: Partial<ChannelsProps>;
  nostr?: NostrStatus | null;
  nostrAccounts?: ChannelAccountSnapshot[];
}) {
  const props = createBaseProps({
    configUiHints: {},
    configForm: {
      channels: { nostr: { privateKey: "nsec1...", relays: ["wss://relay.damus.io"] } },
    },
    ...overrides.props,
  });
  const container = document.createElement("div");
  render(
    renderNostrCard({
      props,
      nostr: overrides.nostr ?? null,
      nostrAccounts: overrides.nostrAccounts ?? [],
      accountCountLabel: null,
      onEditProfile: vi.fn(),
      profileFormState: null,
      profileFormCallbacks: null,
    }),
    container,
  );
  return { container, props };
}

describe("Nostr channel UI", () => {
  it("shows onboarding card during onboarding mode even when config appears otherwise complete", () => {
    const { container } = renderNostrChannel({
      props: {
        onboarding: true,
        configForm: {
          channels: {
            nostr: {
              privateKey: "nsec1abc",
              relays: ["wss://relay.damus.io"],
              profile: { name: "OpenClaw" },
            },
          },
        },
        configFormDirty: true,
        configSaving: false,
        connected: true,
      },
      nostr: {
        configured: true,
        running: true,
        publicKey: "npub123",
        profile: { name: "OpenClaw" },
      },
    });

    expect(container.textContent).toContain("Nostr onboarding");
    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Save Nostr config",
    );
    expect(saveButton).toBeTruthy();
    expect(saveButton?.textContent?.trim()).toBe("Save Nostr config");
  });

  it("hides onboarding card once configuration is complete and not in onboarding mode", () => {
    const { container } = renderNostrChannel({
      props: {
        onboarding: false,
        configForm: {
          channels: {
            nostr: {
              privateKey: "nsec1abc",
              relays: ["wss://relay.damus.io"],
              dmPolicy: "pairing",
              profile: { name: "OpenClaw" },
            },
          },
        },
      },
      nostr: {
        configured: true,
        running: true,
        publicKey: "npub123",
        profile: { name: "OpenClaw" },
      },
    });

    expect(container.textContent).not.toContain("Nostr onboarding");
  });

  it("ignores legacy root.nostr config and requires channels.nostr for onboarding state", () => {
    const { container } = renderNostrChannel({
      props: {
        onboarding: false,
        configForm: {
          root: {
            nostr: {
              privateKey: "legacy-nsec1...",
              relays: ["wss://legacy.relay"],
            },
          },
          channels: {
            nostr: {
              relays: [],
            },
          },
        },
      },
      nostr: {
        configured: true,
        running: true,
        profile: { name: "OpenClaw" },
      },
    });

    const keyInput = container.querySelector<HTMLInputElement>('input[type="password"]');
    expect(container.textContent).toContain("Nostr onboarding");
    expect(keyInput).not.toBeNull();
    expect(keyInput?.value).toBe("");
    expect(keyInput?.placeholder).toContain("nsec1...");
  });

  it("patches relays and private key as typed into setup inputs", () => {
    const onConfigPatch = vi.fn();
    const { container } = renderNostrChannel({
      props: {
        onboarding: true,
        configForm: { channels: { nostr: {} } },
        configFormDirty: true,
        onConfigPatch,
      },
      nostr: {
        configured: false,
        running: false,
      },
    });

    const privateKeyInput = container.querySelector('input[type="password"]');
    expect(privateKeyInput).not.toBeNull();
    if (privateKeyInput) {
      privateKeyInput.value = "nsec-new-key";
      privateKeyInput.dispatchEvent(new Event("input", { bubbles: true }));
    }

    expect(onConfigPatch).toHaveBeenCalledWith(["channels", "nostr", "privateKey"], "nsec-new-key");

    const relayTextarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(relayTextarea).not.toBeNull();
    if (relayTextarea) {
      relayTextarea.value = "wss://a\nwss://b,   wss://c";
      relayTextarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
    expect(onConfigPatch).toHaveBeenLastCalledWith(
      ["channels", "nostr", "relays"],
      ["wss://a", "wss://b", "wss://c"],
    );

    const useRecommended = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Use recommended relays",
    );
    expect(useRecommended).toBeTruthy();
    useRecommended?.click();
    expect(onConfigPatch).toHaveBeenLastCalledWith(
      ["channels", "nostr", "relays"],
      ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nostr.wine"],
    );
  });

  it("enables save action when there are unsaved config changes", () => {
    const { container } = renderNostrChannel({
      props: {
        onboarding: true,
        configForm: {
          channels: {
            nostr: {
              privateKey: "nsec1...",
              relays: ["wss://relay.damus.io"],
            },
          },
        },
        configFormDirty: true,
        configSaving: false,
        connected: true,
      },
    });
    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Save Nostr config",
    );

    expect(saveButton).toBeTruthy();
    expect(saveButton?.getAttribute("disabled")).toBeNull();
  });
});
