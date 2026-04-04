/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { GatewayHelloOk } from "../gateway.ts";
import type { UiSettings } from "../storage.ts";
import type { AttentionItem, SessionsListResult } from "../types.ts";
import { renderOverview, type OverviewProps } from "./overview.ts";

function createSettings(): UiSettings {
  return {
    gatewayUrl: "ws://127.0.0.1:18789",
    token: "",
    locale: "en",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "claw",
    themeMode: "dark",
    splitRatio: 0.6,
    navCollapsed: false,
    navGroupsCollapsed: {},
    chatFocusMode: false,
    chatShowThinking: false,
  };
}

function createSessions(): SessionsListResult {
  return {
    ts: Date.now(),
    path: "",
    count: 1,
    defaults: {
      modelProvider: "openai",
      model: "gpt-5",
      contextTokens: null,
    },
    sessions: [
      {
        key: "seat-alpha",
        kind: "direct",
        displayName: "Seat Alpha",
        label: "Seat Alpha",
        updatedAt: Date.now(),
        model: "gpt-5",
      },
    ],
  };
}

function createAttentionItems(): AttentionItem[] {
  return [
    {
      severity: "error",
      icon: "radio",
      title: "Pager seat is blocked",
      description: "Outbound delivery stalled for the last 4 minutes.",
    },
    {
      severity: "warning",
      icon: "scrollText",
      title: "Slack seat needs review",
      description: "Reconnect window is opening soon.",
    },
  ];
}

function createHello(): GatewayHelloOk {
  return {
    snapshot: {
      uptimeMs: 12_000,
      authMode: "token",
    },
    policy: {
      tickIntervalMs: 1_000,
    },
  } as unknown as GatewayHelloOk;
}

function createProps(overrides: Partial<OverviewProps> = {}): OverviewProps {
  return {
    connected: true,
    hello: createHello(),
    settings: createSettings(),
    password: "",
    lastError: null,
    lastErrorCode: null,
    presenceCount: 1,
    sessionsCount: 2,
    cronEnabled: true,
    cronNext: Date.now() + 60_000,
    lastChannelsRefresh: Date.now(),
    usageResult: null,
    sessionsResult: createSessions(),
    skillsReport: null,
    cronJobs: [],
    cronStatus: null,
    attentionItems: createAttentionItems(),
    eventLog: [
      {
        event: "gateway.tick",
        ts: Date.now(),
        payload: null,
      },
    ],
    overviewLogLines: ["watchdog ready"],
    showGatewayToken: false,
    showGatewayPassword: false,
    onSettingsChange: () => undefined,
    onPasswordChange: () => undefined,
    onSessionKeyChange: () => undefined,
    onToggleGatewayTokenVisibility: () => undefined,
    onToggleGatewayPasswordVisibility: () => undefined,
    onConnect: () => undefined,
    onRefresh: () => undefined,
    onNavigate: () => undefined,
    onRefreshLogs: () => undefined,
    ...overrides,
  };
}

describe("overview view", () => {
  it("filters attention items and switches the detail pane", () => {
    const container = document.createElement("div");
    const props = createProps();
    const rerender = () => {
      render(renderOverview(props), container);
    };
    props.onRequestUpdate = rerender;

    rerender();

    expect(container.textContent).toContain("Pager seat is blocked");
    expect(container.textContent).toContain("Slack seat needs review");
    expect(container.textContent).toContain("Recent operator activity");

    const criticalButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".ov-attention-section .ov-segmented__btn"),
    ).find((button) => button.textContent?.includes("Critical"));
    criticalButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(container.textContent).toContain("Pager seat is blocked");
    expect(container.textContent).not.toContain("Slack seat needs review");

    const accessButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".ov-detail-sidebar .ov-segmented__btn"),
    ).find((button) => button.textContent?.includes("Access"));
    accessButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(container.textContent).toContain("Delivery path");
    expect(container.querySelector('input[placeholder="ws://100.x.y.z:18789"]')).not.toBeNull();
  });
});
