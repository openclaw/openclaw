#!/usr/bin/env node
/**
 * fetch-changelog.mjs
 * Fetches trust8004 changelog via headless Chromium (bypasses Vercel bot-protection).
 *
 * Usage:  node scripts/fetch-changelog.mjs
 * Output: JSON array of changelog entries to stdout, errors to stderr.
 */
import { chromium } from "playwright-core";

const CHANGELOG_URL = "https://www.trust8004.xyz/changelog";
const CDP_ENDPOINT = process.env.CDP_ENDPOINT || "http://127.0.0.1:18800";
const TIMEOUT = 60_000;

async function fetchChangelog() {
  let browser;
  let ownBrowser = false;

  try {
    try {
      browser = await chromium.connectOverCDP(CDP_ENDPOINT, { timeout: 3000 });
    } catch {
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
    await page.goto(CHANGELOG_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT });

    // Poll until changelog entries appear (Vercel challenge + page render)
    let entries = null;
    const deadline = Date.now() + TIMEOUT;

    while (Date.now() < deadline) {
      entries = await page.evaluate(() => {
        const text = document.body.innerText;
        // Check if changelog content has loaded (look for date pattern)
        if (!/\d{4}-\d{2}-\d{2}/.test(text)) {
          return null;
        }

        const lines = text
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        const results = [];
        let i = 0;

        while (i < lines.length) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(lines[i])) {
            const date = lines[i];
            const version = lines[i + 1] || "";
            const type = lines[i + 2] || "";
            const title = lines[i + 3] || "";

            let description = "";
            const highlights = [];
            let j = i + 4;

            if (j < lines.length && !/^\d{4}-\d{2}-\d{2}$/.test(lines[j])) {
              description = lines[j];
              j++;
            }

            while (j < lines.length && !/^\d{4}-\d{2}-\d{2}$/.test(lines[j])) {
              highlights.push(lines[j]);
              j++;
            }

            results.push({ date, version, type, title, description, highlights });
            i = j;
          } else {
            i++;
          }
        }

        return results.length > 0 ? results : null;
      });

      if (entries) {
        break;
      }
      await page.waitForTimeout(3000);
    }

    await page.close();

    if (!entries || entries.length === 0) {
      process.stderr.write("Error: could not extract changelog entries within timeout\n");
      process.exit(1);
    }

    process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

void fetchChangelog();
