// Real-browser proof + regression for #89466: after send clears the Control UI
// composer, a stale *native* InputEvent replay of the just-submitted text must
// not reappear in the textarea, while a deliberate same-text re-entry still
// works. Screenshots go to the ignored .artifacts/ tree.
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

const composerSelector = ".agent-chat__composer-combobox textarea";
const submitted = "submitted message";
const artifactDir = path.resolve(
  process.cwd(),
  ".artifacts/control-ui-e2e/chat-composer-stale-replay-89466",
);

let server: ControlUiE2eServer;

async function openChat(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
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
    await installMockGateway(page, {
      historyMessages: [
        {
          content: [{ text: "Ready for the stale-replay check.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });
    // First navigation can trigger a cold Vite dev-server compile; allow headroom.
    await page.goto(`${server.baseUrl}chat`, { timeout: 60_000, waitUntil: "domcontentloaded" });
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

describeE2e("Control UI #89466 composer stale native replay (mocked Gateway E2E)", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer();
  });

  afterAll(async () => {
    await server?.close();
  });

  it("clears after send, suppresses a stale native InputEvent replay, and accepts re-entry", async () => {
    const fixture = await openChat();
    const { page } = fixture;
    const composer = page.locator(composerSelector);
    try {
      // First load can sit on a cold Vite dev-server compile; wait it out.
      await page.getByText("Ready for the stale-replay check.").waitFor({ timeout: 90_000 });
      await composer.waitFor({ state: "visible", timeout: 90_000 });

      // 1. Type (real per-character native input) and send through the real
      //    GUI; the composer clears after send.
      await composer.click();
      await composer.pressSequentially(submitted, { delay: 20 });
      await expect.poll(() => composer.inputValue(), { timeout: 10_000 }).toBe(submitted);
      await page.getByRole("button", { name: "Send message" }).click();
      await expect.poll(() => composer.inputValue(), { timeout: 10_000 }).toBe("");
      const afterSend = await composer.inputValue();
      await page.screenshot({ path: path.join(artifactDir, "01-cleared-after-send.png") });

      // 2. Replay the submitted value through a *native* InputEvent (the exact
      //    path the previous guard skipped). It must stay suppressed.
      await composer.evaluate((el, text) => {
        const textarea = el as HTMLTextAreaElement;
        textarea.value = text;
        textarea.dispatchEvent(
          new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }),
        );
      }, submitted);
      // Give the handler a frame; the value must not reappear.
      await page.waitForTimeout(250);
      const afterReplay = await composer.inputValue();
      await page.screenshot({ path: path.join(artifactDir, "02-stale-replay-suppressed.png") });

      // 3. A deliberate same-text re-entry via real keyboard typing is accepted.
      await composer.click();
      await page.keyboard.type(submitted);
      await expect.poll(() => composer.inputValue(), { timeout: 10_000 }).toBe(submitted);
      const afterReentry = await composer.inputValue();
      await page.screenshot({ path: path.join(artifactDir, "03-same-text-reentry.png") });

      expect({ afterReentry, afterReplay, afterSend }).toEqual({
        afterReentry: submitted,
        afterReplay: "",
        afterSend: "",
      });
    } finally {
      await closeChat(fixture);
    }
  });
});
