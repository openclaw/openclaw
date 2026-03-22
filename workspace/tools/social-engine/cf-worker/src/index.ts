/**
 * Threads Patrol — CF Worker + Browser Rendering (Puppeteer)
 *
 * GET /patrol?username=yankrays&limit=5
 *   → CF 無頭瀏覽器渲染 Threads profile → JSON
 *
 * GET /health → { ok: true }
 */

import puppeteer from "@cloudflare/puppeteer";

interface Env {
  BROWSER: Fetcher;
}

interface ThreadPost {
  text: string;
  date: string;
  likes: number;
  url: string;
  has_media: boolean;
}

interface PatrolResult {
  username: string;
  display_name: string;
  followers: number;
  bio: string;
  posts: ThreadPost[];
  scraped_at: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, ts: new Date().toISOString() });
    }

    if (url.pathname === "/patrol") {
      const username = url.searchParams.get("username");
      const limit = parseInt(url.searchParams.get("limit") || "5");

      if (!username) {
        return Response.json({ error: "username required" }, { status: 400 });
      }

      try {
        const result = await patrolProfile(env, username, limit);
        return Response.json(result);
      } catch (e: any) {
        return Response.json({ error: e.message, username }, { status: 500 });
      }
    }

    if (url.pathname === "/test") {
      try {
        const browser = await puppeteer.launch(env.BROWSER);
        const page = await browser.newPage();
        await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 10000 });
        const title = await page.title();
        await browser.close();
        return Response.json({ ok: true, title });
      } catch (e: any) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function patrolProfile(env: Env, username: string, limit: number): Promise<PatrolResult> {
  const browser = await puppeteer.launch(env.BROWSER, {
    protocolTimeout: 25000,
  });
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1280, height: 900 });

    await page.goto(`https://www.threads.net/@${username}`, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });

    // Wait for content region to hydrate
    await page.waitForSelector('[role="region"]', { timeout: 8000 }).catch(() => {});
    // Extra wait for JS hydration
    await new Promise((r) => setTimeout(r, 2000));

    // Extract profile + posts from DOM
    const data = await page.evaluate((maxPosts: number) => {
      const result = {
        display_name: "",
        followers: 0,
        bio: "",
        posts: [] as any[],
      };

      // Display name: first h2 in region
      const region = document.querySelector('[role="region"]');
      const h2 = region?.querySelector("h2");
      if (h2) {
        result.display_name = h2.textContent?.trim() || "";
      }

      // Followers
      const allText = document.body.innerText || "";
      const fm = allText.match(/([\d,]+)\s*位粉絲/);
      if (fm) {
        result.followers = parseInt(fm[1].replace(/,/g, ""));
      }

      // Bio: spans in region before the tab links
      if (region) {
        const children = region.children;
        for (let i = 0; i < Math.min(children.length, 10); i++) {
          const t = children[i].textContent?.trim() || "";
          if (
            t.length > 10 &&
            t.length < 500 &&
            !t.includes("位粉絲") &&
            !t.includes("串文") &&
            !t.includes("回覆") &&
            t !== result.display_name
          ) {
            result.bio = t;
            break;
          }
        }
      }

      // Posts: find all post links
      const postLinks = document.querySelectorAll('a[href*="/post/"]');
      const seen = new Set<string>();

      for (const link of postLinks) {
        if (result.posts.length >= maxPosts) {
          break;
        }

        const href = link.getAttribute("href") || "";
        // Normalize: just the /post/ part
        const postPath = href.match(/@[\w.]+\/post\/\w+/)?.[0];
        if (!postPath || seen.has(postPath)) {
          continue;
        }
        seen.add(postPath);

        // Walk up to find container
        let el: HTMLElement | null = link as HTMLElement;
        for (let i = 0; i < 6; i++) {
          if (el?.parentElement) {
            el = el.parentElement;
          }
        }
        if (!el) {
          continue;
        }

        // Extract text (skip UI labels)
        const skipWords = [
          "位粉絲",
          "天前",
          "讚",
          "回覆",
          "轉發",
          "分享",
          "更多",
          "追蹤",
          "載入中",
          "串文",
          "影音內容",
        ];
        const textBlocks: string[] = [];
        const divs = el.querySelectorAll("div, span");
        for (const d of divs) {
          const t = d.textContent?.trim() || "";
          if (t.length < 15 || t.length > 800) {
            continue;
          }
          if (skipWords.some((w) => t.includes(w))) {
            continue;
          }
          // Skip dates
          if (/^\d{4}年\d+月/.test(t)) {
            continue;
          }
          if (/^\d+天前$/.test(t)) {
            continue;
          }
          // Dedupe
          if (!textBlocks.some((b) => b.includes(t) || t.includes(b))) {
            textBlocks.push(t);
          }
        }

        // Date from link text
        const dateText = link.textContent?.trim() || "";

        // Likes: find numeric-only spans
        let likes = 0;
        const spans = el.querySelectorAll("span");
        for (const s of spans) {
          const t = s.textContent?.trim() || "";
          if (/^[\d,]+$/.test(t)) {
            const n = parseInt(t.replace(/,/g, ""));
            if (n > likes) {
              likes = n;
            }
          }
        }

        // Media
        const hasMedia = el.querySelectorAll('img[src*="scontent"]').length > 0;

        if (textBlocks.length > 0) {
          result.posts.push({
            text: textBlocks.join("\n"),
            date: dateText,
            likes,
            url: "https://www.threads.net/" + postPath,
            has_media: hasMedia,
          });
        }
      }

      return result;
    }, limit);

    return {
      username,
      ...data,
      scraped_at: new Date().toISOString(),
    };
  } finally {
    await browser.close();
  }
}
