// Real-browser proof + regression for #93041: the desktop chat composer renders the provider
// usage pill from models.authStatus. Screenshots go to the ignored .artifacts/ tree.
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
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

let browser: Browser;
let server: ControlUiE2eServer;

async function openChat(authStatus: unknown): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1280 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await installMockGateway(page, { methodResponses: { "models.authStatus": authStatus } });
  await page.goto(`${server.baseUrl}chat`);
  return { page, close: () => context.close() };
}

describeE2e("Control UI #93041 desktop chat quota pill (mocked Gateway E2E)", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("renders the provider usage pill in the desktop chat composer", async () => {
    const { page, close } = await openChat(authStatusWithUsage);
    try {
      const pill = page.locator('[data-chat-provider-usage="true"]');
      await pill.waitFor({ state: "visible" });
      await page.screenshot({ path: path.join(artifactDir, "01-chat-with-pill.png") });
      await page
        .locator(".agent-chat__composer-controls")
        .first()
        .screenshot({ path: path.join(artifactDir, "02-composer-controls.png") });

      const text = (await pill.textContent())?.replace(/\s+/g, " ").trim();
      expect(text).toContain("Usage");
      expect(await pill.getAttribute("href")).toBe("/usage");
      expect(await pill.getAttribute("title")).toContain("Codex");
    } finally {
      await close();
    }
  });

  it("shows no pill when no provider usage windows are present", async () => {
    const { page, close } = await openChat({ ts: baseTime, providers: [] });
    try {
      await page.locator(".agent-chat__composer-controls").first().waitFor({ state: "visible" });
      await page.waitForTimeout(500);
      expect(await page.locator('[data-chat-provider-usage="true"]').count()).toBe(0);
    } finally {
      await close();
    }
  });
});
