#!/usr/bin/env python3
"""
Subscriber Patrol — 本機 Chrome 版
用 Playwright 連接已開的 Chrome/Brave，巡邏 Threads subscriber profiles。

用法:
  python3 patrol.py scan <username> [limit]   # 掃一個人
  python3 patrol.py batch [top_n]             # 批量掃 top N subscribers
  python3 patrol.py report                    # 看最近巡邏結果
  python3 patrol.py engage <username> <text>  # 去對方帖下留言（via Chrome）
"""

import sys
import json
import sqlite3
import time
from pathlib import Path
from datetime import datetime, timezone

SOCIAL_DB = Path(__file__).parent / "social.db"
PATROL_DB = Path(__file__).parent / "patrol.db"
CDP_URL = "http://localhost:9223"  # Headless Brave (9223) > visible Brave (9222)


def get_patrol_conn():
    conn = sqlite3.connect(str(PATROL_DB), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS subscriber_posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            post_text TEXT,
            post_date TEXT,
            post_url TEXT,
            likes INTEGER DEFAULT 0,
            has_media INTEGER DEFAULT 0,
            scraped_at TEXT NOT NULL,
            engagement_value TEXT,  -- 'skip' | 'like' | 'reply' | null (not assessed)
            draft_text TEXT,
            UNIQUE(username, post_url)
        );
        CREATE TABLE IF NOT EXISTS patrol_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            display_name TEXT,
            followers INTEGER DEFAULT 0,
            bio TEXT,
            posts_found INTEGER DEFAULT 0,
            scraped_at TEXT NOT NULL,
            error TEXT
        );
    """)
    return conn


def scan_profile(username, limit=5):
    """Scan a subscriber's Threads profile using local Chrome."""
    from playwright.sync_api import sync_playwright

    print(f"🔍 Patrolling @{username}...")

    with sync_playwright() as p:
        try:
            browser = p.chromium.connect_over_cdp(CDP_URL)
        except Exception as e:
            print(f"  ❌ Cannot connect to Chrome at {CDP_URL}: {e}")
            print("  Make sure Chrome/Brave is running with --remote-debugging-port=9222")
            return None

        # Use existing context to keep login state
        context = browser.contexts[0] if browser.contexts else browser.new_context()
        page = context.new_page()

        result = {
            "username": username,
            "display_name": "",
            "followers": 0,
            "bio": "",
            "posts": [],
            "error": None,
        }

        try:
            page.goto(f"https://www.threads.net/@{username}", timeout=20000)
            page.wait_for_selector('[role="region"]', timeout=10000)
            time.sleep(2)

            JS_EXTRACT = """([uname, maxPosts]) => {
                const result = { display_name: '', followers: 0, bio: '', posts: [] };
                const region = document.querySelector('[role="region"]');

                // Display name
                const headings = document.querySelectorAll('h1, h2');
                for (const h of headings) {
                    const t = h.textContent?.trim() || '';
                    if (t && !t.includes('@') && t.length < 50 && t !== uname) {
                        result.display_name = t; break;
                    }
                }

                // Followers (handles "5.7萬位粉絲" and "57,473位粉絲")
                const allText = document.body.innerText || '';
                const fm = allText.match(/([\d,.]+)\s*萬?\s*位粉絲/);
                if (fm) {
                    if (fm[0].includes('萬')) {
                        result.followers = Math.round(parseFloat(fm[1]) * 10000);
                    } else {
                        result.followers = parseInt(fm[1].replace(/,/g, ''));
                    }
                }

                // Bio
                if (region) {
                    const kids = region.children;
                    for (let i = 0; i < Math.min(kids.length, 10); i++) {
                        const t = kids[i].textContent?.trim() || '';
                        if (t.length > 10 && t.length < 500 &&
                            !t.includes('位粉絲') && !t.includes('串文') &&
                            !t.includes('回覆') && t !== result.display_name) {
                            result.bio = t; break;
                        }
                    }
                }

                // Posts: parse from region innerText
                const regionText = region?.innerText || '';
                const lines = regionText.split('\\n').map(l => l.trim()).filter(Boolean);

                let i = 0;
                while (i < lines.length && result.posts.length < maxPosts) {
                    if (lines[i] === uname) {
                        const dateLine = lines[i+1] || '';
                        if (/\\d/.test(dateLine) && dateLine.length < 30) {
                            const textLines = [];
                            let likes = 0;
                            let j = i + 2;
                            while (j < lines.length && lines[j] !== uname) {
                                const line = lines[j];
                                if (/^(讚|回覆|轉發|分享|更多|追蹤|載入中|串文|影音內容|已釘選|Pin icon)$/.test(line)) { j++; continue; }
                                if (/^[\\d,]+$/.test(line)) {
                                    const n = parseInt(line.replace(/,/g, ''));
                                    if (n > likes) likes = n;
                                    j++; continue;
                                }
                                if (line.length > 5) textLines.push(line);
                                j++;
                            }

                            // Find post URL — ONLY match posts by this user (not reposts)
                            const postLinks = document.querySelectorAll('a[href*="/post/"]');
                            let postUrl = '';
                            for (const pl of postLinks) {
                                if (pl.textContent?.trim()?.includes(dateLine)) {
                                    const href = pl.getAttribute('href') || '';
                                    const m = href.match(/@[\\w.]+\\/post\\/\\w+/);
                                    // Only accept if URL contains the subscriber's username
                                    if (m && href.includes('@' + uname + '/')) {
                                        postUrl = 'https://www.threads.net/' + m[0];
                                        break;
                                    }
                                }
                            }

                            if (textLines.length > 0) {
                                result.posts.push({
                                    text: textLines.join('\\n'),
                                    date: dateLine,
                                    likes, url: postUrl, has_media: false
                                });
                            }
                            i = j; continue;
                        }
                    }
                    i++;
                }
                return result;
            }"""

            data = page.evaluate(JS_EXTRACT, [username, limit])

            result.update(data)

        except Exception as e:
            result["error"] = str(e)
            print(f"  ❌ Error: {e}")
        finally:
            page.close()

        # Save to DB
        conn = get_patrol_conn()
        now = datetime.now(timezone.utc).isoformat()

        conn.execute(
            "INSERT INTO patrol_log (username, display_name, followers, bio, posts_found, scraped_at, error) VALUES (?,?,?,?,?,?,?)",
            (username, result["display_name"], result["followers"], result["bio"],
             len(result["posts"]), now, result["error"])
        )

        for post in result["posts"]:
            conn.execute(
                "INSERT OR IGNORE INTO subscriber_posts (username, post_text, post_date, post_url, likes, has_media, scraped_at) VALUES (?,?,?,?,?,?,?)",
                (username, post["text"], post["date"], post["url"], post["likes"],
                 1 if post["has_media"] else 0, now)
            )

        conn.commit()
        conn.close()

        if result["posts"]:
            print(f"  ✅ @{username} ({result['display_name']}) — {result['followers']} followers, {len(result['posts'])} posts")
            for p in result["posts"]:
                likes_str = f" ♥{p['likes']}" if p["likes"] else ""
                print(f"    [{p['date']}]{likes_str} 「{p['text'][:80]}」")
        elif not result["error"]:
            print(f"  ⚪ @{username} — no posts found")

        return result


def batch_scan(top_n=10):
    """Scan top N subscribers by depth."""
    social_conn = sqlite3.connect(str(SOCIAL_DB), timeout=30)
    social_conn.row_factory = sqlite3.Row

    rows = social_conn.execute("""
        SELECT ch.handle as username, c.engagement_depth, c.tier, c.stance
        FROM contacts c
        JOIN contact_handles ch ON c.canonical_id = ch.canonical_id
        WHERE ch.channel = 'threads' AND c.engagement_depth >= 5
        ORDER BY c.engagement_depth DESC
        LIMIT ?
    """, (top_n,)).fetchall()
    social_conn.close()

    print(f"📋 Batch patrol: {len(rows)} subscribers\n")

    results = []
    for r in rows:
        result = scan_profile(r["username"], limit=3)
        results.append(result)
        time.sleep(3)  # Gentle pacing

    # Summary
    with_posts = [r for r in results if r and r["posts"]]
    print(f"\n📊 Summary: {len(with_posts)}/{len(results)} have posts")

    return results


def report():
    """Show recent patrol findings."""
    conn = get_patrol_conn()

    # Recent patrols
    logs = conn.execute("""
        SELECT username, display_name, followers, posts_found, scraped_at, error
        FROM patrol_log ORDER BY scraped_at DESC LIMIT 20
    """).fetchall()

    if not logs:
        print("No patrol data yet. Run: patrol.py scan <username>")
        return

    print("📋 Recent patrols:\n")
    for l in logs:
        status = f"✅ {l['posts_found']} posts" if not l["error"] else f"❌ {l['error'][:40]}"
        print(f"  @{l['username']:25s} {l['followers']:>6,} followers  {status}")

    # Interesting posts (high likes or recent)
    posts = conn.execute("""
        SELECT username, post_text, post_date, likes, post_url, engagement_value
        FROM subscriber_posts
        WHERE engagement_value IS NULL OR engagement_value = 'reply'
        ORDER BY likes DESC, scraped_at DESC
        LIMIT 10
    """).fetchall()

    if posts:
        print(f"\n🎯 Top posts to engage with:\n")
        for p in posts:
            likes_str = f" ♥{p['likes']}" if p["likes"] else ""
            assessed = f" [{p['engagement_value']}]" if p["engagement_value"] else ""
            print(f"  @{p['username']}{likes_str}{assessed}")
            print(f"    「{p['post_text'][:100]}」")
            print(f"    {p['post_url']}")
            print()

    conn.close()


def engage(username, text, post_url=None):
    """Post a comment on a subscriber's Threads post via Playwright."""
    from playwright.sync_api import sync_playwright

    # If no URL, find their top post from patrol.db
    if not post_url:
        conn = get_patrol_conn()
        row = conn.execute(
            "SELECT post_url, post_text FROM subscriber_posts WHERE username=? AND post_url != '' ORDER BY likes DESC LIMIT 1",
            (username,)
        ).fetchone()
        conn.close()
        if not row or not row["post_url"]:
            print(f"  ❌ No post URL for @{username}. Run: patrol.py scan {username}")
            return False
        post_url = row["post_url"]
        print(f"  Target: {row['post_text'][:60]}...")

    print(f"  💬 Engaging @{username} at {post_url}")

    with sync_playwright() as p:
        try:
            browser = p.chromium.connect_over_cdp(CDP_URL)
        except Exception as e:
            print(f"  ❌ Chrome not available: {e}")
            return False

        context = browser.contexts[0] if browser.contexts else browser.new_context()
        page = context.new_page()

        try:
            page.goto(post_url, timeout=20000)
            import time
            time.sleep(4)

            reply_svg = page.locator('svg[aria-label="回覆"]').first
            reply_svg.click()
            time.sleep(3)

            editors = page.locator('[contenteditable="true"]').all()
            if not editors:
                print("  ❌ No editor found after clicking reply")
                return False

            editors[0].click()
            time.sleep(0.5)
            page.keyboard.type(text, delay=30)
            time.sleep(1)

            post_btn = page.locator('div[role="button"]:has-text("發佈")').first
            if post_btn.count() > 0:
                post_btn.click()
                time.sleep(3)
                print(f"  ✅ Posted on @{username}!")

                # Log to patrol.db
                conn = get_patrol_conn()
                conn.execute(
                    "UPDATE subscriber_posts SET engagement_value='reply' WHERE username=? AND post_url=?",
                    (username, post_url)
                )
                conn.commit()
                conn.close()
                return True
            else:
                print("  ❌ No post button found")
                return False
        except Exception as e:
            print(f"  ❌ Error: {e}")
            return False
        finally:
            page.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(0)

    cmd = sys.argv[1]
    if cmd == "scan" and len(sys.argv) >= 3:
        limit = int(sys.argv[3]) if len(sys.argv) > 3 else 5
        scan_profile(sys.argv[2], limit)
    elif cmd == "batch":
        top_n = int(sys.argv[2]) if len(sys.argv) > 2 else 10
        batch_scan(top_n)
    elif cmd == "report":
        report()
    elif cmd == "engage" and len(sys.argv) >= 4:
        url = sys.argv[4] if len(sys.argv) > 4 else None
        engage(sys.argv[2], " ".join(sys.argv[3:4]), url)
    else:
        print(__doc__)
