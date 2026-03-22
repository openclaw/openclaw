#!/usr/bin/env python3
"""
FB Cross-Post — Threads 帖文跨發到 Facebook Thinker Cafe 粉專

用法:
  python3 fb_crosspost.py list              # 列出 Threads 帖文（可跨發的）
  python3 fb_crosspost.py post <post_id>    # 跨發指定帖到 FB
  python3 fb_crosspost.py auto [min_likes]  # 自動跨發高互動帖（預設 likes>=5）
  python3 fb_crosspost.py scan              # 掃 FB 粉專留言
  python3 fb_crosspost.py pending           # 看 FB 待回留言
  python3 fb_crosspost.py draft <comment_id> <text>  # 建草稿
  python3 fb_crosspost.py review            # 審閱草稿
  python3 fb_crosspost.py approve <id> [revised_text] # 批准
  python3 fb_crosspost.py send              # 發送待發回覆
  python3 fb_crosspost.py status            # 看整體狀態
"""

import sys
import os
import json
import sqlite3
from pathlib import Path
from datetime import datetime, timezone

# Setup paths
SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(SCRIPT_DIR.parent / "threads-reply"))

from adapters.facebook import FacebookAdapter, api_get, api_post, PAGE_ID, PAGE_TOKEN

THREADS_DB = SCRIPT_DIR.parent / "threads-reply" / "threads.db"
FB_DB = SCRIPT_DIR / "fb.db"


def get_fb_conn():
    conn = sqlite3.connect(str(FB_DB), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS crosspost_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            threads_post_id TEXT NOT NULL,
            fb_post_id TEXT,
            message TEXT,
            posted_at TEXT,
            UNIQUE(threads_post_id)
        );
        CREATE TABLE IF NOT EXISTS fb_comments (
            comment_id TEXT PRIMARY KEY,
            post_id TEXT NOT NULL,
            fb_post_id TEXT,
            user_name TEXT,
            user_id TEXT,
            message TEXT,
            like_count INTEGER DEFAULT 0,
            created_at TEXT,
            fetched_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        );
        CREATE TABLE IF NOT EXISTS fb_drafts (
            draft_id INTEGER PRIMARY KEY AUTOINCREMENT,
            comment_id TEXT NOT NULL,
            draft_text TEXT NOT NULL,
            tone TEXT DEFAULT 'strategic',
            strategy TEXT,
            status TEXT DEFAULT 'draft',
            created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        );
        CREATE TABLE IF NOT EXISTS fb_replies (
            reply_id INTEGER PRIMARY KEY AUTOINCREMENT,
            comment_id TEXT NOT NULL,
            draft_id INTEGER,
            reply_text TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            sent_at TEXT,
            error_msg TEXT
        );
    """)
    return conn


# ── Cross-post commands ──

def cmd_list():
    """List Threads posts eligible for cross-posting."""
    import threads_db as tdb
    tconn = tdb.get_conn()
    fconn = get_fb_conn()

    # Get already cross-posted
    already = set(r[0] for r in fconn.execute("SELECT threads_post_id FROM crosspost_log").fetchall())

    posts = tconn.execute("""
        SELECT post_id, text_content, posted_at, like_count, reply_count
        FROM posts WHERE user_id = (SELECT user_id FROM profiles WHERE username='tangcruzz' LIMIT 1)
        ORDER BY posted_at DESC LIMIT 30
    """).fetchall()
    tconn.close()
    fconn.close()

    print(f"📋 Threads posts (✓ = already on FB):\n")
    for p in posts:
        status = "✓" if p["post_id"] in already else " "
        text = (p["text_content"] or "")[:60]
        likes = p["like_count"] or 0
        replies = p["reply_count"] or 0
        print(f"  [{status}] ♥{likes:>4} 💬{replies:>4} {p['posted_at'][:10]}  「{text}」")
        print(f"       ID: {p['post_id']}")


def cmd_post(threads_post_id):
    """Cross-post a specific Threads post to FB."""
    import threads_db as tdb
    tconn = tdb.get_conn()

    post = tconn.execute("SELECT * FROM posts WHERE post_id=?", (threads_post_id,)).fetchone()
    tconn.close()

    if not post:
        print(f"  ❌ Post {threads_post_id} not found in threads.db")
        return

    text = post["text_content"] or ""
    if not text:
        print("  ❌ Post has no text")
        return

    fconn = get_fb_conn()
    exists = fconn.execute("SELECT id FROM crosspost_log WHERE threads_post_id=?", (threads_post_id,)).fetchone()
    if exists:
        print(f"  ⚠️ Already cross-posted")
        fconn.close()
        return

    fb = FacebookAdapter()
    fb_post_id = fb.publish_post(text)

    if fb_post_id:
        fconn.execute(
            "INSERT INTO crosspost_log (threads_post_id, fb_post_id, message, posted_at) VALUES (?,?,?,?)",
            (threads_post_id, fb_post_id, text[:200], datetime.now(timezone.utc).isoformat())
        )
        fconn.commit()
        print(f"  ✅ Cross-posted → {fb_post_id}")
    else:
        print("  ❌ Failed to publish")
    fconn.close()


def cmd_auto(min_likes=5):
    """Auto cross-post high-engagement posts not yet on FB."""
    import threads_db as tdb
    tconn = tdb.get_conn()
    fconn = get_fb_conn()

    already = set(r[0] for r in fconn.execute("SELECT threads_post_id FROM crosspost_log").fetchall())

    posts = tconn.execute("""
        SELECT post_id, text_content, like_count, reply_count, posted_at
        FROM posts WHERE user_id = (SELECT user_id FROM profiles WHERE username='tangcruzz' LIMIT 1)
          AND like_count >= ?
        ORDER BY like_count DESC
    """, (min_likes,)).fetchall()
    tconn.close()

    candidates = [p for p in posts if p["post_id"] not in already and p["text_content"]]
    print(f"📋 {len(candidates)} posts eligible (likes >= {min_likes}, not yet on FB):\n")

    for p in candidates:
        text = (p["text_content"] or "")[:60]
        print(f"  ♥{p['like_count']:>4} 💬{p['reply_count']:>4} {p['posted_at'][:10]}  「{text}」")
        print(f"       ID: {p['post_id']}")

    fconn.close()
    return candidates


# ── FB comment scan/reply commands ──

def cmd_scan():
    """Scan FB page for comments."""
    print("🔍 Scanning FB comments...")
    fb = FacebookAdapter()
    fconn = get_fb_conn()

    data = api_get(f"{PAGE_ID}/posts", {
        "fields": "id,message,created_time,comments{id,message,from,created_time,like_count}",
        "limit": 10
    })
    if not data or "data" not in data:
        print("  ❌ Failed to fetch")
        return

    total = 0
    for post in data["data"]:
        post_msg = (post.get("message") or "")[:40]
        comments = post.get("comments", {}).get("data", [])
        for c in comments:
            from_user = c.get("from", {})
            fconn.execute("""
                INSERT OR REPLACE INTO fb_comments
                (comment_id, post_id, fb_post_id, user_name, user_id, message, like_count, created_at)
                VALUES (?,?,?,?,?,?,?,?)
            """, (c["id"], post["id"], post["id"], from_user.get("name"), from_user.get("id"),
                  c.get("message", ""), c.get("like_count", 0), c.get("created_time")))
            total += 1
        if comments:
            print(f"  Post 「{post_msg}...」 → {len(comments)} comments")

    fconn.commit()
    fconn.close()
    print(f"\n📊 {total} comments synced")


def cmd_pending():
    """Show FB comments not yet replied to."""
    fconn = get_fb_conn()
    rows = fconn.execute("""
        SELECT c.comment_id, c.message, c.user_name, c.created_at, c.like_count,
               SUBSTR(c.post_id, 1, 30) as post_preview
        FROM fb_comments c
        LEFT JOIN fb_replies r ON c.comment_id = r.comment_id AND r.status IN ('sent','pending','approved')
        WHERE r.reply_id IS NULL AND c.user_id != ?
        ORDER BY c.created_at DESC
    """, (PAGE_ID,)).fetchall()
    fconn.close()

    if not rows:
        print("✅ No pending FB comments")
        return

    print(f"📋 {len(rows)} pending FB comments:\n")
    for i, r in enumerate(rows, 1):
        print(f"  {i}. {r['user_name']} (♥{r['like_count']})")
        print(f"     「{r['message'][:80]}」")
        print(f"     ID: {r['comment_id']}")
        print()


def cmd_draft(comment_id, text, tone="strategic", strategy=None):
    """Create a draft reply for a FB comment."""
    fconn = get_fb_conn()
    comment = fconn.execute("SELECT * FROM fb_comments WHERE comment_id=?", (comment_id,)).fetchone()
    if not comment:
        print(f"  ❌ Comment {comment_id} not found")
        fconn.close()
        return

    fconn.execute(
        "INSERT INTO fb_drafts (comment_id, draft_text, tone, strategy) VALUES (?,?,?,?)",
        (comment_id, text, tone, strategy)
    )
    fconn.commit()
    draft_id = fconn.execute("SELECT last_insert_rowid()").fetchone()[0]
    fconn.close()
    print(f"  ✅ FB Draft #{draft_id} created")


def cmd_review():
    """Show pending FB drafts."""
    fconn = get_fb_conn()
    rows = fconn.execute("""
        SELECT d.draft_id, d.draft_text, d.tone, d.strategy,
               c.message as comment_text, c.user_name
        FROM fb_drafts d
        JOIN fb_comments c ON d.comment_id = c.comment_id
        WHERE d.status = 'draft'
        ORDER BY d.created_at ASC
    """).fetchall()
    fconn.close()

    if not rows:
        print("✅ No pending FB drafts")
        return

    print(f"📋 {len(rows)} FB drafts for review:\n")
    for r in rows:
        print(f"  #{r['draft_id']} 🎯 {r['user_name']}")
        print(f"  留言：「{r['comment_text'][:60]}」")
        print(f"  草稿：「{r['draft_text']}」")
        if r["strategy"]:
            print(f"  策略：{r['strategy']}")
        print()


def cmd_approve(draft_id, revised_text=None):
    """Approve a FB draft → create pending reply."""
    fconn = get_fb_conn()
    draft = fconn.execute("SELECT * FROM fb_drafts WHERE draft_id=?", (draft_id,)).fetchone()
    if not draft:
        print(f"  ❌ Draft #{draft_id} not found")
        fconn.close()
        return

    final_text = revised_text or draft["draft_text"]
    fconn.execute("UPDATE fb_drafts SET status='selected' WHERE draft_id=?", (draft_id,))
    fconn.execute(
        "INSERT INTO fb_replies (comment_id, draft_id, reply_text, status) VALUES (?,?,?,?)",
        (draft["comment_id"], draft_id, final_text, "pending")
    )
    fconn.commit()
    reply_id = fconn.execute("SELECT last_insert_rowid()").fetchone()[0]
    fconn.close()
    print(f"  ✅ FB Draft #{draft_id} approved → Reply #{reply_id} (pending)")


def cmd_send():
    """Send all pending FB replies."""
    fconn = get_fb_conn()
    rows = fconn.execute("""
        SELECT r.reply_id, r.comment_id, r.reply_text, c.user_name
        FROM fb_replies r
        JOIN fb_comments c ON r.comment_id = c.comment_id
        WHERE r.status = 'pending'
    """).fetchall()

    if not rows:
        print("✅ No pending FB replies")
        return

    print(f"📤 Sending {len(rows)} FB replies...\n")
    sent = 0
    for r in rows:
        result = api_post(f"{r['comment_id']}/comments", {"message": r["reply_text"]})
        if result and "id" in result:
            fconn.execute("UPDATE fb_replies SET status='sent', sent_at=? WHERE reply_id=?",
                          (datetime.now(timezone.utc).isoformat(), r["reply_id"]))
            print(f"  ✅ {r['user_name']}")
            sent += 1
        else:
            fconn.execute("UPDATE fb_replies SET status='failed', error_msg='API error' WHERE reply_id=?",
                          (r["reply_id"],))
            print(f"  ❌ {r['user_name']}")

    fconn.commit()
    fconn.close()
    print(f"\n📊 {sent} sent, {len(rows) - sent} failed")


def cmd_status():
    """Overall FB status."""
    fconn = get_fb_conn()
    cross = fconn.execute("SELECT COUNT(*) FROM crosspost_log").fetchone()[0]
    comments = fconn.execute("SELECT COUNT(*) FROM fb_comments").fetchone()[0]
    drafts = fconn.execute("SELECT COUNT(*) FROM fb_drafts WHERE status='draft'").fetchone()[0]
    replies_sent = fconn.execute("SELECT COUNT(*) FROM fb_replies WHERE status='sent'").fetchone()[0]
    replies_pending = fconn.execute("SELECT COUNT(*) FROM fb_replies WHERE status='pending'").fetchone()[0]
    fconn.close()

    fb = FacebookAdapter()
    info = fb.get_page_info()

    print(f"📊 Facebook — {info.get('name', 'Thinker Cafe')} ({info.get('fan_count', '?')} fans)")
    print(f"  Cross-posted:    {cross}")
    print(f"  Comments synced: {comments}")
    print(f"  Drafts pending:  {drafts}")
    print(f"  Replies sent:    {replies_sent}")
    print(f"  Replies queued:  {replies_pending}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(0)

    cmd = sys.argv[1]
    if cmd == "list":
        cmd_list()
    elif cmd == "post" and len(sys.argv) >= 3:
        cmd_post(sys.argv[2])
    elif cmd == "auto":
        min_l = int(sys.argv[2]) if len(sys.argv) > 2 else 5
        cmd_auto(min_l)
    elif cmd == "scan":
        cmd_scan()
    elif cmd == "pending":
        cmd_pending()
    elif cmd == "draft" and len(sys.argv) >= 4:
        cmd_draft(sys.argv[2], " ".join(sys.argv[3:]))
    elif cmd == "review":
        cmd_review()
    elif cmd == "approve" and len(sys.argv) >= 3:
        revised = " ".join(sys.argv[3:]) if len(sys.argv) > 3 else None
        cmd_approve(int(sys.argv[2]), revised)
    elif cmd == "send":
        cmd_send()
    elif cmd == "status":
        cmd_status()
    else:
        print(__doc__)
