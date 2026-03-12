import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderOverview, type OverviewProps } from "./overview.ts";

function createProps(overrides: Partial<OverviewProps> = {}): OverviewProps {
  return {
    connected: false,
    hello: null,
    settings: {
      gatewayUrl: "ws://127.0.0.1:18789",
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navGroupsCollapsed: {},
    },
    password: "",
    lastError: null,
    presenceCount: 3,
    sessionsCount: 7,
    cronEnabled: true,
    cronNext: null,
    lastChannelsRefresh: null,
    onNavigateTab: () => undefined,
    onSettingsChange: () => undefined,
    onPasswordChange: () => undefined,
    onSessionKeyChange: () => undefined,
    onConnect: () => undefined,
    onRefresh: () => undefined,
    ...overrides,
  };
}

describe("overview view", () => {
  it("navigates to Instances when clicking the Instances stat card", () => {
    const container = document.createElement("div");
    const onNavigateTab = vi.fn();
    render(renderOverview(createProps({ onNavigateTab })), container);

    const card = container.querySelector('[aria-label="Open Instances tab"]');
    expect(card).not.toBeNull();
    card?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onNavigateTab).toHaveBeenCalledWith("instances");
  });

  it("supports keyboard activation for stat cards", () => {
    const container = document.createElement("div");
    const onNavigateTab = vi.fn();
    render(renderOverview(createProps({ onNavigateTab })), container);

    const card = container.querySelector('[aria-label="Open Sessions tab"]');
    expect(card).not.toBeNull();
    card?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(onNavigateTab).toHaveBeenCalledWith("sessions");
  });
});
