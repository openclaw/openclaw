/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import { renderOverview, type OverviewProps } from "./overview.ts";

function createOverviewProps(overrides: Partial<OverviewProps> = {}): OverviewProps {
  return {
    warnQueryToken: false,
    connected: false,
    hello: null,
    settings: {
      gatewayUrl: "",
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
      borderRadius: 50,
      locale: "en",
    },
    password: "",
    lastError: null,
    lastErrorCode: null,
    presenceCount: 0,
    sessionsCount: null,
    cronEnabled: null,
    cronNext: null,
    lastChannelsRefresh: null,
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

function compactText(node: Element | null): string | undefined {
  return node?.textContent?.trim().replace(/\s+/g, " ");
}

describe("overview view rendering", () => {
  it("keeps the persisted overview locale selected before i18n hydration finishes", async () => {
    const container = document.createElement("div");
    const props = createOverviewProps({
      settings: {
        ...createOverviewProps().settings,
        locale: "zh-CN",
      },
    });

    getSafeLocalStorage()?.clear();
    await i18n.setLocale("en");

    render(renderOverview(props), container);
    await Promise.resolve();

    let select = container.querySelector<HTMLSelectElement>("select");
    expect(i18n.getLocale()).toBe("en");
    expect(select?.value).toBe("zh-CN");
    expect(select?.selectedOptions[0]?.textContent?.trim()).toBe("简体中文 (Simplified Chinese)");

    await i18n.setLocale("zh-CN");
    render(renderOverview(props), container);
    await Promise.resolve();

    select = container.querySelector<HTMLSelectElement>("select");
    expect(select?.value).toBe("zh-CN");
    expect(select?.selectedOptions[0]?.textContent?.trim()).toBe("简体中文 (简体中文)");

    await i18n.setLocale("en");
  });

  it("renders a dedicated scope-upgrade approval hint with the exact approve command", async () => {
    const container = document.createElement("div");
    const props = createOverviewProps({
      lastError: "scope upgrade pending approval (requestId: req-123)",
      lastErrorCode: "PAIRING_REQUIRED",
    });

    render(renderOverview(props), container);
    await Promise.resolve();

    const hint = container.querySelector(".mono")?.closest(".muted") ?? null;
    expect(compactText(hint)).toBe(
      "Scope upgrade pending approval. This device is already paired, but the requested wider scope is waiting for approval. openclaw devices approve req-123 openclaw devices list On mobile? Copy the full URL (including #token=...) from openclaw dashboard --no-open on your desktop. Docs: Device pairing",
    );
    expect([...container.querySelectorAll(".mono")].map((node) => node.textContent)).toEqual([
      "openclaw devices approve req-123",
      "openclaw devices list",
    ]);
  });

  it("does not suggest preview-only latest approval when the request id is absent", async () => {
    const container = document.createElement("div");
    const props = createOverviewProps({
      lastError: "scope upgrade pending approval",
      lastErrorCode: "PAIRING_REQUIRED",
    });

    render(renderOverview(props), container);
    await Promise.resolve();

    const hint = container.querySelector(".mono")?.closest(".muted") ?? null;
    expect(compactText(hint)).toBe(
      "Scope upgrade pending approval. This device is already paired, but the requested wider scope is waiting for approval. openclaw devices list On mobile? Copy the full URL (including #token=...) from openclaw dashboard --no-open on your desktop. Docs: Device pairing",
    );
    expect([...container.querySelectorAll(".mono")].map((node) => node.textContent)).toEqual([
      "openclaw devices list",
    ]);
  });

  it("renders recent session names through the shared display resolver", async () => {
    const container = document.createElement("div");
    const props = createOverviewProps({
      connected: true,
      sessionsResult: {
        ts: 0,
        path: "",
        count: 3,
        defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
        sessions: [
          {
            key: "discord:123:456",
            kind: "direct",
            label: "   ",
            displayName: "Ops Room",
            model: "gpt-5",
            updatedAt: null,
          },
          {
            key: "telegram:123:456",
            kind: "direct",
            label: "telegram:123:456",
            model: "gpt-5",
            updatedAt: null,
          },
          {
            key: "agent:main:main",
            kind: "direct",
            label: "Main Project",
            displayName: "agent:main:main",
            model: "gpt-5",
            updatedAt: null,
          },
        ],
      },
    });

    render(renderOverview(props), container);
    await Promise.resolve();

    const recentNames = [...container.querySelectorAll(".ov-recent__key")].map(
      (node) => node.textContent?.trim() ?? "",
    );
    expect(recentNames).toEqual(["Ops Room", "Telegram Session", "Main Project"]);
    expect(recentNames).not.toContain("telegram:123:456");
  });

  it("blurs digit runs in operator overview recent sessions", async () => {
    const container = document.createElement("div");
    const props = createOverviewProps({
      connected: true,
      sessionsResult: {
        ts: 0,
        path: "",
        count: 1,
        defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
        sessions: [
          {
            key: "agent:main:imessage:direct:+19257864429",
            kind: "direct",
            label: "",
            model: "gpt-5",
            updatedAt: null,
          },
        ],
      },
    });

    render(renderOverview(props), container);
    await Promise.resolve();

    const recent = container.querySelector(".ov-recent__key");
    expect(compactText(recent)).toBe("iMessage · +19257864429");
    expect(recent?.querySelector(".blur-digits")?.textContent).toBe("19257864429");
  });

  it("keeps recent sessions compact on the operator overview", async () => {
    const container = document.createElement("div");
    const props = createOverviewProps({
      connected: true,
      sessionsResult: {
        ts: 0,
        path: "",
        count: 5,
        defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
        sessions: Array.from({ length: 5 }, (_, index) => ({
          key: `session:${index}`,
          kind: "direct",
          label: `Session ${index + 1}`,
          model: "gpt-5",
          updatedAt: null,
        })),
      },
    });

    render(renderOverview(props), container);
    await Promise.resolve();

    expect(container.querySelectorAll(".ov-recent__key")).toHaveLength(3);
    expect(compactText(container.querySelector(".ov-operator-more--button"))).toBe(
      "2 more sessions",
    );
  });

  it("promotes provider quota into a dedicated overview card", async () => {
    const container = document.createElement("div");
    const now = Date.now();
    const props = createOverviewProps({
      connected: true,
      usageResult: {
        totals: { totalCost: 0, totalTokens: 0 },
        aggregates: { messages: { total: 0 } },
      } as OverviewProps["usageResult"],
      modelAuthStatus: {
        ts: Date.now(),
        providers: [
          {
            provider: "openai-codex",
            displayName: "Codex",
            status: "ok",
            profiles: [{ profileId: "codex", type: "oauth", status: "ok" }],
            usage: {
              windows: [
                { label: "3h", usedPercent: 18, resetAt: now + 3 * 60 * 60_000 },
                { label: "Week", usedPercent: 72, resetAt: now + 5 * 24 * 60 * 60_000 },
              ],
            },
          },
          {
            provider: "anthropic",
            displayName: "Claude",
            status: "ok",
            profiles: [{ profileId: "anthropic", type: "token", status: "ok" }],
            usage: {
              windows: [{ label: "5h", usedPercent: 60 }],
            },
          },
        ],
      },
    });

    render(renderOverview(props), container);
    await Promise.resolve();

    const quota = container.querySelector('[data-kind="quota"]');
    expect(compactText(quota)).toBe("Week quota 28% left Codex · Week · Codex · 3h 82% left");
    expect(compactText(container.querySelector(".ov-usage-card"))).toContain(
      "Provider Usage Compact view of model usage, costs, and quota signals.",
    );
    expect(container.querySelectorAll(".ov-usage-window__reset")).toHaveLength(2);
    expect(compactText(container.querySelector(".ov-usage-windows"))).toContain(
      "Codex · Week reset",
    );
    expect(compactText(container.querySelector(".ov-usage-card"))).not.toContain("quota resets");
    expect(container.querySelector(".ov-usage-note")).toBeNull();
  });

  it("labels provider-specific quota shapes without assuming time windows", async () => {
    const container = document.createElement("div");
    const props = createOverviewProps({
      connected: true,
      usageResult: {
        totals: { totalCost: 0, totalTokens: 0 },
        aggregates: { messages: { total: 0 } },
      } as OverviewProps["usageResult"],
      modelAuthStatus: {
        ts: Date.now(),
        providers: [
          {
            provider: "google-gemini-cli",
            displayName: "Gemini",
            status: "ok",
            profiles: [{ profileId: "gemini", type: "oauth", status: "ok" }],
            usage: {
              windows: [
                { label: "Pro", usedPercent: 20 },
                { label: "Flash", usedPercent: 0 },
              ],
            },
          },
          {
            provider: "openrouter",
            displayName: "OpenRouter",
            status: "ok",
            profiles: [{ profileId: "openrouter", type: "api_key", status: "ok" }],
            usage: {
              windows: [
                {
                  label: "Credits",
                  usedPercent: 42,
                  remainingLabel: "$12.34",
                  usedLabel: "$8.90",
                  totalLabel: "$21.24",
                },
              ],
            },
          },
          {
            provider: "zai",
            displayName: "Z.ai",
            status: "ok",
            profiles: [{ profileId: "zai", type: "api_key", status: "ok" }],
            usage: {
              windows: [{ label: "Tokens (6h)", usedPercent: 40 }],
            },
          },
        ],
      },
    });

    render(renderOverview(props), container);
    await Promise.resolve();

    expect(compactText(container.querySelector('[data-kind="quota"]'))).toBe(
      "Credits $12.34 left OpenRouter · Credits · Z.ai · Tokens (6h) 60% left",
    );
    expect(compactText(container.querySelector(".ov-usage-windows"))).toContain(
      "OpenRouter · Credits $12.34 left",
    );
    expect(container.querySelector(".ov-usage-note")).toBeNull();
  });

  it("does not call provider quota unavailable while auth status is still loading", async () => {
    const container = document.createElement("div");
    const props = createOverviewProps({
      connected: true,
      usageResult: {
        totals: { totalCost: 0, totalTokens: 0 },
        aggregates: { messages: { total: 0 } },
      } as OverviewProps["usageResult"],
      modelAuthStatus: null,
    });

    render(renderOverview(props), container);
    await Promise.resolve();

    const note = compactText(container.querySelector(".ov-usage-note"));
    expect(note).toBe("Provider quota is still loading; showing local session usage meanwhile.");
    expect(note).not.toContain("unavailable");
  });
});
