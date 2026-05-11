import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const indexHtmlPath = path.resolve(process.cwd(), "ui/index.html");

async function readIndexHtmlWithDelay(delayMs: number): Promise<string> {
  const html = await readFile(indexHtmlPath, "utf8");
  return html.replace(
    'data-openclaw-mount-timeout-ms="12000"',
    `data-openclaw-mount-timeout-ms="${delayMs}"`,
  );
}

function waitForWindowTimeout(window: Window, delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

function installFallbackShell(html: string): void {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;

  const sentinel = Array.from(parsed.querySelectorAll("script:not([src])")).find((script) =>
    script.textContent?.includes("openclaw-mount-fallback"),
  );
  expect(sentinel).toBeTruthy();
  window.eval(sentinel?.textContent ?? "");
}

describe("Control UI mount fallback", () => {
  afterEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("shows the static troubleshooting panel when the app element is never registered", async () => {
    installFallbackShell(await readIndexHtmlWithDelay(1));
    await waitForWindowTimeout(window, 10);

    const fallback = document.getElementById("openclaw-mount-fallback");
    expect(fallback?.hidden).toBe(false);
    expect(document.body.classList.contains("openclaw-mount-fallback-active")).toBe(true);
    expect(fallback?.textContent).toContain("Control UI did not start");
    expect(fallback?.textContent).toContain("Control UI troubleshooting");
  });

  it("keeps the fallback hidden when the app element registers before the timeout", async () => {
    installFallbackShell(await readIndexHtmlWithDelay(25));
    if (!window.customElements.get("openclaw-app")) {
      window.customElements.define("openclaw-app", class extends HTMLElement {});
    }
    await window.customElements.whenDefined("openclaw-app");
    await waitForWindowTimeout(window, 35);

    const fallback = document.getElementById("openclaw-mount-fallback");
    expect(fallback?.hidden).toBe(true);
    expect(document.body.classList.contains("openclaw-mount-fallback-active")).toBe(false);
  });
});
