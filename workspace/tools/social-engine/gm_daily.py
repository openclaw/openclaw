#!/usr/bin/env python3
"""
GM Daily — 每日 Threads GM 日報產生器

讀取 thinker-news + threads feed + CRM 數據，
產出三篇串文（每篇 ≤ 500 字），存檔等 Cruz 審。

Usage:
  python3 gm_daily.py generate   # 產出今日 GM 日報
  python3 gm_daily.py preview    # 預覽（不存檔）
"""

import sys
import json
import re
from pathlib import Path
from datetime import datetime, timezone, timedelta

SCRIPT_DIR = Path(__file__).parent
TW_TZ = timezone(timedelta(hours=8))

THINKER_NEWS_JSON = SCRIPT_DIR / "thinker-news-latest.json"
THREADS_FEED_JSON = Path("/tmp/threads-feed-500.json")
OUTPUT_DIR = SCRIPT_DIR / "gm-drafts"


def _load_thinker_news():
    """Load today's thinker-news digest."""
    if not THINKER_NEWS_JSON.exists():
        return None
    try:
        data = json.loads(THINKER_NEWS_JSON.read_text())
        content = data.get("line_content", "")
        # Extract text from JSON wrapper if needed
        if "line_message_text" in content:
            m = re.search(r'"line_message_text":\s*"(.*?)"', content, re.DOTALL)
            if m:
                content = m.group(1).replace('\\n', '\n')
        return {"date": data.get("date"), "content": content}
    except:
        return None


def _load_threads_feed():
    """Load today's Threads feed data."""
    if not THREADS_FEED_JSON.exists():
        return None
    try:
        posts = json.loads(THREADS_FEED_JSON.read_text())
        return posts
    except:
        return None


def _load_crm_stats():
    """Load CRM stats from social.db."""
    import sqlite3
    db = SCRIPT_DIR / "social.db"
    if not db.exists():
        return {}
    conn = sqlite3.connect(str(db))
    total = conn.execute("SELECT COUNT(*) FROM contacts").fetchone()[0]
    subs = conn.execute("SELECT COUNT(*) FROM contacts WHERE engagement_depth >= 5").fetchone()[0]
    new_24h = conn.execute("""
        SELECT COUNT(*) FROM platform_interactions
        WHERE interaction_type='discovered' AND created_at > datetime('now', '-1 day')
    """).fetchone()[0]
    conn.close()
    return {"total": total, "subscribers": subs, "new_24h": new_24h}


def generate_gm_daily():
    """Generate three-post thread for GM Daily."""
    now = datetime.now(TW_TZ)
    date_str = now.strftime("%m/%d")
    weekday = ['一','二','三','四','五','六','日'][now.weekday()]

    # Load data sources
    tn = _load_thinker_news()
    feed = _load_threads_feed()
    crm = _load_crm_stats()

    # Feed analysis
    feed_count = len(feed) if feed else 0
    feed_authors = len(set(p['author'] for p in feed)) if feed else 0
    top5 = sorted(feed, key=lambda x: -x.get('likes', 0))[:5] if feed else []

    # Topic breakdown
    topics = {'AI': 0, '政治': 0, '生活': 0, '技術': 0, '其他': 0}
    interesting_posts = []
    if feed:
        for p in feed:
            t = p.get('text', '')
            if any(w in t for w in ['AI','Claude','GPT','LLM','agent']): topics['AI'] += 1
            elif any(w in t for w in ['台灣','政治','政府','國防']): topics['政治'] += 1
            elif any(w in t for w in ['程式','code','debug','API']): topics['技術'] += 1
            elif any(w in t for w in ['吃','旅','咖啡','健身']): topics['生活'] += 1
            else: topics['其他'] += 1

        # Find interesting stories (not just high likes) — dedupe by author
        seen_authors = set()
        for p in feed:
            t = p.get('text', '')
            author = p.get('author', '')
            if author in seen_authors:
                continue
            if len(t) > 50 and p.get('likes', 0) < 50 and any(w in t for w in ['從零','debug','搞不懂','不知道','掙扎','一個人','第一次','學','撐','獨自','辭','轉行']):
                interesting_posts.append(p)
                seen_authors.add(author)

    # Extract thinker-news highlights (top 3 lines)
    tn_highlights = ""
    if tn and tn.get("content"):
        lines = [l.strip() for l in tn["content"].split('\n') if l.strip() and len(l.strip()) > 10]
        tn_highlights = '\n'.join(lines[:6])

    # === POST 1: World + Threads overview ===
    top_lines = ""
    if top5:
        for p in top5[:3]:
            top_lines += f"♥{p.get('likes',0):,} @{p['author']}: {p.get('text','')[:35]}\n"

    post1 = f"""GM 日報 — {date_str} 週{weekday}

昨晚滑了 {feed_count} 篇。{feed_authors} 個人在說話。

最熱的三篇：
{top_lines.strip()}

同時間，全球科技圈：
{tn_highlights[:200] if tn_highlights else '（thinker-news 產出中）'}

兩個世界。一個在追星，一個在部署。
你在哪一個？"""

    # === POST 2: Threads deep dive ===
    topic_summary = ' | '.join(f"{k} {v}" for k, v in sorted(topics.items(), key=lambda x: -x[1]) if v > 0)

    interesting_section = ""
    if interesting_posts:
        for p in interesting_posts[:3]:
            interesting_section += f"• @{p['author']}: {p.get('text','')[:50]}\n"
    else:
        interesting_section = "（今天安靜處比較沉默）"

    post2 = f"""Threads 台灣話題溫度：
{topic_summary}

水面下的聲音（讚很少但很真）：
{interesting_section.strip()}

CRM 現況：{crm.get('total', 0)} 人（+{crm.get('new_24h', 0)} 新）
訂閱者：{crm.get('subscribers', 0)} 人

安靜處最真。"""

    # === POST 3: GM analysis + question ===
    post3 = f"""GM 觀察：

{top5[0].get('likes',0):,} 個讚代表的不是品質，是情緒共鳴的速度。
那些三個讚的帖文，代表的不是失敗，是受眾還沒長出來。

但三個月後回頭看，
改變一個人的從來不是最熱門的那篇。

今天的問題：
你昨天滑手機的時候，有沒有在哪一則帖文前面停超過三秒？

那三秒，就是你真正的 feed。
不是演算法的，是你自己的。""" if top5 else """GM 觀察：

（等待今日 feed 數據）"""

    posts = [post1, post2, post3]

    # Validate lengths
    for i, p in enumerate(posts):
        if len(p) > 500:
            # Trim
            posts[i] = p[:497] + "..."

    return posts


def save_drafts(posts):
    """Save GM daily drafts."""
    OUTPUT_DIR.mkdir(exist_ok=True)
    today = datetime.now(TW_TZ).strftime("%Y-%m-%d")
    path = OUTPUT_DIR / f"gm-{today}.json"
    path.write_text(json.dumps({
        "date": today,
        "posts": posts,
        "lengths": [len(p) for p in posts],
        "status": "draft",
        "generated_at": datetime.now(TW_TZ).isoformat(),
    }, ensure_ascii=False, indent=2))
    print(f"💾 Saved to {path}")
    return path


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "preview"

    posts = generate_gm_daily()

    for i, p in enumerate(posts, 1):
        print(f"\n{'='*40}")
        print(f"串文 {i}/3（{len(p)} 字）")
        print(f"{'='*40}")
        print(p)

    if cmd == "generate":
        save_drafts(posts)

    elif cmd == "publish":
        from threads_scheduler import post_thread
        post_thread(posts)
