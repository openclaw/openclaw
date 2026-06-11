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

    expect(container.textContent).toContain("Scope upgrade pending approval.");
    expect(container.textContent).toContain(
      "This device is already paired, but the requested wider scope is waiting for approval.",
    );
    expect(container.textContent).toContain("openclaw devices approve req-123");
  });

  it("does not suggest preview-only latest approval when the request id is absent", async () => {
    const container = document.createElement("div");
    const props = createOverviewProps({
      lastError: "scope upgrade pending approval",
      lastErrorCode: "PAIRING_REQUIRED",
    });

    render(renderOverview(props), container);
    await Promise.resolve();

    expect(container.textContent).toContain("Scope upgrade pending approval.");
    expect(container.textContent).toContain("openclaw devices list");
    expect(container.textContent).not.toContain("openclaw devices approve --latest");
  });

  it("renders always-visible creative studio launchers", async () => {
    const container = document.createElement("div");
    const navigatedTo: string[] = [];
    const props = createOverviewProps({
      basePath: "/ui",
      onNavigate: (tab) => {
        navigatedTo.push(tab);
      },
    });

    render(renderOverview(props), container);
    await Promise.resolve();

    expect(container.textContent).toContain("Music Studio");
    expect(container.textContent).toContain("Open Music Studio");
    expect(container.querySelector<HTMLAnchorElement>('a[href="/ui/music-studio"]')).not.toBeNull();
    expect(container.textContent).toContain("SNES Studio");
    expect(container.textContent).toContain("Open SNES Studio");
    expect(container.querySelector<HTMLAnchorElement>('a[href="/ui/snes-studio"]')).not.toBeNull();

    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button.primary")];
    buttons
      .find((button) => button.textContent?.includes("Open Music Studio"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    buttons
      .find((button) => button.textContent?.includes("Open SNES Studio"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(navigatedTo).toEqual(["musicStudio", "snesStudio"]);
  });

  it("renders recent Judge Guard interventions from session audit rows", async () => {
    const container = document.createElement("div");
    const now = Date.now();
    const props = createOverviewProps({
      sessionsResult: {
        ts: now,
        path: "(multiple)",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:main",
            kind: "direct",
            updatedAt: now,
            displayName: "Todd Stanski",
            judgeGuardAudit: [
              {
                ts: now,
                runId: "run-judge-guard",
                action: "rewrote_final_success_claim",
                verdictStatus: "parsed",
                verdict: "REJECT",
                scope: "build completion",
                risk: "medium",
                conditions: "rerun build successfully",
                payloadsChecked: 1,
                payloadsRewritten: 1,
              },
            ],
          },
        ],
      },
      basePath: "/ui",
    });

    render(renderOverview(props), container);
    await Promise.resolve();

    expect(container.textContent).toContain("Judge Guard");
    expect(container.textContent).toContain("REJECT");
    expect(container.textContent).toContain("Todd Stanski");
    expect(container.textContent).toContain("rerun build successfully");
    expect(
      container.querySelector<HTMLAnchorElement>(".ov-judge-guard__session")?.getAttribute("href"),
    ).toBe(`/ui/chat?session=agent%3Amain%3Amain&runId=run-judge-guard&auditTs=${now}`);
  });
});
