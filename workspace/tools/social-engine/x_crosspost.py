#!/usr/bin/env python3
"""
X Cross-Post Pipeline — Threads → X 跨平台轉譯引擎

架構同早報 pipeline：多來源數據收集 → DR 深研 → 轉譯 → 評分 → 排程 → 發送

Pipeline 節點：
  [Threads DB] → [篩選高互動] → [DR Node: 深度分析] → [轉譯 EN] → [評分] → [排程] → [發送]

Usage:
    python3 x_crosspost.py scan              # 掃描 Threads DB 找高互動內容
    python3 x_crosspost.py research <id>     # DR 節點：深度研究一篇帖文
    python3 x_crosspost.py translate <id>    # 轉譯成 X 格式英文
    python3 x_crosspost.py score <id>        # 評分轉譯品質
    python3 x_crosspost.py pipeline          # 全流程（scan→research→translate→score）
    python3 x_crosspost.py queue             # 查看待發送隊列
    python3 x_crosspost.py send <id>         # 發送一則
    python3 x_crosspost.py send-next         # 發送隊列中下一則
    python3 x_crosspost.py status            # 看狀態
"""

import json
import os
import sys
import sqlite3
import subprocess
import time
import random
from datetime import datetime, timezone, timedelta
from pathlib import Path

WORK_DIR = Path(__file__).parent
THREADS_DB = WORK_DIR.parent / "threads-reply" / "threads.db"
X_SOCIAL_DB = WORK_DIR / "x_social.db"
CROSSPOST_DB = WORK_DIR / "x_crosspost.db"
TW_TZ = timezone(timedelta(hours=8))

# ============================================================
# DATABASE
# ============================================================

def get_db():
    conn = sqlite3.connect(str(CROSSPOST_DB))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS crosspost_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            threads_post_id TEXT UNIQUE,
            threads_text TEXT,
            threads_likes INTEGER DEFAULT 0,
            threads_replies INTEGER DEFAULT 0,
            threads_engagement_score REAL DEFAULT 0,
            dr_analysis TEXT,
            dr_keywords TEXT,
            dr_target_audience TEXT,
            dr_best_angle TEXT,
            translated_text TEXT,
            tweet_format TEXT,
            quality_score REAL DEFAULT 0,
            status TEXT DEFAULT 'scanned',
            posted_at TEXT,
            x_tweet_url TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()
    return conn


def call_llm(prompt, system="", model="haiku"):
    """Call Claude CLI."""
    full = f"{system}\n\n{prompt}" if system else prompt
    env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
    try:
        result = subprocess.run(
            ["claude", "--print", "--model", model],
            input=full, capture_output=True, text=True, timeout=90,
            env=env, cwd="/tmp",
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except Exception:
        pass
    return ""


# ============================================================
# NODE 1: SCAN — 從 Threads DB 撈高互動內容
# ============================================================

def cmd_scan():
    """掃描 Threads DB，找出高互動帖文作為 cross-post 候選。"""
    if not THREADS_DB.exists():
        print("  Threads DB not found")
        return

    threads_conn = sqlite3.connect(str(THREADS_DB))
    threads_conn.row_factory = sqlite3.Row

    # 找高互動帖文（按 likes 排序，排除已 cross-post 的）
    cp_conn = get_db()
    existing = set(
        r['threads_post_id'] for r in
        cp_conn.execute("SELECT threads_post_id FROM crosspost_queue").fetchall()
    )

    rows = threads_conn.execute("""
        SELECT post_id, text_content, like_count, reply_count, posted_at
        FROM posts
        WHERE text_content IS NOT NULL
          AND length(text_content) > 50
        ORDER BY like_count DESC
        LIMIT 50
    """).fetchall()

    candidates = []
    for r in rows:
        post_id = str(r['post_id'])
        if post_id in existing:
            continue

        likes = r['like_count'] or 0
        replies = r['reply_count'] or 0
        engagement = likes * 2 + replies * 3  # 加權分數

        if engagement >= 5:  # 最低門檻
            candidates.append({
                'id': post_id,
                'text': r['text_content'][:1000],
                'likes': likes,
                'replies': replies,
                'engagement': engagement,
                'timestamp': r['posted_at'],
            })

    threads_conn.close()

    # 寫入 crosspost queue
    added = 0
    for c in candidates[:20]:  # 最多加 20 個
        try:
            cp_conn.execute("""
                INSERT OR IGNORE INTO crosspost_queue
                (threads_post_id, threads_text, threads_likes, threads_replies, threads_engagement_score, status)
                VALUES (?, ?, ?, ?, ?, 'scanned')
            """, (c['id'], c['text'], c['likes'], c['replies'], c['engagement']))
            added += 1
        except Exception:
            pass

    cp_conn.commit()
    cp_conn.close()

    print(f"  Scanned {len(rows)} Threads posts")
    print(f"  Added {added} new candidates (engagement >= 5)")
    print(f"  Total in queue: {added + len(existing)}")


# ============================================================
# NODE 2: DR (Deep Research) — 深度分析帖文
# ============================================================

def cmd_research(post_id=None):
    """DR 節點：深度分析一篇帖文的受眾、角度、關鍵字。"""
    conn = get_db()

    if post_id:
        row = conn.execute(
            "SELECT * FROM crosspost_queue WHERE id = ?", (post_id,)
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT * FROM crosspost_queue WHERE status = 'scanned' ORDER BY threads_engagement_score DESC LIMIT 1"
        ).fetchone()

    if not row:
        print("  No posts to research")
        conn.close()
        return

    text = row['threads_text']
    print(f"  Researching post {row['id']} (engagement={row['threads_engagement_score']:.0f})")
    print(f"  Original: {text[:100]}...")

    # DR Prompt — 深度分析
    dr_prompt = f"""Analyze this social media post for cross-platform republishing.

Original post (in Chinese, from Threads):
{text[:800]}

Provide analysis in JSON format:
{{
    "core_insight": "The main valuable insight in 1 sentence (English)",
    "keywords": ["keyword1", "keyword2", "keyword3"],
    "target_audience": "Who on X/Twitter would care about this (be specific)",
    "best_angle": "The angle that would resonate most with X AI dev community",
    "content_type": "tip|story|opinion|data|comparison|question",
    "x_potential": 1-10,
    "translation_notes": "Any cultural context that needs adaptation for English audience"
}}

JSON only, no other text:"""

    analysis = call_llm(dr_prompt, model="haiku")

    # Parse JSON
    try:
        dr_data = json.loads(analysis)
    except Exception:
        # Try extracting JSON from response
        import re
        m = re.search(r'\{.*\}', analysis, re.DOTALL)
        if m:
            try:
                dr_data = json.loads(m.group())
            except Exception:
                dr_data = {"core_insight": analysis[:200], "x_potential": 5}
        else:
            dr_data = {"core_insight": analysis[:200], "x_potential": 5}

    # Save to DB
    conn.execute("""
        UPDATE crosspost_queue SET
            dr_analysis = ?,
            dr_keywords = ?,
            dr_target_audience = ?,
            dr_best_angle = ?,
            status = 'researched'
        WHERE id = ?
    """, (
        json.dumps(dr_data, ensure_ascii=False),
        json.dumps(dr_data.get('keywords', []), ensure_ascii=False),
        dr_data.get('target_audience', ''),
        dr_data.get('best_angle', ''),
        row['id'],
    ))
    conn.commit()
    conn.close()

    print(f"  Core insight: {dr_data.get('core_insight', '?')}")
    print(f"  X potential: {dr_data.get('x_potential', '?')}/10")
    print(f"  Target: {dr_data.get('target_audience', '?')}")
    print(f"  Angle: {dr_data.get('best_angle', '?')}")


# ============================================================
# NODE 3: TRANSLATE — 轉譯成 X 格式英文
# ============================================================

def cmd_translate(post_id=None):
    """轉譯成 X 格式英文推文。"""
    conn = get_db()

    if post_id:
        row = conn.execute(
            "SELECT * FROM crosspost_queue WHERE id = ?", (post_id,)
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT * FROM crosspost_queue WHERE status = 'researched' ORDER BY threads_engagement_score DESC LIMIT 1"
        ).fetchone()

    if not row:
        print("  No researched posts to translate")
        conn.close()
        return

    text = row['threads_text']
    dr_data = json.loads(row['dr_analysis']) if row['dr_analysis'] else {}

    print(f"  Translating post {row['id']}...")

    translate_prompt = f"""Transform this Chinese social media post into an English X/Twitter post.

Original (Chinese):
{text[:600]}

DR Analysis:
- Core insight: {dr_data.get('core_insight', '')}
- Best angle: {dr_data.get('best_angle', '')}
- Target audience: {dr_data.get('target_audience', '')}
- Content type: {dr_data.get('content_type', '')}

Rules:
- Write in the voice of someone running 10+ AI agents in production
- Max 280 characters
- No hashtags
- No links (those go in bio)
- Direct, technical, opinionated
- NOT a translation — a reimagining for the X AI dev audience
- Must stand alone without context

Output the tweet text only, nothing else:"""

    translated = call_llm(translate_prompt, model="haiku")

    if translated:
        translated = translated.strip('"').strip("'").strip()
        if len(translated) > 280:
            translated = translated[:277] + "..."

    # Also generate a thread version if content is rich enough
    thread_format = ""
    if len(text) > 200 and dr_data.get('x_potential', 0) >= 7:
        thread_prompt = f"""Transform this into a 3-4 tweet thread for X/Twitter.

Original (Chinese):
{text[:800]}

Core insight: {dr_data.get('core_insight', '')}

Rules:
- Tweet 1: Hook (make people stop scrolling)
- Tweet 2-3: The substance
- Tweet 4 (optional): Takeaway or question
- Each tweet max 280 chars
- No hashtags, no links
- Technical, direct, opinionated

Format each tweet on a new line, separated by ---:"""

        thread_format = call_llm(thread_prompt, model="haiku")

    # Save
    conn.execute("""
        UPDATE crosspost_queue SET
            translated_text = ?,
            tweet_format = ?,
            status = 'translated'
        WHERE id = ?
    """, (translated, thread_format or '', row['id']))
    conn.commit()
    conn.close()

    print(f"  Tweet: {translated}")
    if thread_format:
        print(f"  Thread version also generated")


# ============================================================
# NODE 4: SCORE — 評分轉譯品質
# ============================================================

def cmd_score(post_id=None):
    """評分轉譯品質。"""
    conn = get_db()

    if post_id:
        row = conn.execute(
            "SELECT * FROM crosspost_queue WHERE id = ?", (post_id,)
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT * FROM crosspost_queue WHERE status = 'translated' ORDER BY threads_engagement_score DESC LIMIT 1"
        ).fetchone()

    if not row:
        print("  No translated posts to score")
        conn.close()
        return

    translated = row['translated_text']
    dr_data = json.loads(row['dr_analysis']) if row['dr_analysis'] else {}

    score_prompt = f"""Rate this X/Twitter post on 1-10 scale.

Tweet: "{translated}"

Criteria:
1. Would an AI developer stop scrolling? (hook power)
2. Does it contain a genuine insight? (not generic)
3. Is the tone right? (peer, not salesperson)
4. Is it concise and punchy?
5. Would it get likes/retweets from AI dev community?

Average score (just the number):"""

    score_str = call_llm(score_prompt)
    try:
        score = float(score_str.strip().split('\n')[0].split('/')[0])
    except (ValueError, IndexError):
        score = 5.0

    # Also check with resonance filter if available
    try:
        from content_brain import ResonanceFilter
        rf = ResonanceFilter()
        res = rf.score(translated)
        resonance_bonus = min(res['total_score'] * 0.01, 0.5)
        score = min(10.0, score + resonance_bonus)
    except Exception:
        pass

    status = 'approved' if score >= 6.0 else 'rejected'

    conn.execute("""
        UPDATE crosspost_queue SET quality_score = ?, status = ? WHERE id = ?
    """, (score, status, row['id']))
    conn.commit()
    conn.close()

    print(f"  Post {row['id']}: score={score:.1f} → {status}")
    print(f"  Tweet: {translated[:80]}...")


# ============================================================
# FULL PIPELINE
# ============================================================

def cmd_pipeline():
    """全流程：scan → research → translate → score。"""
    print("=== Cross-Post Pipeline ===\n")

    print("Step 1: Scan Threads DB")
    cmd_scan()
    print()

    # Process top 3 candidates through DR → Translate → Score
    conn = get_db()
    candidates = conn.execute(
        "SELECT id FROM crosspost_queue WHERE status = 'scanned' ORDER BY threads_engagement_score DESC LIMIT 3"
    ).fetchall()
    conn.close()

    for c in candidates:
        print(f"\nStep 2: Deep Research (post {c['id']})")
        cmd_research(c['id'])

        print(f"\nStep 3: Translate (post {c['id']})")
        cmd_translate(c['id'])

        print(f"\nStep 4: Score (post {c['id']})")
        cmd_score(c['id'])

    # Summary
    conn = get_db()
    approved = conn.execute("SELECT COUNT(*) as c FROM crosspost_queue WHERE status = 'approved'").fetchone()['c']
    rejected = conn.execute("SELECT COUNT(*) as c FROM crosspost_queue WHERE status = 'rejected'").fetchone()['c']
    conn.close()

    print(f"\n=== Pipeline Complete ===")
    print(f"  Approved: {approved}")
    print(f"  Rejected: {rejected}")


# ============================================================
# QUEUE & SEND
# ============================================================

def cmd_queue():
    """查看待發送隊列。"""
    conn = get_db()
    rows = conn.execute("""
        SELECT id, translated_text, quality_score, threads_engagement_score, status
        FROM crosspost_queue
        WHERE status = 'approved'
        ORDER BY quality_score DESC
    """).fetchall()
    conn.close()

    if not rows:
        print("  Queue empty. Run 'pipeline' first.")
        return

    print(f"=== Cross-Post Queue ({len(rows)} approved) ===\n")
    for r in rows:
        print(f"  [{r['id']}] q={r['quality_score']:.1f} eng={r['threads_engagement_score']:.0f}")
        print(f"      {r['translated_text'][:80]}...")
        print()


def cmd_send(post_id):
    """發送一則已核准的 cross-post。"""
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM crosspost_queue WHERE id = ? AND status = 'approved'", (post_id,)
    ).fetchone()

    if not row:
        print(f"  Post {post_id} not found or not approved")
        conn.close()
        return

    tweet = row['translated_text']
    print(f"  Sending: {tweet[:80]}...")

    # Use X adapter to post
    try:
        sys.path.insert(0, str(WORK_DIR))
        from adapters.x_twitter import XTwitterAdapter
        adapter = XTwitterAdapter()
        success = adapter.send("", tweet)

        if success:
            conn.execute("""
                UPDATE crosspost_queue SET status = 'posted', posted_at = ? WHERE id = ?
            """, (datetime.now(TW_TZ).isoformat(), post_id))
            conn.commit()
            print(f"  ✅ Posted!")
        else:
            print(f"  ❌ Failed to post")
    except Exception as e:
        print(f"  Error: {e}")

    conn.close()


def cmd_send_next():
    """發送隊列中下一則。"""
    conn = get_db()
    row = conn.execute(
        "SELECT id FROM crosspost_queue WHERE status = 'approved' ORDER BY quality_score DESC LIMIT 1"
    ).fetchone()
    conn.close()

    if row:
        cmd_send(row['id'])
    else:
        print("  No approved posts in queue")


def cmd_status():
    """看狀態。"""
    conn = get_db()
    counts = {}
    for status in ['scanned', 'researched', 'translated', 'approved', 'rejected', 'posted']:
        row = conn.execute(
            "SELECT COUNT(*) as c FROM crosspost_queue WHERE status = ?", (status,)
        ).fetchone()
        counts[status] = row['c']
    conn.close()

    print("=== Cross-Post Status ===\n")
    print(f"  Scanned:    {counts['scanned']}")
    print(f"  Researched: {counts['researched']}")
    print(f"  Translated: {counts['translated']}")
    print(f"  Approved:   {counts['approved']}")
    print(f"  Rejected:   {counts['rejected']}")
    print(f"  Posted:     {counts['posted']}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    arg = sys.argv[2] if len(sys.argv) > 2 else None

    cmds = {
        "scan": cmd_scan,
        "research": lambda: cmd_research(int(arg) if arg else None),
        "translate": lambda: cmd_translate(int(arg) if arg else None),
        "score": lambda: cmd_score(int(arg) if arg else None),
        "pipeline": cmd_pipeline,
        "queue": cmd_queue,
        "send": lambda: cmd_send(int(arg)) if arg else print("Usage: send <id>"),
        "send-next": cmd_send_next,
        "status": cmd_status,
    }

    if cmd in cmds:
        cmds[cmd]()
    else:
        print(__doc__)
