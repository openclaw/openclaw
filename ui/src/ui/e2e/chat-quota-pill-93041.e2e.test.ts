// Real-browser proof + regression for #93041: the desktop chat composer renders the provider
// usage pill from models.authStatus. Screenshots go to the ignored .artifacts/ tree.
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const describeE2e = chromiumAvailable ? describe : describe.skip;

const baseTime = 1_700_000_000_000;
const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/chat-quota-pill-93041");

const authStatusWithUsage = {
  ts: baseTime,
  providers: [
    {
      provider: "openai",
      displayName: "Codex",
      status: "ok",
      profiles: [{ profileId: "codex", type: "oauth", status: "ok" }],
      usage: {
        windows: [
          { label: "5h", usedPercent: 42, resetAt: baseTime + 3 * 3_600_000 },
          { label: "Week", usedPercent: 71, resetAt: baseTime + 4 * 86_400_000 },
        ],
      },
    },
  ],
};

let server: ControlUiE2eServer;

async function openChat(authStatus: unknown): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}> {
  const browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  try {
    context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await installMockGateway(page, { methodResponses: { "models.authStatus": authStatus } });
    await page.goto(`${server.baseUrl}chat`);
    return { browser, context, page };
  } catch (error) {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
}

async function closeChat(fixture: {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}): Promise<void> {
  await fixture.page.close().catch(() => {});
  await fixture.context.close().catch(() => {});
  await fixture.browser.close().catch(() => {});
}

describeE2e("Control UI #93041 desktop chat quota pill (mocked Gateway E2E)", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer();
  });

  afterAll(async () => {
    await server?.close();
  });

  it("renders the provider usage pill in the desktop chat composer", async () => {
    const fixture = await openChat(authStatusWithUsage);
    const { page } = fixture;
    try {
      const sidebarPill = page.locator('.sidebar-session-select [data-chat-provider-usage="true"]');
      await sidebarPill.waitFor({ state: "visible" });
      const composerControls = page.locator(".agent-chat__composer-controls").first();
      const composerPill = composerControls.locator('[data-chat-provider-usage="true"]');
      await composerPill.waitFor({ state: "visible" });
      await page.screenshot({ path: path.join(artifactDir, "01-chat-with-pill.png") });
      await composerControls.screenshot({
        path: path.join(artifactDir, "02-composer-controls.png"),
      });
      await page
        .locator(".sidebar-session-select")
        .screenshot({ path: path.join(artifactDir, "03-sidebar-session-select.png") });

      const sidebarText = (await sidebarPill.textContent())?.replace(/\s+/g, " ").trim();
      const composerText = (await composerPill.textContent())?.replace(/\s+/g, " ").trim();
      expect(sidebarText).toContain("Usage");
      expect(composerText).toContain("Usage");
      expect(await sidebarPill.getAttribute("href")).toBe("/usage");
      expect(await sidebarPill.getAttribute("title")).toContain("Codex");
    } finally {
      await closeChat(fixture);
    }
  });

  it("shows no pill when no provider usage windows are present", async () => {
    const fixture = await openChat({ ts: baseTime, providers: [] });
    const { page } = fixture;
    try {
      await page.locator(".agent-chat__composer-controls").first().waitFor({ state: "visible" });
      await page.waitForTimeout(500);
      expect(await page.locator('[data-chat-provider-usage="true"]').count()).toBe(0);
    } finally {
      await closeChat(fixture);
    }
  });
});
