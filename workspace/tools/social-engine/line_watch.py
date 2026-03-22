#!/usr/bin/env python3
"""
LINE Watch — 監控 LINE 未讀變化

透過 CDP 連接 LINE Chrome 擴充套件，讀取 MutationObserver 的 log。
供 hook 或 Sentinel 呼叫。

Usage:
  python3 line_watch.py check     # 檢查當前未讀 + 最近變化
  python3 line_watch.py inject    # 注入/重新注入 observer
  python3 line_watch.py status    # 一行狀態（給 hook 用）
"""

import sys
import json
from playwright.sync_api import sync_playwright

CDP_URL = "http://localhost:9222"
LINE_EXT_ID = "ophjlpahpchlmihnnnihgmmeilfjmjjc"

OBSERVER_CODE = '''() => {
    if (window.__lineObserverActive) return 'already active';
    window.__lineUnreadLog = [];
    window.__lineLastUnread = null;
    const observer = new MutationObserver(() => {
        const body = document.body.innerText;
        const firstLine = body.split('\\n')[0]?.trim();
        const count = parseInt(firstLine);
        const totalUnread = isNaN(count) ? 0 : count;
        if (window.__lineLastUnread !== null && totalUnread !== window.__lineLastUnread) {
            window.__lineUnreadLog.push({
                time: new Date().toISOString(),
                old: window.__lineLastUnread,
                new: totalUnread,
                delta: totalUnread - window.__lineLastUnread
            });
            if (window.__lineUnreadLog.length > 20)
                window.__lineUnreadLog = window.__lineUnreadLog.slice(-20);
        }
        window.__lineLastUnread = totalUnread;
    });
    observer.observe(document.body, {childList: true, subtree: true, characterData: true});
    window.__lineObserverActive = true;
    return 'injected';
}'''


def _get_line_page():
    p = sync_playwright().start()
    browser = p.chromium.connect_over_cdp(CDP_URL)
    for pg in browser.contexts[0].pages:
        if LINE_EXT_ID in pg.url:
            return p, pg
    p.stop()
    return None, None


def check():
    p, line = _get_line_page()
    if not line:
        print("LINE not open")
        return

    # Ensure observer is injected
    line.evaluate(OBSERVER_CODE)

    state = line.evaluate('''() => ({
        active: window.__lineObserverActive || false,
        unread: window.__lineLastUnread,
        log: window.__lineUnreadLog || []
    })''')

    print(f"Unread: {state['unread']}")
    print(f"Observer: {'✅' if state['active'] else '❌'}")

    if state['log']:
        print(f"\nRecent changes ({len(state['log'])}):")
        for entry in state['log'][-5:]:
            print(f"  [{entry['time'][11:19]}] {entry['old']} → {entry['new']} ({'+' if entry['delta'] > 0 else ''}{entry['delta']})")
    else:
        print("No changes detected yet")

    p.stop()


def status():
    """One-line status for hook integration."""
    p, line = _get_line_page()
    if not line:
        print("LINE:offline")
        return

    line.evaluate(OBSERVER_CODE)

    state = line.evaluate('''() => {
        const log = window.__lineUnreadLog || [];
        const recent = log.filter(e => Date.now() - new Date(e.time).getTime() < 300000); // last 5 min
        return {
            unread: window.__lineLastUnread || 0,
            recentDelta: recent.reduce((sum, e) => sum + e.delta, 0),
            recentCount: recent.length
        };
    }''')

    unread = state['unread']
    delta = state['recentDelta']
    delta_str = f"+{delta}" if delta > 0 else str(delta) if delta != 0 else ""

    if delta_str:
        print(f"LINE:{unread}({delta_str})")
    else:
        print(f"LINE:{unread}")

    p.stop()


def inject():
    p, line = _get_line_page()
    if not line:
        print("LINE not open")
        return
    result = line.evaluate(OBSERVER_CODE)
    print(f"Observer: {result}")
    p.stop()


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    if cmd == "check":
        check()
    elif cmd == "status":
        status()
    elif cmd == "inject":
        inject()
    else:
        print(__doc__)
