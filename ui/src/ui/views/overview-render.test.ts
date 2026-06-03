/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderOverview, type OverviewProps } from "./overview.ts";

function buildProps(overrides?: Partial<OverviewProps>): OverviewProps {
  return {
    connected: true,
    hello: null,
    settings: {
      gatewayUrl: "ws://127.0.0.1:18789",
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      locale: "en",
      theme: "claw",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 280,
      navGroupsCollapsed: {},
      borderRadius: 50,
    },
    password: "",
    lastError: null,
    lastErrorCode: null,
    presenceCount: 0,
    sessionsCount: null,
    cronEnabled: null,
    cronNext: null,
    lastChannelsRefresh: null,
    warnQueryToken: false,
    modelAuthStatus: null,
    usageResult: null,
    sessionsResult: null,
    skillsReport: null,
    cronJobs: [],
    cronStatus: null,
    attentionItems: [],
    eventLog: [],
    overviewLogLines: [],
    showGatewayToken: false,
    showGatewayPassword: false,
    onSettingsChange: vi.fn(),
    onPasswordChange: vi.fn(),
    onSessionKeyChange: vi.fn(),
    onToggleGatewayTokenVisibility: vi.fn(),
    onToggleGatewayPasswordVisibility: vi.fn(),
    onConnect: vi.fn(),
    onRefresh: vi.fn(),
    onNavigate: vi.fn(),
    onRefreshLogs: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("renderOverview", () => {
  it("renders the demo system status widget in the snapshot card", async () => {
    const container = document.createElement("div");
    document.body.append(container);

    render(renderOverview(buildProps()), container);
    await Promise.resolve();

    const widget = container.querySelector("openclaw-demo-status-widget");
    expect(widget).toBeInstanceOf(HTMLElement);
    expect(widget?.getAttribute("aria-label")).toBe("System Status");
  });
});
