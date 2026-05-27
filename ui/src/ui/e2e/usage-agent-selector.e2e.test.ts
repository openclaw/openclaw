import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = chromium.executablePath();
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const systemChromeAvailable = existsSync("/Applications/Google Chrome.app");
const browserAvailable = chromiumAvailable || systemChromeAvailable;
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = browserAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object value");
  }
  return value as Record<string, unknown>;
}

describeControlUiE2e("Control UI usage agent selector E2E", () => {
  beforeAll(async () => {
    if (!browserAvailable) {
      throw new Error(
        `Playwright Chromium is not installed at ${chromiumExecutablePath}, and no system Chrome fallback was found. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = chromiumAvailable
      ? await chromium.launch()
      : await chromium.launch({ channel: "chrome" });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("shows configured agents and requests sessions.usage with the selected agentId", async () => {
    const artifactsDir = path.resolve(".artifacts", "control-ui-e2e", "usage-agent-selector");
    await mkdir(artifactsDir, { recursive: true });

    const context = await browser.newContext({
      locale: "en-US",
      recordVideo: { dir: artifactsDir, size: { width: 1280, height: 900 } },
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      assistantAgentId: "main",
      defaultAgentId: "main",
      methodResponses: {
        "agents.list": {
          agents: [
            { id: "main", identity: { name: "Main" }, name: "Main" },
            { id: "opus", identity: { name: "Opus" }, name: "Opus" },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "sessions.usage": {
          cases: [
            {
              match: { agentId: "opus" },
              response: {
                updatedAt: Date.now(),
                startDate: "2026-05-01",
                endDate: "2026-05-27",
                sessions: [
                  {
                    key: "agent:opus:main",
                    label: "Opus session",
                    agentId: "opus",
                    updatedAt: Date.now(),
                    usage: {
                      input: 120,
                      output: 340,
                      cacheRead: 0,
                      cacheWrite: 0,
                      totalTokens: 460,
                      totalCost: 1.23,
                      inputCost: 0.4,
                      outputCost: 0.83,
                      cacheReadCost: 0,
                      cacheWriteCost: 0,
                      missingCostEntries: 0,
                      messageCounts: {
                        total: 4,
                        user: 2,
                        assistant: 2,
                        toolCalls: 0,
                        toolResults: 0,
                        errors: 0,
                      },
                      activityDates: ["2026-05-14"],
                      dailyBreakdown: [{ date: "2026-05-14", tokens: 460, cost: 1.23 }],
                      dailyMessageCounts: [
                        {
                          date: "2026-05-14",
                          total: 4,
                          user: 2,
                          assistant: 2,
                          toolCalls: 0,
                          toolResults: 0,
                          errors: 0,
                        },
                      ],
                    },
                  },
                ],
                totals: {
                  input: 120,
                  output: 340,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 460,
                  totalCost: 1.23,
                  inputCost: 0.4,
                  outputCost: 0.83,
                  cacheReadCost: 0,
                  cacheWriteCost: 0,
                  missingCostEntries: 0,
                },
                aggregates: {
                  messages: {
                    total: 4,
                    user: 2,
                    assistant: 2,
                    toolCalls: 0,
                    toolResults: 0,
                    errors: 0,
                  },
                  tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
                  byModel: [],
                  byProvider: [],
                  byAgent: [],
                  byChannel: [],
                  daily: [
                    {
                      date: "2026-05-14",
                      tokens: 460,
                      cost: 1.23,
                      messages: 4,
                      toolCalls: 0,
                      errors: 0,
                    },
                  ],
                },
              },
            },
          ],
        },
        "usage.cost": {
          updatedAt: Date.now(),
          days: 1,
          daily: [
            {
              date: "2026-05-14",
              input: 120,
              output: 340,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 460,
              totalCost: 1.23,
              inputCost: 0.4,
              outputCost: 0.83,
              cacheReadCost: 0,
              cacheWriteCost: 0,
              missingCostEntries: 0,
            },
          ],
          totals: {
            input: 120,
            output: 340,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 460,
            totalCost: 1.23,
            inputCost: 0.4,
            outputCost: 0.83,
            cacheReadCost: 0,
            cacheWriteCost: 0,
            missingCostEntries: 0,
          },
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}usage`);
      const agentSelect = page.getByLabel("Agent");
      await agentSelect.waitFor({ state: "visible", timeout: 10_000 });
      expect(await agentSelect.inputValue()).toBe("");
      const optionLabels = (await agentSelect.locator("option").allTextContents()).map((label) =>
        label.trim(),
      );
      const optionValues = await agentSelect
        .locator("option")
        .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
      expect(optionLabels).toContain("Default agent");
      expect(optionValues).toContain("opus");

      await page.screenshot({ path: path.join(artifactsDir, "usage-default-agent.png") });

      await agentSelect.selectOption("opus");
      expect(await agentSelect.inputValue()).toBe("opus");
      await page.getByText("Opus session").waitFor({ timeout: 10_000 });
      await page.screenshot({ path: path.join(artifactsDir, "usage-opus-agent.png") });

      const requests = await gateway.getRequests("sessions.usage");
      const selectedRequest = requests
        .map((request) => requireRecord(request.params))
        .find((params) => params.agentId === "opus");

      expect(selectedRequest).toBeDefined();
      expect(selectedRequest?.agentId).toBe("opus");
    } finally {
      await context.close();
    }
  });
});
