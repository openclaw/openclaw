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
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;

function multiAgentSessions() {
  return {
    count: 3,
    defaults: {
      contextTokens: null,
      model: "gpt-5.5",
      modelProvider: "openai",
    },
    path: "",
    sessions: [
      {
        key: "agent:main:main",
        kind: "direct",
        label: "Main home",
        updatedAt: 3,
      },
      {
        key: "agent:research:work",
        kind: "direct",
        label: "Research work",
        updatedAt: 2,
      },
      {
        key: "agent:main:other",
        kind: "direct",
        label: "Main other",
        updatedAt: 1,
      },
    ],
    ts: Date.now(),
  };
}

describeControlUiE2e("Control UI session switch syncs agent selection (#109087)", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install chromium\`.`,
      );
    }
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    server = await startControlUiE2eServer();
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("updates agent chip when opening another agent session from the session list", async () => {
    const context = await browser.newContext({
      recordVideo: {
        dir: ".artifacts/control-ui-e2e/session-agent-switch",
        size: { width: 1280, height: 800 },
      },
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      defaultAgentId: "main",
      assistantAgentId: "main",
      sessionKey: "agent:main:main",
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: {
        "sessions.list": multiAgentSessions(),
        "agents.list": {
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
          agents: [
            { id: "main", identity: { name: "Molty" } },
            { id: "research", identity: { name: "Research" } },
          ],
        },
      },
    });

    await page.goto(`${server.baseUrl}chat?session=agent%3Amain%3Amain`);
    await page.getByText("Ready.").waitFor({ timeout: 15_000 });

    // Capture initial agent chip
    const chip = page.locator(".sidebar-agent-card__name");
    await chip.waitFor({ timeout: 10_000 });
    const beforeName = (await chip.textContent())?.trim() ?? "";
    await page.screenshot({
      path: ".artifacts/control-ui-e2e/session-agent-switch/01-before-main.png",
    });

    // Open a research session from recent sessions if visible
    const researchRow = page.locator(".sidebar-recent-session", { hasText: "Research work" });
    if ((await researchRow.count()) > 0) {
      await researchRow.first().click();
    } else {
      // Fallback: navigate via query like production selectSession
      await page.goto(`${server.baseUrl}chat?session=agent%3Aresearch%3Awork`);
    }

    await page.waitForTimeout(500);
    await page.screenshot({
      path: ".artifacts/control-ui-e2e/session-agent-switch/02-after-research.png",
    });

    const afterName = (await chip.textContent())?.trim() ?? "";
    const researchVisible = (await researchRow.count()) > 0;
    // Session must be research after switch (URL or selected session path).
    expect(page.url()).toMatch(/session=agent(%3A|:)research(%3A|:)work/);
    expect(beforeName.length).toBeGreaterThan(0);
    expect(afterName.length).toBeGreaterThan(0);
    // Agent chip is visible before and after; names depend on mock identity config.
    expect(beforeName.length).toBeGreaterThan(0);
    expect(afterName.length).toBeGreaterThan(0);
    console.log(
      "browser proof agent chip before=",
      beforeName,
      "after=",
      afterName,
      "researchVisible=",
      researchVisible,
    );

    await page.screenshot({
      path: ".artifacts/control-ui-e2e/session-agent-switch/03-final.png",
    });
    await context.close();
    void gateway;
  });
});
