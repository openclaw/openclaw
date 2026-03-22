#!/usr/bin/env python3
"""
Threads Scheduler — 用 Playwright 操作 Threads UI 排程發帖

用法:
  python3 threads_scheduler.py post "文字內容"                    # 立即發帖
  python3 threads_scheduler.py schedule "文字內容" 2026-03-21 20:30  # 排程發帖
  python3 threads_scheduler.py schedule "文字內容" tomorrow 21:00    # 明天指定時間
  python3 threads_scheduler.py schedule "文字內容" +2h               # 2 小時後
  python3 threads_scheduler.py test                                # 測試 compose UI
"""

import sys
import time
import re
from datetime import datetime, timedelta, timezone
from playwright.sync_api import sync_playwright

CDP_URL = "http://localhost:9223"
TW_TZ = timezone(timedelta(hours=8))


def _connect():
    p = sync_playwright().start()
    browser = p.chromium.connect_over_cdp(CDP_URL)
    context = browser.contexts[0]
    return p, browser, context


def _open_compose(page):
    """Open the Threads compose modal."""
    page.goto('https://www.threads.net/', timeout=20000)
    time.sleep(3)
    page.locator('[aria-label*="撰寫新貼文"]').first.click()
    time.sleep(2)


def _type_content(page, text):
    """Type content into the compose editor."""
    editor = page.locator('[role="dialog"] [contenteditable="true"]').first
    editor.click()
    time.sleep(0.3)
    for i, line in enumerate(text.split('\n')):
        if i > 0:
            page.keyboard.press('Shift+Enter')
        page.keyboard.type(line, delay=8)
    time.sleep(0.5)


def _set_schedule(page, target_date, hour, minute):
    """Set the schedule time in the compose modal.

    Args:
        target_date: date string like "2026年3月21日" for gridcell name
        hour: 0-23 (24h format)
        minute: 0-59
    """
    # Open 更多 → 排定時間
    page.locator('[role="dialog"] svg[aria-label="更多"]').first.click()
    time.sleep(1)
    page.locator('[role="menuitem"]:has-text("排定時間")').click()
    time.sleep(2)

    # Select date if not today
    if target_date:
        cell = page.get_by_role('gridcell', name=target_date)
        if cell.count() > 0:
            cell.click()
            time.sleep(0.5)
        else:
            # Might need to navigate months
            # Click 下個月 until we find the date
            for _ in range(3):
                next_month = page.get_by_role('button', name='下個月')
                if next_month.count() > 0:
                    next_month.click()
                    time.sleep(0.5)
                    cell = page.get_by_role('gridcell', name=target_date)
                    if cell.count() > 0:
                        cell.click()
                        time.sleep(0.5)
                        break

    # Set time (24h format)
    hh = page.get_by_role('textbox', name='hh')
    mm = page.get_by_role('textbox', name='mm')

    hh.click()
    time.sleep(0.1)
    page.keyboard.press('Meta+a')
    page.keyboard.type(f'{hour:02d}')
    time.sleep(0.3)

    mm.click()
    time.sleep(0.1)
    page.keyboard.press('Meta+a')
    page.keyboard.type(f'{minute:02d}')
    time.sleep(0.3)

    # Click 完成
    done = page.get_by_role('button', name='完成')
    done.click(timeout=5000)
    time.sleep(1)


def _click_publish(page):
    """Click the publish/schedule button."""
    # After scheduling, button text changes to "預排時間" or stays "發佈"
    btn = page.locator('[role="dialog"] div[role="button"]:has-text("預排時間")')
    if btn.count() == 0:
        btn = page.locator('[role="dialog"] div[role="button"]:has-text("發佈")')
    btn.first.click()
    time.sleep(3)


def _parse_time(date_str, time_str):
    """Parse flexible time input into (gridcell_name, hour, minute).

    Formats:
        "2026-03-21" "20:30"  → specific date+time
        "tomorrow" "21:00"    → tomorrow at time
        "+2h" None            → 2 hours from now
        "+30m" None           → 30 minutes from now
    """
    now = datetime.now(TW_TZ)

    # Relative time: +2h, +30m
    rel = re.match(r'^\+(\d+)([hm])$', date_str)
    if rel:
        amount = int(rel.group(1))
        unit = rel.group(2)
        if unit == 'h':
            target = now + timedelta(hours=amount)
        else:
            target = now + timedelta(minutes=amount)
        # Format gridcell name
        name = target.strftime('%Y年%-m月%-d日') + ' ' + _weekday_zh(target)
        return name, target.hour, target.minute

    # "tomorrow"
    if date_str.lower() == 'tomorrow':
        target = now + timedelta(days=1)
        h, m = map(int, time_str.split(':'))
        name = target.strftime('%Y年%-m月%-d日') + ' ' + _weekday_zh(target)
        return name, h, m

    # "today"
    if date_str.lower() == 'today':
        h, m = map(int, time_str.split(':'))
        name = now.strftime('%Y年%-m月%-d日') + ' ' + _weekday_zh(now)
        return name, h, m

    # Explicit date: "2026-03-21"
    target = datetime.strptime(date_str, '%Y-%m-%d').replace(tzinfo=TW_TZ)
    h, m = map(int, time_str.split(':'))
    name = target.strftime('%Y年%-m月%-d日') + ' ' + _weekday_zh(target)
    return name, h, m


def _weekday_zh(dt):
    days = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日']
    return days[dt.weekday()]


# ── Public Commands ──

def post_now(text):
    """Post immediately via Threads UI."""
    p, browser, context = _connect()
    page = context.new_page()
    try:
        _open_compose(page)
        _type_content(page, text)
        _click_publish(page)
        print(f'✅ 已發帖 ({len(text)} 字)')
    finally:
        page.close()
        p.stop()


def schedule_post(text, date_str, time_str=None):
    """Schedule a post via Threads UI."""
    gridcell_name, hour, minute = _parse_time(date_str, time_str)

    p, browser, context = _connect()
    page = context.new_page()
    try:
        _open_compose(page)
        _type_content(page, text)
        _set_schedule(page, gridcell_name, hour, minute)
        _click_publish(page)
        print(f'✅ 已排程：{gridcell_name} {hour:02d}:{minute:02d} ({len(text)} 字)')
    finally:
        page.close()
        p.stop()


def test_compose():
    """Test compose UI without posting."""
    p, browser, context = _connect()
    page = context.new_page()
    try:
        _open_compose(page)
        _type_content(page, '排程測試 — 不會發出')

        # Open schedule picker
        page.locator('[role="dialog"] svg[aria-label="更多"]').first.click()
        time.sleep(1)
        page.locator('[role="menuitem"]:has-text("排定時間")').click()
        time.sleep(2)

        page.screenshot(path='/tmp/threads-compose-test.png')
        print('✅ Compose UI 正常，截圖: /tmp/threads-compose-test.png')

        # Read available dates
        cells = page.get_by_role('gridcell').all()
        print(f'Calendar cells: {len(cells)}')

        hh = page.get_by_role('textbox', name='hh')
        mm = page.get_by_role('textbox', name='mm')
        print(f'Time inputs: hh={hh.count()}, mm={mm.count()}')
        print(f'Current hh value: {hh.input_value()}')

        # Cancel
        page.locator('[role="dialog"] div[role="button"]:has-text("取消")').first.click()
        time.sleep(1)
        discard = page.locator('div[role="button"]:has-text("捨棄")')
        if discard.count() > 0:
            discard.click()
    finally:
        page.close()
        p.stop()


def post_thread(posts, cdp_url=CDP_URL):
    """Post a multi-post thread to Threads via browser UI.

    Args:
        posts: list of strings, each is one post in the thread
    """
    from playwright.sync_api import sync_playwright

    if not posts:
        print("❌ No posts to publish")
        return False

    if len(posts) == 1:
        return post_now(posts[0])

    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(cdp_url)
        context = browser.contexts[0]
        page = context.new_page()

        try:
            page.goto('https://www.threads.com/', timeout=25000)
            time.sleep(4)
            page.locator('[aria-label*="撰寫新貼文"]').first.click()
            time.sleep(2)

            for idx, post_text in enumerate(posts):
                if idx == 0:
                    # First post: click the existing editor
                    page.locator('[role="dialog"] [contenteditable="true"]').first.click()
                else:
                    # Add new post to thread — robust version
                    prev_editor_count = page.locator('[role="dialog"] [contenteditable="true"]').count()

                    # Scroll dialog to bottom to reveal "新增到串文"
                    page.evaluate("""() => {
                        const dialog = document.querySelector('[role="dialog"]');
                        if (dialog) dialog.scrollTop = dialog.scrollHeight;
                    }""")
                    time.sleep(1)

                    # Find and scroll the add button into view
                    page.evaluate("""() => {
                        const dialog = document.querySelector('[role="dialog"]');
                        const btns = [...dialog.querySelectorAll('[role="button"]')];
                        const addBtn = btns.filter(b => b.textContent?.includes('新增到串文')).pop();
                        if (addBtn) {
                            addBtn.scrollIntoView({behavior: 'smooth', block: 'center'});
                        }
                    }""")
                    time.sleep(1)

                    # Click last "新增到串文" button
                    add_btns = page.locator('[role="dialog"] div[role="button"]:has-text("新增到串文")').all()
                    if not add_btns:
                        print(f"  ⚠️ Post {idx + 1}: '新增到串文' button not found, retrying...")
                        time.sleep(2)
                        page.evaluate("() => { const d = document.querySelector('[role=\"dialog\"]'); if (d) d.scrollTop = d.scrollHeight; }")
                        time.sleep(1)
                        add_btns = page.locator('[role="dialog"] div[role="button"]:has-text("新增到串文")').all()

                    if add_btns:
                        add_btns[-1].click()
                    else:
                        print(f"  ❌ Post {idx + 1}: '新增到串文' button still not found after retry")
                        continue

                    # Wait for new editor to appear (up to 5s)
                    for _ in range(10):
                        time.sleep(0.5)
                        cur_count = page.locator('[role="dialog"] [contenteditable="true"]').count()
                        if cur_count > prev_editor_count:
                            break
                    else:
                        print(f"  ⚠️ Post {idx + 1}: new editor didn't appear (still {cur_count})")

                    time.sleep(0.5)

                    # Click the last (newest) editor
                    editors = page.locator('[role="dialog"] [contenteditable="true"]').all()
                    editors[-1].click()

                time.sleep(0.3)

                # Type content line by line
                for i, line in enumerate(post_text.split('\n')):
                    if i > 0:
                        page.keyboard.press('Shift+Enter')
                    page.keyboard.type(line, delay=6)

                time.sleep(0.5)
                print(f"  ✓ Post {idx + 1}/{len(posts)} typed ({len(post_text)} chars)")

            # Verify all editors have content
            editor_count = page.locator('[role="dialog"] [contenteditable="true"]').count()
            if editor_count < len(posts):
                print(f"  ⚠️ Expected {len(posts)} editors but got {editor_count}")

            # Scroll to publish button and click
            page.evaluate("""() => {
                const dialog = document.querySelector('[role="dialog"]');
                if (dialog) dialog.scrollTop = dialog.scrollHeight;
            }""")
            time.sleep(0.5)
            page.locator('[role="dialog"] div[role="button"]:has-text("發佈")').click()
            time.sleep(5)

            print(f"✅ {len(posts)} 篇串文已發出")
            return True

        except Exception as e:
            print(f"❌ Thread post failed: {e}")
            return False
        finally:
            page.close()


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(0)

    cmd = sys.argv[1]

    if cmd == 'post' and len(sys.argv) >= 3:
        post_now(sys.argv[2])

    elif cmd == 'thread' and len(sys.argv) >= 3:
        # thread "post1" "post2" "post3"
        post_thread(sys.argv[2:])

    elif cmd == 'schedule' and len(sys.argv) >= 4:
        text = sys.argv[2]
        date_str = sys.argv[3]
        time_str = sys.argv[4] if len(sys.argv) > 4 else None
        schedule_post(text, date_str, time_str)

    elif cmd == 'test':
        test_compose()

    elif cmd == 'feed':
        pass  # handled below

    else:
        print(__doc__)


def browse_feed(scroll_count=6, cdp_url=CDP_URL):
    """Browse Threads home feed like scrolling a phone.
    Returns list of {author, time, text, likes, url}
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(cdp_url)
        context = browser.contexts[0]
        page = context.new_page()

        page.goto('https://www.threads.com/', timeout=25000)
        time.sleep(5)
        for _ in range(scroll_count):
            page.evaluate("window.scrollBy(0, 1000)")
            time.sleep(1)

        posts = page.evaluate("""() => {
            const postLinks = [...document.querySelectorAll('a[href*="/post/"]')];
            const seen = new Set();
            const anchors = [];
            for (const link of postLinks) {
                const m = link.href?.match(/@([\\w.]+)\\/post\\/(\\w+)/);
                if (!m || seen.has(m[2])) continue;
                seen.add(m[2]);
                anchors.push({author: m[1], postId: m[2], time: link.textContent?.trim(), y: link.getBoundingClientRect().top, url: link.href});
            }
            anchors.sort((a, b) => a.y - b.y);

            const allSpans = [...document.querySelectorAll('span')]
                .filter(s => { const t = s.textContent?.trim(); return t && t.length > 25 && t.length < 500; })
                .map(s => ({text: s.textContent.trim().substring(0, 250), y: s.getBoundingClientRect().top, len: s.textContent.trim().length}));

            const results = [];
            for (let i = 0; i < anchors.length; i++) {
                const a = anchors[i];
                const nextY = i < anchors.length - 1 ? anchors[i+1].y : a.y + 600;
                const nearby = allSpans.filter(s => s.y >= a.y - 50 && s.y < nextY - 50).sort((x, y) => y.len - x.len);
                const unique = [];
                for (const s of nearby) { if (!unique.some(u => u.includes(s.text) || s.text.includes(u))) unique.push(s.text); }
                const likeSpans = [...document.querySelectorAll('span')].filter(s => { const r = s.getBoundingClientRect(); return r.top >= a.y && r.top < nextY && /^[\\d,]+$/.test(s.textContent?.trim()); });
                const likes = likeSpans.length > 0 ? Math.max(...likeSpans.map(s => parseInt(s.textContent.trim().replace(/,/g,'')))) : 0;
                if (unique.length > 0) results.push({author: a.author, time: a.time, text: unique[0], likes, url: a.url});
            }
            return results;
        }""")

        page.close()
        return posts


if __name__ == '__main__' and len(sys.argv) >= 2 and sys.argv[1] == 'feed':
    posts = browse_feed()
    for i, p in enumerate(posts, 1):
        icon = '🔥' if p['likes'] > 500 else ('👀' if p['likes'] > 50 else '  ')
        print(f'{icon}{i:2d}. @{p["author"]:20s} {p["time"]:8s} ♥{p["likes"]}')
        print(f'    「{p["text"][:120]}」')
        print()
