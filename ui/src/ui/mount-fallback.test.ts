// Control UI tests cover mount fallback behavior.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const indexHtmlPath = path.resolve(
  process.cwd(),
  path.basename(process.cwd()) === "ui" ? "index.html" : "ui/index.html",
);
type TestWindow = Window & typeof globalThis;

async function readIndexHtmlWithDelay(delayMs: number): Promise<string> {
  const html = await readFile(indexHtmlPath, "utf8");
  return html.replace(
    'data-openclaw-mount-timeout-ms="12000"',
    `data-openclaw-mount-timeout-ms="${delayMs}"`,
  );
}

function waitForWindowTimeout(window: TestWindow, delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

function createIsolatedWindow(): TestWindow {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const frameWindow = frame.contentWindow as TestWindow | null;
  if (!frameWindow) {
    throw new Error("failed to create isolated frame window");
  }
  return frameWindow;
}

function installFallbackShell(window: TestWindow, html: string): void {
  const parsed = new window.DOMParser().parseFromString(html, "text/html");
  window.document.head.innerHTML = parsed.head.innerHTML;
  window.document.body.innerHTML = parsed.body.innerHTML;

  const sentinel = Array.from(parsed.querySelectorAll<HTMLScriptElement>("script:not([src])")).find(
    (script) => script.textContent?.includes("openclaw-mount-fallback"),
  );
  if (!sentinel?.textContent) {
    throw new Error("Expected inline mount fallback script in index.html");
  }
  window.eval(sentinel.textContent);
}

function requireElementById<T extends HTMLElement>(
  window: TestWindow,
  id: string,
  constructor: new () => T,
): T {
  const element = window.document.getElementById(id);
  expect(element).toBeInstanceOf(constructor);
  if (!(element instanceof constructor)) {
    throw new Error(`Expected #${id}`);
  }
  return element;
}

/**
 * Installs a fetch mock on the given window. The iframe contentWindow does not
 * have its own `Response` constructor in jsdom, so we use the parent window's
 * `Response` to build the return value. The mock is defined as an own property
 * on the frameWindow so the eval'd inline script sees it.
 */
function installFetchMock(
  window: TestWindow,
  handler: (
    url: string,
    init?: RequestInit,
  ) => Promise<{ ok: boolean; status: number; body?: string }>,
): { mock: ReturnType<typeof vi.fn>; restore: () => void } {
  const mock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const result = await handler(url, init);
    // Use the parent (test) Response — the iframe lacks its own in jsdom
    return new Response(result.body ?? "", {
      status: result.status,
      headers: { "Content-Type": "text/html" },
    });
  });
  Object.defineProperty(window, "fetch", {
    value: mock,
    writable: true,
    configurable: true,
  });
  return {
    mock,
    restore: () => {
      try {
        delete (window as Record<string, unknown>).fetch;
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Installs a fetch mock that rejects all requests (simulates gateway down).
 */
function installFailingFetchMock(window: TestWindow): {
  mock: ReturnType<typeof vi.fn>;
  restore: () => void;
} {
  const mock = vi.fn(async (input: URL | RequestInfo) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    throw new Error(`NetworkError: ${url} unreachable`);
  });
  Object.defineProperty(window, "fetch", {
    value: mock,
    writable: true,
    configurable: true,
  });
  return {
    mock,
    restore: () => {
      try {
        delete (window as Record<string, unknown>).fetch;
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Installs a fetch mock that returns reachable (200) for the gateway probe URL
 * and the provided result for the bundle URL.
 */
function installMixedFetchMock(
  window: TestWindow,
  bundleOk: boolean,
): { mock: ReturnType<typeof vi.fn>; restore: () => void } {
  const probeUrl = window.location.href;
  return installFetchMock(window, async (url) => {
    if (url === probeUrl) {
      return { ok: true, status: 200, body: "ok" };
    }
    if (url === "/src/main.ts") {
      return { ok: bundleOk, status: bundleOk ? 200 : 500, body: bundleOk ? "export {}" : "" };
    }
    return { ok: false, status: 404, body: "" };
  });
}

describe("Control UI mount fallback", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows the static troubleshooting panel when the app element is never registered", async () => {
    const frameWindow = createIsolatedWindow();
    expect(frameWindow.customElements.get("openclaw-app")).toBeUndefined();
    // Install a reachable fetch mock so the probe keeps the default "did not start" message
    const { restore } = installMixedFetchMock(frameWindow, true);
    installFallbackShell(frameWindow, await readIndexHtmlWithDelay(1));
    await waitForWindowTimeout(frameWindow, 10);

    const fallback = requireElementById(
      frameWindow,
      "openclaw-mount-fallback",
      frameWindow.HTMLElement,
    );
    expect(fallback.hidden).toBe(false);
    expect([...frameWindow.document.body.classList]).toEqual(["openclaw-mount-fallback-active"]);
    // Wait for the probe to settle so the message updates
    await waitForWindowTimeout(frameWindow, 10);
    expect(fallback.querySelector("h1")?.textContent?.trim()).toBe("Control UI did not start");
    expect(fallback.querySelector("a")?.textContent?.trim()).toBe("Control UI troubleshooting");
    expect(frameWindow.document.activeElement).toBeInstanceOf(frameWindow.HTMLElement);
    expect([...(frameWindow.document.activeElement as HTMLElement).classList]).toEqual([
      "mount-fallback__panel",
    ]);

    const waitButton = requireElementById(
      frameWindow,
      "openclaw-mount-wait",
      frameWindow.HTMLButtonElement,
    );
    waitButton.click();
    expect(fallback.hidden).toBe(true);
    expect([...frameWindow.document.body.classList]).toEqual([]);

    await waitForWindowTimeout(frameWindow, 10);
    expect(fallback.hidden).toBe(false);

    restore();
  });

  it("keeps the fallback hidden when the app element registers before the timeout", async () => {
    const frameWindow = createIsolatedWindow();
    const { restore } = installMixedFetchMock(frameWindow, true);
    installFallbackShell(frameWindow, await readIndexHtmlWithDelay(25));
    if (!frameWindow.customElements.get("openclaw-app")) {
      frameWindow.customElements.define("openclaw-app", class extends frameWindow.HTMLElement {});
    }
    await frameWindow.customElements.whenDefined("openclaw-app");
    await waitForWindowTimeout(frameWindow, 35);

    const fallback = requireElementById(
      frameWindow,
      "openclaw-mount-fallback",
      frameWindow.HTMLElement,
    );
    expect(fallback.hidden).toBe(true);
    expect([...frameWindow.document.body.classList]).toEqual([]);

    restore();
  });

  it("re-fetches the bundle when 'Keep waiting' is clicked", async () => {
    const frameWindow = createIsolatedWindow();
    const { mock: fetchMock, restore } = installMixedFetchMock(frameWindow, true);

    installFallbackShell(frameWindow, await readIndexHtmlWithDelay(1));
    await waitForWindowTimeout(frameWindow, 10);

    const fallback = requireElementById(
      frameWindow,
      "openclaw-mount-fallback",
      frameWindow.HTMLElement,
    );
    expect(fallback.hidden).toBe(false);

    const waitButton = requireElementById(
      frameWindow,
      "openclaw-mount-wait",
      frameWindow.HTMLButtonElement,
    );
    const retryStatus = requireElementById(
      frameWindow,
      "openclaw-mount-retry-status",
      frameWindow.HTMLParagraphElement,
    );

    // Click "Keep waiting" — should start retry sequence
    waitButton.click();
    expect(fallback.hidden).toBe(true);
    expect(retryStatus.hidden).toBe(false);
    expect(retryStatus.textContent).toContain("Retrying");

    // Wait for the fetch to be called
    await waitForWindowTimeout(frameWindow, 10);

    // fetch should have been called for the bundle retry
    const fetchUrls = fetchMock.mock.calls.map((c) => {
      const input = c[0];
      return typeof input === "string" ? input : (input as URL).toString();
    });
    expect(fetchUrls.some((url) => url === "/src/main.ts")).toBe(true);

    restore();
  });

  it("shows gateway restarting message when probe detects unreachable gateway", async () => {
    const frameWindow = createIsolatedWindow();
    const { restore } = installFailingFetchMock(frameWindow);

    installFallbackShell(frameWindow, await readIndexHtmlWithDelay(1));
    // Wait for fallback to show and probe to settle
    await waitForWindowTimeout(frameWindow, 50);

    const fallback = requireElementById(
      frameWindow,
      "openclaw-mount-fallback",
      frameWindow.HTMLElement,
    );
    expect(fallback.hidden).toBe(false);

    const titleEl = requireElementById(
      frameWindow,
      "openclaw-mount-fallback-title",
      frameWindow.HTMLElement,
    );

    // After the probe rejects, the title should say "starting up"
    await waitForWindowTimeout(frameWindow, 10);
    expect(titleEl.textContent).toBe("Control UI is starting up");

    restore();
  });

  it("shows extension blocking message when probe detects reachable gateway", async () => {
    const frameWindow = createIsolatedWindow();
    const { restore } = installMixedFetchMock(frameWindow, true);

    installFallbackShell(frameWindow, await readIndexHtmlWithDelay(1));
    await waitForWindowTimeout(frameWindow, 50);

    const fallback = requireElementById(
      frameWindow,
      "openclaw-mount-fallback",
      frameWindow.HTMLElement,
    );
    expect(fallback.hidden).toBe(false);

    const titleEl = requireElementById(
      frameWindow,
      "openclaw-mount-fallback-title",
      frameWindow.HTMLElement,
    );

    // After the probe resolves as reachable, the title should say "did not start"
    await waitForWindowTimeout(frameWindow, 10);
    expect(titleEl.textContent).toBe("Control UI did not start");

    restore();
  });

  it("attempts bundle fetch at least once during retry sequence", async () => {
    const frameWindow = createIsolatedWindow();
    const { mock: fetchMock, restore } = installFailingFetchMock(frameWindow);

    installFallbackShell(frameWindow, await readIndexHtmlWithDelay(1));
    await waitForWindowTimeout(frameWindow, 10);

    const waitButton = requireElementById(
      frameWindow,
      "openclaw-mount-wait",
      frameWindow.HTMLButtonElement,
    );
    const retryStatus = requireElementById(
      frameWindow,
      "openclaw-mount-retry-status",
      frameWindow.HTMLParagraphElement,
    );

    // Click "Keep waiting" to start retry sequence
    waitButton.click();
    expect(retryStatus.hidden).toBe(false);

    // Wait for the first fetch attempt to settle
    await waitForWindowTimeout(frameWindow, 10);

    // The bundle fetch should have been attempted at least once
    const bundleFetchCalls = fetchMock.mock.calls.filter((c) => {
      const input = c[0];
      const url = typeof input === "string" ? input : (input as URL).toString();
      return url === "/src/main.ts";
    });
    expect(bundleFetchCalls.length).toBeGreaterThanOrEqual(1);

    // Retry status should show some message (either retrying or backoff)
    expect(retryStatus.textContent).toBeTruthy();

    restore();
  });
});
