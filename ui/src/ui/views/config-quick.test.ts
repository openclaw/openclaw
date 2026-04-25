/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderQuickSettings, type QuickSettingsProps } from "./config-quick.ts";

function createProps(overrides: Partial<QuickSettingsProps> = {}): QuickSettingsProps {
  return {
    currentModel: "gpt-5.5",
    thinkingLevel: "off",
    fastMode: false,
    onModelChange: vi.fn(),
    onThinkingChange: vi.fn(),
    onFastModeToggle: vi.fn(),
    channels: [],
    onChannelConfigure: vi.fn(),
    automation: {
      cronJobCount: 0,
      skillCount: 0,
      mcpServerCount: 0,
    },
    onManageCron: vi.fn(),
    onBrowseSkills: vi.fn(),
    onConfigureMcp: vi.fn(),
    security: {
      gatewayAuth: "Unknown",
      execPolicy: "Allowlist",
      deviceAuth: true,
    },
    onSecurityConfigure: vi.fn(),
    theme: "claw",
    themeMode: "system",
    hasCustomTheme: false,
    customThemeLabel: null,
    borderRadius: 50,
    setTheme: vi.fn(),
    onOpenCustomThemeImport: vi.fn(),
    setThemeMode: vi.fn(),
    setBorderRadius: vi.fn(),
    userAvatar: null,
    onUserAvatarChange: vi.fn(),
    configObject: {},
    onSelectPreset: vi.fn(),
    onAdvancedSettings: vi.fn(),
    connected: true,
    gatewayUrl: "ws://localhost:18789",
    assistantName: "OpenClaw",
    assistantAvatar: null,
    assistantAvatarUrl: null,
    basePath: "",
    version: "2026.4.22",
    ...overrides,
  };
}

describe("renderQuickSettings", () => {
  it("uses stacked columns for the compact settings layout", () => {
    const container = document.createElement("div");

    render(renderQuickSettings(createProps()), container);

    expect(container.querySelectorAll(".qs-stack")).toHaveLength(4);
    expect(container.querySelectorAll(".qs-card--span-all")).toHaveLength(1);
  });

  it("keeps the local user name fixed and shows the assistant identity", () => {
    const container = document.createElement("div");

    render(
      renderQuickSettings(
        createProps({
          assistantName: "Nova",
          assistantAvatar: "assets/avatars/nova-portrait.png",
          assistantAvatarUrl: "blob:nova",
        }),
      ),
      container,
    );

    const titles = Array.from(container.querySelectorAll(".qs-identity-card__title")).map((node) =>
      node.textContent?.trim(),
    );
    expect(titles).toContain("You");
    expect(titles).toContain("Nova");
    expect(container.querySelector('input[placeholder="You"]')).toBeNull();
    expect(
      Array.from(container.querySelectorAll(".qs-row__label")).some(
        (node) => node.textContent?.trim() === "Name",
      ),
    ).toBe(false);
    expect(container.querySelector(".qs-assistant-avatar")?.getAttribute("src")).toBe("blob:nova");
  });

  it("rejects oversized avatar uploads before reading them", () => {
    const onUserAvatarChange = vi.fn();
    const fileReader = vi.fn();
    vi.stubGlobal("FileReader", fileReader);

    try {
      const container = document.createElement("div");
      render(renderQuickSettings(createProps({ onUserAvatarChange })), container);

      const input = container.querySelector('input[type="file"]') as HTMLInputElement | null;
      expect(input).not.toBeNull();
      if (!input) {
        return;
      }

      const file = new File([new Uint8Array(1_500_001)], "avatar.png", { type: "image/png" });
      Object.defineProperty(input, "files", {
        configurable: true,
        value: [file],
      });

      input.dispatchEvent(new Event("change"));

      expect(fileReader).not.toHaveBeenCalled();
      expect(onUserAvatarChange).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("always shows the custom theme option in quick settings", () => {
    const container = document.createElement("div");

    render(renderQuickSettings(createProps()), container);

    expect(
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Custom",
      ),
    ).toBe(true);
  });

  it("routes custom clicks into the tweakcn importer until a custom theme exists", () => {
    const setTheme = vi.fn();
    const onOpenCustomThemeImport = vi.fn();
    const container = document.createElement("div");

    render(
      renderQuickSettings(
        createProps({
          hasCustomTheme: false,
          setTheme,
          onOpenCustomThemeImport,
        }),
      ),
      container,
    );

    const customButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Custom",
    );
    customButton?.click();

    expect(onOpenCustomThemeImport).toHaveBeenCalledTimes(1);
    expect(setTheme).not.toHaveBeenCalled();
  });

  it("applies the imported custom theme from quick settings once it exists", () => {
    const setTheme = vi.fn();
    const onOpenCustomThemeImport = vi.fn();
    const container = document.createElement("div");

    render(
      renderQuickSettings(
        createProps({
          theme: "claw",
          hasCustomTheme: true,
          setTheme,
          onOpenCustomThemeImport,
        }),
      ),
      container,
    );

    const customButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Custom",
    );
    customButton?.click();

    expect(setTheme).toHaveBeenCalledWith("custom", expect.any(Object));
    expect(onOpenCustomThemeImport).not.toHaveBeenCalled();
  });
});
