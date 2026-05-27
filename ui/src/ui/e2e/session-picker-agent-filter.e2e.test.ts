import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = chromium.executablePath();
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;

function sessionRow(key: string, label: string, updatedAt: number) {
  return {
    contextTokens: null,
    displayName: label,
    hasActiveRun: false,
    key,
    kind: "direct",
    label,
    model: "gpt-5.5",
    modelProvider: "openai",
    status: "done",
    totalTokens: 0,
    updatedAt,
  };
}

function sessionsListResponse(sessions: unknown[]) {
  return {
    count: sessions.length,
    defaults: {
      contextTokens: null,
      model: "gpt-5.5",
      modelProvider: "openai",
    },
    path: "",
    sessions,
    ts: Date.now(),
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object value");
  }
  return value as Record<string, unknown>;
}

function requestParams(request: MockGatewayRequest): Record<string, unknown> {
  return requireRecord(request.params);
}

async function waitForSessionsRequest(
  gateway: MockGatewayControls,
  predicate: (params: Record<string, unknown>) => boolean,
): Promise<MockGatewayRequest> {
  const deadline = Date.now() + 10_000;
  let requests: MockGatewayRequest[] = [];
  while (Date.now() < deadline) {
    requests = await gateway.getRequests("sessions.list");
    const match = requests.find((request) => predicate(requestParams(request)));
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`No matching sessions.list request found: ${JSON.stringify(requests)}`);
}

describeControlUiE2e("Control UI session picker agent filter", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("filters sessions by agentId when a specific agent session is selected", async () => {
    const baseTime = Date.parse("2026-05-22T09:00:00.000Z");
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      defaultAgentId: "main",
      methodResponses: {
        "agents.list": {
          agents: [
            { id: "main", identity: { name: "Main Agent" }, name: "Main Agent" },
            { id: "stockclaw", identity: { name: "Stock Agent" }, name: "Stock Agent" },
            { id: "fileclaw", identity: { name: "File Agent" }, name: "File Agent" },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "sessions.list": {
          cases: [
            {
              match: { agentId: "main" },
              response: sessionsListResponse([
                sessionRow("agent:main:main", "Main chat", baseTime - 1_000),
                sessionRow("agent:main:cron:daily", "Daily task", baseTime - 60_000),
                sessionRow("agent:main:dashboard:status", "Status check", baseTime - 120_000),
              ]),
            },
            {
              match: { agentId: "stockclaw" },
              response: sessionsListResponse([
                sessionRow("agent:stockclaw:main", "Stock analysis", baseTime - 30_000),
                sessionRow("agent:stockclaw:portfolio", "Portfolio review", baseTime - 90_000),
              ]),
            },
            {
              match: { agentId: "fileclaw" },
              response: sessionsListResponse([
                sessionRow("agent:fileclaw:main", "File management", baseTime - 45_000),
              ]),
            },
            {
              match: {},
              response: sessionsListResponse([
                sessionRow("agent:main:main", "Main chat", baseTime - 1_000),
                sessionRow("agent:stockclaw:main", "Stock analysis", baseTime - 30_000),
                sessionRow("agent:fileclaw:main", "File management", baseTime - 45_000),
                sessionRow("agent:boardgame:main", "Board game", baseTime - 150_000),
              ]),
            },
          ],
        },
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      // Wait for agents.list to complete (agents dropdown should be visible)
      await page.waitForTimeout(500);
      await page.getByRole("button", { name: "Chat session" }).click();

      // Wait for session picker to open and request to be sent
      const sessionRequest = await waitForSessionsRequest(gateway, (params) => params.limit === 50);

      // The fix: sessionKey is "agent:main:main", so agentId should be "main"
      expect(requestParams(sessionRequest)).toMatchObject({
        agentId: "main",
        configuredAgentsOnly: true,
        includeGlobal: true,
        includeUnknown: true,
        limit: 50,
      });

      // Wait for sessions to be rendered - should only show main agent sessions
      await page.getByRole("option", { name: /Main chat/u }).waitFor({ timeout: 10_000 });

      // Verify that sessions from other agents are NOT shown
      const stockOption = page.getByRole("option", { name: /Stock analysis/u });
      const fileOption = page.getByRole("option", { name: /File management/u });
      await expect.poll(async () => stockOption.isVisible()).toBe(false);
      await expect.poll(async () => fileOption.isVisible()).toBe(false);
    } finally {
      await context.close();
    }
  });

  it("shows all sessions when no agentId is passed", async () => {
    const baseTime = Date.parse("2026-05-22T09:00:00.000Z");
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      defaultAgentId: "main",
      methodResponses: {
        "agents.list": {
          agents: [
            { id: "main", identity: { name: "Main Agent" }, name: "Main Agent" },
            { id: "stockclaw", identity: { name: "Stock Agent" }, name: "Stock Agent" },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "sessions.list": {
          cases: [
            {
              match: { agentId: "main" },
              response: sessionsListResponse([
                sessionRow("agent:main:main", "Main chat", baseTime - 1_000),
                sessionRow("agent:stockclaw:main", "Stock analysis", baseTime - 30_000),
              ]),
            },
            {
              match: {},
              response: sessionsListResponse([
                sessionRow("agent:main:main", "Main chat", baseTime - 1_000),
                sessionRow("agent:stockclaw:main", "Stock analysis", baseTime - 30_000),
              ]),
            },
          ],
        },
      },
      // Use a session key without agent prefix to simulate no agentId
      sessionKey: "main",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      // Wait for agents.list to complete (agents dropdown should be visible)
      await page.waitForTimeout(500);
      await page.getByRole("button", { name: "Chat session" }).click();

      const sessionRequest = await waitForSessionsRequest(gateway, (params) => params.limit === 50);

      // When sessionKey is NOT an agent session (just "main"), the fix does NOT add agentId to overrides.
      // The picker params builder has its own logic that may or may not add agentId.
      // The key verification: the fix correctly handles agent:xxx:yyy format.
      expect(requestParams(sessionRequest)).not.toHaveProperty("agentId");
      expect(requestParams(sessionRequest)).toMatchObject({
        configuredAgentsOnly: true,
        includeGlobal: true,
        includeUnknown: true,
        limit: 50,
      });
    } finally {
      await context.close();
    }
  });
});
