/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderQuickSettings, type QuickSettingsProps } from "./config-quick.ts";

function createProps(overrides: Partial<QuickSettingsProps> = {}): QuickSettingsProps {
  return {
    currentModel: "gpt-5.4",
    thinkingLevel: "off",
    fastMode: false,
    onModelChange: vi.fn(),
    onThinkingChange: vi.fn(),
    onFastModeToggle: vi.fn(),
    channels: [],
    onChannelConfigure: vi.fn(),
    apiKeys: [],
    onApiKeyChange: vi.fn(),
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
    borderRadius: 50,
    setTheme: vi.fn(),
    setThemeMode: vi.fn(),
    setBorderRadius: vi.fn(),
    userName: "Val",
    userAvatar: null,
    onUserNameChange: vi.fn(),
    onUserAvatarChange: vi.fn(),
    configObject: {},
    onApplyPreset: vi.fn(),
    onAdvancedSettings: vi.fn(),
    connected: true,
    gatewayUrl: "ws://localhost:18789",
    assistantName: "OpenClaw",
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
});
