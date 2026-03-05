#!/usr/bin/env node
/**
 * fetch-metrics.mjs
 * Fetches trust8004 daily metrics via headless Chromium (bypasses Vercel bot-protection).
 *
 * In Docker: connects to existing Chromium CDP on port 18800.
 * Locally:   launches Chrome/Chromium directly.
 *
 * Usage:  node scripts/fetch-metrics.mjs
 * Output: JSON to stdout, errors to stderr.
 */
import { chromium } from "playwright-core";

const API_URL = "https://trust8004.xyz/api/v2/metrics/daily-summary";
const CDP_ENDPOINT = process.env.CDP_ENDPOINT || "http://127.0.0.1:18800";
const TIMEOUT = 30_000;

async function fetchMetrics() {
  let browser;
  let ownBrowser = false;

  try {
    // 1. Try existing CDP (Docker container)
    try {
      browser = await chromium.connectOverCDP(CDP_ENDPOINT, { timeout: 3000 });
    } catch {
      // 2. Fallback: launch own browser
      const execPath =
        process.env.CHROME_PATH ||
        (process.platform === "darwin"
          ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
          : undefined);

      browser = await chromium.launch({
        executablePath: execPath,
        headless: true,
        args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
      });
      ownBrowser = true;
    }

    const context = ownBrowser
      ? await browser.newContext()
      : browser.contexts()[0] || (await browser.newContext());

    const page = await context.newPage();
    await page.goto(API_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT });

    // Poll until we get valid JSON (Vercel challenge may take a few seconds)
    let json = null;
    const deadline = Date.now() + TIMEOUT;

    while (Date.now() < deadline) {
      const text = await page.evaluate(() => document.body.innerText.trim());
      if (text.startsWith("{")) {
        try {
          json = JSON.parse(text);
          break;
        } catch {
          // not valid JSON yet, keep polling
        }
      }
      await page.waitForTimeout(2000);
    }

    await page.close();

    if (!json) {
      process.stderr.write("Error: could not extract JSON within timeout\n");
      process.exit(1);
    }

    process.stdout.write(JSON.stringify(json, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  } finally {
    if (browser) {
      // For CDP connections, close() disconnects without killing the browser.
      // For launched browsers, close() terminates the process.
      await browser.close().catch(() => {});
    }
  }
}

void fetchMetrics();
