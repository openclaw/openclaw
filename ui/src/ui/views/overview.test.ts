/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../../src/gateway/protocol/connect-error-details.js";
import { i18n } from "../../i18n/index.ts";
import type {
  CronJob,
  CronStatus,
  SessionsListResult,
  SessionsUsageResult,
  SkillStatusReport,
} from "../types.ts";
import { renderOverview, type OverviewProps } from "./overview.ts";

function createProps(overrides: Partial<OverviewProps> = {}): OverviewProps {
  return {
    connected: false,
    hello: null,
    settings: {
      gatewayUrl: "ws://127.0.0.1:18789",
      token: "",
      sessionKey: "main",
      locale: "en",
    },
    password: "",
    lastError: "disconnected (4008): connect failed",
    lastErrorCode: ConnectErrorDetailCodes.AUTH_REQUIRED,
    presenceCount: 0,
    sessionsCount: null,
    cronEnabled: null,
    cronNext: null,
    lastChannelsRefresh: null,
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

describe("overview view", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  it("localizes auth-required helper labels in Spanish", async () => {
    await i18n.setLocale("es");

    const container = document.createElement("div");
    render(
      renderOverview(
        createProps({
          settings: {
            gatewayUrl: "ws://127.0.0.1:18789",
            token: "",
            sessionKey: "main",
            locale: "es",
          },
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("URL con token");
    expect(container.textContent).toContain("configurar token");
    expect(container.textContent).toContain("Cómo conectarse");
    expect(container.textContent).not.toContain("How to connect");
  });

  it("localizes overview cards in Spanish", async () => {
    await i18n.setLocale("es");

    const container = document.createElement("div");
    render(
      renderOverview(
        createProps({
          settings: {
            gatewayUrl: "ws://127.0.0.1:18789",
            token: "",
            sessionKey: "main",
            locale: "es",
          },
          usageResult: {
            updatedAt: 0,
            startDate: "2026-03-01",
            endDate: "2026-03-13",
            sessions: [],
            totals: {
              totalCost: 12.34,
              totalTokens: 345,
            },
            aggregates: {
              messages: { total: 7 },
            },
          } as SessionsUsageResult,
          sessionsResult: {
            ts: 0,
            path: "",
            count: 1,
            defaults: { model: null, contextTokens: null },
            sessions: [
              {
                key: "main",
                displayName: "Principal",
                model: "gpt-5",
                updatedAt: 1,
              },
            ],
          } as SessionsListResult,
          skillsReport: {
            workspaceDir: "",
            managedSkillsDir: "",
            skills: [
              { disabled: false, blockedByAllowlist: true },
              { disabled: false, blockedByAllowlist: true },
              { disabled: false, blockedByAllowlist: false },
            ],
          } as SkillStatusReport,
          cronJobs: [
            { state: { lastStatus: "error" } },
            { state: { lastStatus: "error" } },
          ] as CronJob[],
          cronStatus: {
            enabled: true,
            jobs: 2,
            nextWakeAtMs: null,
          } as CronStatus,
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Costo");
    expect(container.textContent).toContain("Tokens: 345");
    expect(container.textContent).toContain("Mensajes: 7");
    expect(container.textContent).toContain("Bloqueadas: 2");
    expect(container.textContent).toContain("2 en total");
    expect(container.textContent).toContain("Errores: 2");
    expect(container.textContent).not.toContain("Blocked: 2");
  });
});
