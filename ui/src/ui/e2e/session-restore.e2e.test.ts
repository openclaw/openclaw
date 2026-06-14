// Control UI E2E tests cover persisted session restore behavior.
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
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

const devGatewayUrl = "ws://127.0.0.1:18789";
const devSettingsKey = `openclaw.control.settings.v1:${devGatewayUrl}`;
const legacyRoutedSessionKey = "agent:discord:direct:legacy-user";
const scopedRoutedSessionKey = "agent:telegram:direct:scoped-user";

let browser: Browser;
let server: ControlUiE2eServer;

async function openControlUiWithSettings(page: Page, settings: Record<string, unknown>) {
  await installMockGateway(page);
  await page.addInitScript(
    ({ key, value }) => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem(key, JSON.stringify(value));
    },
    { key: devSettingsKey, value: settings },
  );
  await page.goto(server.baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("openclaw-app");
}

async function readRestoredSessionSelection(page: Page) {
  return page.evaluate(() => {
    const app = document.querySelector("openclaw-app") as
      | (Element & {
          settings?: { lastActiveSessionKey?: string; sessionKey?: string };
          sessionKey?: string;
        })
      | null;
    return {
      hostSessionKey: app?.sessionKey ?? null,
      lastActiveSessionKey: app?.settings?.lastActiveSessionKey ?? null,
      sessionKey: app?.settings?.sessionKey ?? null,
    };
  });
}

function persistedSettings(
  selection: { lastActiveSessionKey: string; sessionKey: string },
  sessionsByGateway?: Record<string, { lastActiveSessionKey: string; sessionKey: string }>,
) {
  return {
    borderRadius: 50,
    chatShowThinking: true,
    chatShowToolCalls: true,
    gatewayUrl: devGatewayUrl,
    navCollapsed: false,
    navGroupsCollapsed: {},
    navWidth: 220,
    splitRatio: 0.6,
    theme: "claw",
    themeMode: "system",
    ...selection,
    ...(sessionsByGateway ? { sessionsByGateway } : {}),
  };
}

describeControlUiE2e("Control UI session restore E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to a compatible browser, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("normalizes legacy top-level routed sessions while preserving scoped routed sessions", async () => {
    const scopedContext = await browser.newContext({ serviceWorkers: "block" });
    const scopedPage = await scopedContext.newPage();
    try {
      await openControlUiWithSettings(
        scopedPage,
        persistedSettings(
          {
            lastActiveSessionKey: legacyRoutedSessionKey,
            sessionKey: legacyRoutedSessionKey,
          },
          {
            [devGatewayUrl]: {
              lastActiveSessionKey: scopedRoutedSessionKey,
              sessionKey: scopedRoutedSessionKey,
            },
          },
        ),
      );

      await expect
        .poll(() => readRestoredSessionSelection(scopedPage))
        .toEqual({
          hostSessionKey: scopedRoutedSessionKey,
          lastActiveSessionKey: scopedRoutedSessionKey,
          sessionKey: scopedRoutedSessionKey,
        });
    } finally {
      await scopedContext.close();
    }

    const legacyContext = await browser.newContext({ serviceWorkers: "block" });
    const legacyPage = await legacyContext.newPage();
    try {
      await openControlUiWithSettings(
        legacyPage,
        persistedSettings({
          lastActiveSessionKey: legacyRoutedSessionKey,
          sessionKey: legacyRoutedSessionKey,
        }),
      );

      await expect
        .poll(() => readRestoredSessionSelection(legacyPage))
        .toEqual({
          hostSessionKey: "main",
          lastActiveSessionKey: "main",
          sessionKey: "main",
        });
    } finally {
      await legacyContext.close();
    }
  });
});
