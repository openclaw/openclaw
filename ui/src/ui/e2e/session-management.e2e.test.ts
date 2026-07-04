// Control UI tests cover session management through the sidebar and chat picker.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;

function sessionRow(
  key: string,
  label: string,
  updatedAt: number,
  options: { pinned?: boolean; pinnedAt?: number; hasActiveRun?: boolean; status?: string } = {},
) {
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
    ...options,
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
    hasMore: false,
    limitApplied: 50,
    nextOffset: null,
    offset: 0,
    path: "",
    sessions,
    totalCount: sessions.length,
    ts: Date.now(),
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object value");
  }
  return value as Record<string, unknown>;
}

async function waitForPatch(
  gateway: MockGatewayControls,
  predicate: (params: Record<string, unknown>) => boolean,
): Promise<MockGatewayRequest> {
  const deadline = Date.now() + 10_000;
  let requests: MockGatewayRequest[] = [];
  while (Date.now() < deadline) {
    requests = await gateway.getRequests("sessions.patch");
    const match = requests.find((request) => predicate(requireRecord(request.params)));
    if (match) {
      return match;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error(`No matching sessions.patch request found: ${JSON.stringify(requests)}`);
}

function actionOpacity(button: Locator): Promise<string> {
  return button.evaluate((element) => globalThis.getComputedStyle(element).opacity);
}

async function captureUiProof(page: Page, fileName: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  const artifactDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "thread-management");
  await mkdir(artifactDir, { recursive: true });
  await page.screenshot({ fullPage: true, path: path.join(artifactDir, fileName) });
}

describeControlUiE2e("Control UI session management mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("manages sessions through the sidebar and chat picker", async () => {
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", baseTime),
          sessionRow("agent:main:release", "Release planning", baseTime - 60_000, {
            pinned: true,
            pinnedAt: baseTime - 30_000,
          }),
          sessionRow("agent:main:migration", "Data migration", baseTime - 90_000, {
            hasActiveRun: true,
            status: "running",
          }),
          sessionRow("agent:main:research", "Research notes", baseTime - 120_000),
        ]),
        "sessions.patch": {},
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);

      // Sidebar recents: pinned first, live-run spinner, hover-revealed actions.
      const sidebarRows = page.locator(".sidebar-recent-sessions__list .sidebar-recent-session");
      await sidebarRows.first().waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => sidebarRows.first().textContent()).toContain("Release planning");
      const sidebarMigration = sidebarRows.filter({ hasText: "Data migration" });
      await expect
        .poll(() => sidebarMigration.locator(".session-run-spinner").isVisible())
        .toBe(true);

      const sidebarResearch = sidebarRows.filter({ hasText: "Research notes" });
      const sidebarResearchPin = sidebarResearch.getByRole("button", { name: "Pin session" });
      await page.mouse.move(900, 500);
      await expect.poll(() => actionOpacity(sidebarResearchPin)).toBe("0");
      const sidebarReleasePin = sidebarRows
        .filter({ hasText: "Release planning" })
        .getByRole("button", { name: "Unpin session" });
      // Pinned badge stays visible without hover.
      await expect.poll(() => actionOpacity(sidebarReleasePin)).toBe("1");
      await sidebarResearch.hover();
      await expect.poll(() => actionOpacity(sidebarResearchPin)).toBe("1");
      await captureUiProof(page, "sidebar-sessions.png");

      // Chat picker: single-line rows with hover-revealed management actions.
      await page.getByRole("button", { name: "Search sessions" }).click();
      const releaseRow = page
        .locator(".chat-session-picker__option-row")
        .filter({ hasText: "Release planning" });
      await releaseRow.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => releaseRow.getByRole("button").count()).toBe(3);

      const migrationRow = page
        .locator(".chat-session-picker__option-row")
        .filter({ hasText: "Data migration" });
      await expect.poll(() => migrationRow.locator(".session-run-spinner").isVisible()).toBe(true);

      const mainRow = page.locator(".chat-session-picker__option-row").filter({ hasText: "Main" });
      await expect
        .poll(() => mainRow.getByRole("button", { name: "Archive session" }).isDisabled())
        .toBe(true);

      const researchRow = page
        .locator(".chat-session-picker__option-row")
        .filter({ hasText: "Research notes" });
      const researchArchive = researchRow.getByRole("button", { name: "Archive session" });
      await page.mouse.move(900, 500);
      await expect.poll(() => actionOpacity(researchArchive)).toBe("0");
      await expect
        .poll(() => actionOpacity(releaseRow.getByRole("button", { name: "Unpin session" })))
        .toBe("1");
      await researchRow.hover();
      await expect.poll(() => actionOpacity(researchArchive)).toBe("1");
      await captureUiProof(page, "chat-session-management.png");

      await releaseRow.hover();
      await releaseRow.getByRole("button", { name: "Unpin session" }).click();
      const pinPatch = await waitForPatch(
        gateway,
        (params) => params.key === "agent:main:release" && params.pinned === false,
      );
      expect(requireRecord(pinPatch.params)).toMatchObject({
        key: "agent:main:release",
        pinned: false,
      });

      page.once("dialog", (dialog) => dialog.accept("Launch plan"));
      await releaseRow.hover();
      await releaseRow.getByRole("button", { name: "Rename session" }).click();
      const renamePatch = await waitForPatch(
        gateway,
        (params) => params.key === "agent:main:release" && params.label === "Launch plan",
      );
      expect(requireRecord(renamePatch.params)).toMatchObject({
        key: "agent:main:release",
        label: "Launch plan",
      });

      await researchRow.hover();
      await researchArchive.click();
      const archivePatch = await waitForPatch(
        gateway,
        (params) => params.key === "agent:main:research" && params.archived === true,
      );
      expect(requireRecord(archivePatch.params)).toMatchObject({
        archived: true,
        key: "agent:main:research",
      });
    } finally {
      await context.close();
    }
  });
});
