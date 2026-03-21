#!/usr/bin/env python3
"""
Threads Reply System — 主程式

流程：
  scan   → 拉最新貼文 + 留言，入 DB，標分類
  dive   → 深挖指定用戶 profile（🥃 用）
  draft  → 生成草稿，存 drafts 表
  review → 列出待審草稿
  approve <id> [revised_text] → 批准/修改草稿 → 移入 replies(pending)
  send   → 發送所有 pending replies
  status → 看整體狀態
  seed   → 灌入對話裡的歷史數據
"""

import os
import sys
import json
import time
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

# ── Load env ──
ENV_PATH = Path(__file__).parent / ".env"
if ENV_PATH.exists():
    for line in ENV_PATH.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

CONFIG_PATH = Path(__file__).parent / "config.json"
CONFIG = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}

USER_ID = os.environ.get("THREADS_USER_ID", CONFIG.get("user_id", ""))
ACCESS_TOKEN = os.environ.get("THREADS_ACCESS_TOKEN", "")
MY_USERNAME = CONFIG.get("username", "tangcruzz")

API_BASE = "https://graph.threads.net/v1.0"

import threads_db as db


# ── API helpers ──

def api_get(endpoint, params=None):
    """GET request to Threads API."""
    params = params or {}
    params["access_token"] = ACCESS_TOKEN
    qs = urllib.parse.urlencode(params)
    url = f"{API_BASE}/{endpoint}?{qs}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "ThreadsReplyBot/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else ""
        print(f"  ❌ API error {e.code}: {body[:200]}")
        return None
    except Exception as e:
        print(f"  ❌ Request error: {e}")
        return None


def api_post(endpoint, data):
    """POST request to Threads API."""
    data["access_token"] = ACCESS_TOKEN
    body = urllib.parse.urlencode(data).encode()
    url = f"{API_BASE}/{endpoint}"
    try:
        req = urllib.request.Request(url, data=body, method="POST",
                                     headers={"User-Agent": "ThreadsReplyBot/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else ""
        print(f"  ❌ API error {e.code}: {body[:200]}")
        return None
    except Exception as e:
        print(f"  ❌ Request error: {e}")
        return None


# ── Core commands ──

def cmd_scan():
    """Scan recent posts and their conversation threads, upsert into DB."""
    print("🔍 Scanning posts...")

    # Fetch my recent posts
    data = api_get(f"{USER_ID}/threads", {
        "fields": "id,text,timestamp,like_count,repost_count",
        "limit": 10
    })
    if not data or "data" not in data:
        print("  ❌ Failed to fetch posts")
        return

    conn = db.get_conn()
    posts = data["data"]
    print(f"  Found {len(posts)} posts")

    # Ensure own profile exists
    db.upsert_profile(conn, USER_ID, MY_USERNAME)
    conn.commit()

    total_comments = 0
    my_replies = 0

    for post in posts:
        post_id = post["id"]
        db.upsert_post(conn, post_id, USER_ID, post.get("text", ""),
                        like_count=post.get("like_count", 0),
                        repost_count=post.get("repost_count", 0),
                        posted_at=post.get("timestamp"))

        # Use /conversation endpoint with replied_to for parent-child tracking
        # Paginate to get ALL comments (not just first 50)
        all_conv_entries = []
        conv = api_get(f"{post_id}/conversation", {
            "fields": "id,text,timestamp,username,like_count,reply_count,replied_to",
            "limit": 50
        })
        if not conv or "data" not in conv:
            continue
        all_conv_entries.extend(conv["data"])
        # Follow pagination
        while conv.get("paging", {}).get("cursors", {}).get("after"):
            conv = api_get(f"{post_id}/conversation", {
                "fields": "id,text,timestamp,username,like_count,reply_count,replied_to",
                "limit": 50,
                "after": conv["paging"]["cursors"]["after"]
            })
            if conv and "data" in conv:
                all_conv_entries.extend(conv["data"])
            else:
                break
        conv = {"data": all_conv_entries}

        post_comments = 0
        # First pass: collect all entries, build ID set, separate mine vs others
        my_reply_targets = set()  # comment IDs that Cruz replied to
        all_entries = conv["data"]
        all_ids = {post_id}  # IDs we know exist (post itself)
        others = []

        # Sort: entries with no parent (or parent=post) first, then children
        # This ensures parents are inserted before children (FK constraint)
        top_level = []
        nested = []
        for entry in all_entries:
            replied_to = entry.get("replied_to", {}).get("id")
            if not replied_to or replied_to == post_id:
                top_level.append(entry)
            else:
                nested.append(entry)
        sorted_entries = top_level + nested  # parents first

        for entry in sorted_entries:
            eid = entry["id"]
            username = entry.get("username", "unknown")
            replied_to = entry.get("replied_to", {}).get("id")
            parent = replied_to if (replied_to and replied_to != post_id and replied_to in all_ids) else None

            db.upsert_profile(conn, username, username)
            db.upsert_comment(conn, eid, post_id, username,
                               entry.get("text", ""),
                               like_count=entry.get("like_count", 0),
                               reply_count=entry.get("reply_count", 0),
                               posted_at=entry.get("timestamp"),
                               parent_comment_id=parent)
            all_ids.add(eid)

            if username == MY_USERNAME:
                my_replies += 1
                if replied_to and replied_to != post_id:
                    my_reply_targets.add(replied_to)
            else:
                others.append(entry)

            # If Cruz already replied to this comment, record it
            if eid in my_reply_targets:
                existing = conn.execute(
                    "SELECT reply_id FROM replies WHERE comment_id=? AND status='sent'",
                    (eid,)
                ).fetchone()
                if not existing:
                    db.add_reply(conn, eid, post_id, "[已回覆-scan同步]", status="sent")

            post_comments += 1

        if post_comments > 0:
            conn.execute("UPDATE posts SET reply_count=? WHERE post_id=?",
                         (post_comments, post_id))
            replied_count = len([e for e in others if e["id"] in my_reply_targets])
            pending_count = post_comments - replied_count
            print(f"  Post {post_id} → {post_comments} comments ({replied_count} replied, {pending_count} pending)")
            total_comments += post_comments

    conn.commit()

    # L2 deep scan: check sub-replies to our own replies
    # The conversation API sometimes misses deep reply chains
    import time as _time
    our_replies_data = api_get(f"{USER_ID}/replies", {
        "fields": "id,text,timestamp,replied_to",
        "limit": 25
    })
    deep_found = 0
    if our_replies_data and "data" in our_replies_data:
        for our_reply in our_replies_data["data"]:
            sub = api_get(f"{our_reply['id']}/replies", {
                "fields": "id,text,username,timestamp",
                "limit": 10
            })
            if sub and "data" in sub:
                for s in sub["data"]:
                    if s.get("username") == MY_USERNAME:
                        continue
                    exists = conn.execute("SELECT 1 FROM comments WHERE comment_id=?", (s["id"],)).fetchone()
                    if not exists:
                        username = s.get("username", "")
                        db.upsert_profile(conn, username, username)
                        parent_ref = our_reply.get("replied_to", {})
                        parent_id = parent_ref.get("id", "") if parent_ref else ""
                        post_row = conn.execute("SELECT post_id FROM comments WHERE comment_id=?", (parent_id,)).fetchone()
                        pid = post_row["post_id"] if post_row else ""
                        db.upsert_comment(conn, s["id"], pid, username,
                                          s.get("text", ""), posted_at=s.get("timestamp"),
                                          parent_comment_id=our_reply["id"])
                        deep_found += 1
            _time.sleep(0.3)
    if deep_found:
        conn.commit()
        print(f"  🔍 Deep scan: found {deep_found} sub-replies to our comments")

    # Show summary
    stats = db.get_stats(conn)
    conn.close()
    print(f"\n📊 DB: {stats['posts']} posts, {stats['comments']} comments, "
          f"{stats['replies']} replies tracked, {stats['pending_replies']} pending")


def cmd_pending(post_id=None):
    """Show comments that haven't been replied to."""
    conn = db.get_conn()

    # Comments where no reply exists with our username
    q = """
        SELECT c.comment_id, c.text_content, c.posted_at, c.like_count,
               p.username, p.follower_count,
               po.post_id, SUBSTR(po.text_content, 1, 40) as post_preview
        FROM comments c
        JOIN posts po ON c.post_id = po.post_id
        LEFT JOIN profiles p ON c.user_id = p.user_id
        LEFT JOIN replies r ON c.comment_id = r.comment_id AND r.status IN ('sent', 'pending', 'approved')
        WHERE r.reply_id IS NULL
    """
    params = []
    if post_id:
        q += " AND c.post_id = ?"
        params.append(post_id)
    q += " ORDER BY c.posted_at ASC"

    rows = conn.execute(q, params).fetchall()
    conn.close()

    if not rows:
        print("✅ No pending comments")
        return

    print(f"📋 {len(rows)} pending comments:\n")
    for i, r in enumerate(rows, 1):
        username = r["username"] or "unknown"
        followers = r["follower_count"] or 0
        fstr = f"({followers:,})" if followers else ""
        print(f"  {i}. @{username} {fstr}")
        print(f"     「{r['text_content'][:60]}」")
        print(f"     Post: {r['post_preview']}...")
        print(f"     ID: {r['comment_id']}")
        print()


def cmd_dive(username):
    """Deep dive a user's profile via API."""
    print(f"🔍 Deep diving @{username}...")

    # Search for user
    data = api_get(f"{USER_ID}/search", {
        "q": username,
        "fields": "id,username,name,threads_biography,followers_count,is_verified"
    })

    if not data or "data" not in data:
        # Try direct profile fetch if search doesn't work
        print(f"  Search API not available, trying profile lookup...")
        # Fallback: check if we have them in DB
        conn = db.get_conn()
        row = conn.execute("SELECT * FROM profiles WHERE username=?", (username,)).fetchone()
        conn.close()
        if row:
            print(f"  Found in DB: @{row['username']} ({row['follower_count']} followers)")
            print(f"  Bio: {row['bio'] or 'N/A'}")
        else:
            print(f"  Not found. Add manually with seed command.")
        return

    for user in data["data"]:
        uid = user["id"]
        conn = db.get_conn()
        db.upsert_profile(conn, uid, user.get("username", username),
                           display_name=user.get("name"),
                           bio=user.get("threads_biography"),
                           follower_count=user.get("followers_count", 0),
                           is_verified=user.get("is_verified", False))
        conn.commit()

        print(f"  @{user.get('username')} — {user.get('followers_count', 0):,} followers")
        print(f"  Bio: {user.get('threads_biography', 'N/A')}")

        # Fetch their recent threads
        threads = api_get(f"{uid}/threads", {
            "fields": "id,text,timestamp,like_count",
            "limit": 10
        })
        if threads and "data" in threads:
            print(f"\n  Recent posts ({len(threads['data'])}):")
            for t in threads["data"][:5]:
                print(f"    • {t.get('text', '')[:80]}")

        conn.close()


def cmd_draft(comment_id, text, tone="strategic", strategy=None):
    """Create a draft reply for a comment."""
    conn = db.get_conn()

    # Get the comment info
    comment = conn.execute("SELECT * FROM comments WHERE comment_id=?", (comment_id,)).fetchone()
    if not comment:
        print(f"  ❌ Comment {comment_id} not found")
        conn.close()
        return

    draft_id = db.add_draft(conn, comment_id, comment["post_id"], text,
                             tone=tone, strategy=strategy)
    conn.commit()
    conn.close()
    print(f"  ✅ Draft #{draft_id} created for comment {comment_id[:20]}...")


def cmd_review():
    """Show all drafts in 'draft' status."""
    conn = db.get_conn()
    rows = conn.execute("""
        SELECT d.draft_id, d.draft_text, d.tone, d.strategy,
               c.text_content as comment_text,
               p.username, p.follower_count
        FROM drafts d
        JOIN comments c ON d.comment_id = c.comment_id
        LEFT JOIN profiles p ON c.user_id = p.user_id
        WHERE d.status = 'draft'
        ORDER BY d.created_at ASC
    """).fetchall()
    conn.close()

    if not rows:
        print("✅ No pending drafts")
        return

    print(f"📋 {len(rows)} drafts for review:\n")
    for r in rows:
        username = r["username"] or "unknown"
        followers = r["follower_count"] or 0
        fstr = f" ({followers:,})" if followers else ""
        tone_icon = "🥃" if r["tone"] == "toast" else "🎯"
        print(f"  #{r['draft_id']} {tone_icon} @{username}{fstr}")
        print(f"  留言：「{r['comment_text'][:60]}」")
        print(f"  草稿：「{r['draft_text']}」")
        if r["strategy"]:
            print(f"  策略：{r['strategy']}")
        print()


def cmd_approve(draft_id, revised_text=None):
    """Approve a draft → create a pending reply."""
    conn = db.get_conn()
    draft = conn.execute("SELECT * FROM drafts WHERE draft_id=?", (draft_id,)).fetchone()
    if not draft:
        print(f"  ❌ Draft #{draft_id} not found")
        conn.close()
        return

    final_text = revised_text or draft["draft_text"]

    # Mark draft as selected
    conn.execute("UPDATE drafts SET status='selected' WHERE draft_id=?", (draft_id,))

    # Create pending reply
    reply_id = db.add_reply(conn, draft["comment_id"], draft["post_id"],
                             final_text, draft_id=draft_id, status="pending")
    conn.commit()
    conn.close()

    action = "revised" if revised_text else "approved"
    print(f"  ✅ Draft #{draft_id} {action} → Reply #{reply_id} (pending)")


def cmd_backfill():
    """往回翻頁抓所有歷史貼文 + permalink，直到最初一篇。"""
    print("📜 Backfilling all historical posts...")

    conn = db.get_conn()
    db.upsert_profile(conn, USER_ID, MY_USERNAME)

    total_new = 0
    after_cursor = None
    page = 0

    while True:
        page += 1
        params = {
            "fields": "id,text,timestamp,like_count,repost_count,permalink,media_url,media_type",
            "limit": 50  # Max per page
        }
        if after_cursor:
            params["after"] = after_cursor

        data = api_get(f"{USER_ID}/threads", params)
        if not data or "data" not in data:
            print(f"  Page {page}: API error or no data")
            break

        posts = data["data"]
        if not posts:
            print(f"  Page {page}: empty → reached the beginning!")
            break

        new_count = 0
        for post in posts:
            post_id = post["id"]
            # Check if already exists
            existing = conn.execute("SELECT post_id FROM posts WHERE post_id=?", (post_id,)).fetchone()

            text = post.get("text", "")
            permalink = post.get("permalink", "")
            media_url = post.get("media_url", "")
            media_type = post.get("media_type", "")

            meta = {
                "permalink": permalink,
                "media_url": media_url,
                "media_type": media_type
            }

            db.upsert_post(conn, post_id, USER_ID, text,
                           like_count=post.get("like_count", 0),
                           repost_count=post.get("repost_count", 0),
                           posted_at=post.get("timestamp"),
                           meta_json=json.dumps(meta, ensure_ascii=False))

            if not existing:
                new_count += 1

        conn.commit()
        total_new += new_count

        oldest = posts[-1].get("timestamp", "?") if posts else "?"
        print(f"  Page {page}: {len(posts)} posts ({new_count} new), oldest: {oldest}")

        # Check for next page
        paging = data.get("paging", {})
        cursors = paging.get("cursors", {})
        after_cursor = cursors.get("after")
        if not after_cursor or "next" not in paging:
            print(f"  No more pages → done!")
            break

        time.sleep(1)  # Rate limit courtesy

    stats = db.get_stats(conn)
    conn.close()
    print(f"\n✅ Backfill done: +{total_new} new posts")
    print(f"📊 DB total: {stats['posts']} posts, oldest to newest")


def cmd_reject(draft_id):
    """Reject a draft."""
    conn = db.get_conn()
    conn.execute("UPDATE drafts SET status='discarded' WHERE draft_id=?", (draft_id,))
    conn.commit()
    conn.close()
    print(f"  ✅ Draft #{draft_id} rejected")


def cmd_send(dry_run=False):
    """Send all pending replies via Threads API. Parallel: 5 at a time."""
    import concurrent.futures

    conn = db.get_conn()
    pending = db.get_pending_replies(conn)

    if not pending:
        print("✅ No pending replies to send")
        conn.close()
        return

    print(f"📤 Sending {len(pending)} replies (parallel)...")

    if dry_run:
        for i, reply in enumerate(pending):
            comment = conn.execute(
                "SELECT p.username FROM comments c LEFT JOIN profiles p ON c.user_id = p.user_id WHERE c.comment_id=?",
                (reply["comment_id"],)
            ).fetchone()
            print(f"  [{i+1}] @{comment['username'] if comment else '?'}: {reply['reply_text'][:50]}")
        conn.close()
        return

    def send_one(reply):
        """Send a single reply. Returns (reply_id, success, msg)."""
        rid = reply["reply_id"]
        cid = reply["comment_id"]
        text = reply["reply_text"]
        # Optimistic lock: claim this reply by setting status to 'sending'
        for attempt in range(3):
            try:
                lock_conn = db.get_conn()
                changed = lock_conn.execute(
                    "UPDATE replies SET status='sending' WHERE reply_id=? AND status='pending'", (rid,)
                ).rowcount
                lock_conn.commit()
                lock_conn.close()
                break
            except Exception:
                time.sleep(1)
                changed = 0
        if changed == 0:
            return (rid, False, "already claimed or db locked")
        # Step 1: container
        result = api_post(f"{USER_ID}/threads", {
            "media_type": "TEXT", "text": text, "reply_to_id": cid
        })
        if not result or "id" not in result:
            return (rid, False, f"container: {result}")
        # Step 2: wait + publish
        time.sleep(2)
        pub = api_post(f"{USER_ID}/threads_publish", {"creation_id": result["id"]})
        if pub and "id" in pub:
            return (rid, True, pub["id"])
        # retry once
        time.sleep(3)
        pub2 = api_post(f"{USER_ID}/threads_publish", {"creation_id": result["id"]})
        if pub2 and "id" in pub2:
            return (rid, True, pub2["id"])
        return (rid, False, f"publish: {pub2}")

    # Fire 5 at a time
    sent = 0
    failed = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        futures = {pool.submit(send_one, r): r for r in pending}
        for future in concurrent.futures.as_completed(futures):
            rid, ok, msg = future.result()
            reply = futures[future]
            comment = conn.execute(
                "SELECT p.username FROM comments c LEFT JOIN profiles p ON c.user_id = p.user_id WHERE c.comment_id=?",
                (reply["comment_id"],)
            ).fetchone()
            uname = comment["username"] if comment else "?"
            if ok:
                db.mark_reply_sent(conn, rid)
                sent += 1
                print(f"  ✅ @{uname}")
            else:
                db.mark_reply_failed(conn, rid, msg)
                failed += 1
                print(f"  ❌ @{uname}: {msg[:60]}")

    conn.commit()
    conn.close()
    print(f"\n📊 {sent} sent, {failed} failed")
    return  # skip old code below

    # ---- old serial code below (dead code, kept for reference) ----
    cooldown = CONFIG.get("reply_rules", {}).get("cooldown_between_replies_sec", 30)
    for i, reply in enumerate(pending):
        rid = reply["reply_id"]
        comment_id = reply["comment_id"]
        text = reply["reply_text"]
        comment = conn.execute(
            "SELECT c.*, p.username FROM comments c LEFT JOIN profiles p ON c.user_id = p.user_id WHERE c.comment_id=?",
            (comment_id,)
        ).fetchone()
        username = comment["username"] if comment else "unknown"
        print(f"\n  [{i+1}/{len(pending)}] @{username}: 「{text[:50]}」")
        if dry_run:
            print(f"  [DRY RUN] Would send reply to {comment_id}")
            continue
        result = api_post(f"{USER_ID}/threads", {
            "media_type": "TEXT",
            "text": text,
            "reply_to_id": comment_id
        })
        if not result or "id" not in result:
            db.mark_reply_failed(conn, rid, f"Container creation failed: {result}")
            conn.commit()
            print(f"  ❌ Failed to create container")
            continue
        container_id = result["id"]
        # Step 2: Publish
        pub = api_post(f"{USER_ID}/threads_publish", {
            "creation_id": container_id
        })

        if pub and "id" in pub:
            db.mark_reply_sent(conn, rid)
            conn.commit()
            print(f"  ✅ Sent (thread_id: {pub['id']})")
        else:
            db.mark_reply_failed(conn, rid, f"Publish failed: {pub}")
            conn.commit()
            print(f"  ❌ Publish failed")

        # Cooldown between replies
        if i < len(pending) - 1:
            print(f"  ⏳ Cooldown {cooldown}s...")
            time.sleep(cooldown)

    conn.close()
    print("\n✅ Send batch complete")


def cmd_status():
    """Overall system status."""
    conn = db.get_conn()
    stats = db.get_stats(conn)

    # Drafts by status
    draft_stats = conn.execute("""
        SELECT status, COUNT(*) as cnt FROM drafts GROUP BY status
    """).fetchall()

    # Replies by status
    reply_stats = conn.execute("""
        SELECT status, COUNT(*) as cnt FROM replies GROUP BY status
    """).fetchall()

    conn.close()

    print("📊 Threads Reply System Status\n")
    print(f"  Posts tracked:    {stats['posts']}")
    print(f"  Comments:         {stats['comments']}")
    print(f"  Profiles cached:  {stats['profiles']}")
    print(f"  Replies total:    {stats['replies']}")
    print(f"  Pending to send:  {stats['pending_replies']}")

    if draft_stats:
        print(f"\n  Drafts:")
        for ds in draft_stats:
            print(f"    {ds['status']}: {ds['cnt']}")

    if reply_stats:
        print(f"\n  Replies:")
        for rs in reply_stats:
            print(f"    {rs['status']}: {rs['cnt']}")


def cmd_seed():
    """Seed DB with data from the conversation (算力接管 post)."""
    conn = db.get_conn()

    # Cruz's profile
    db.upsert_profile(conn, USER_ID, MY_USERNAME,
                       display_name="Cruz Tang",
                       follower_count=0)

    # Seed known profiles from conversation
    profiles = [
        ("crboy.tw", "crboy.tw", None, None, 0),
        ("skpracta", "skpracta", None, None, 0),
        ("lei.billy", "lei.billy", None, None, 0),
        ("mngsrrr", "mngsrrr", None, None, 0),
        ("xyzgabcde", "xyzgabcde", None, None, 0),
        ("kordan.ou", "kordan.ou", None, None, 8800),
        ("dankopeng", "dankopeng", None, None, 7200),
        ("seattle.fire", "seattle.fire", None, None, 4300),
        ("eth.hsi", "eth.hsi", None, None, 894),
        ("hsuchu", "hsuchu", "許崇銘", "極限運動員", 576),
        ("deedeoloo2.0", "deedeoloo2.0", None, None, 0),
        ("erixtt9900", "erixtt9900", "EXICTKK9900", "Crypto / Soccer / Investing", 215),
        ("moo_singer1069", "moo_singer1069", None, None, 0),
    ]

    for uid, uname, dname, bio, followers in profiles:
        db.upsert_profile(conn, uid, uname, display_name=dname, bio=bio,
                           follower_count=followers)

    print(f"  ✅ {len(profiles)} profiles seeded")

    # We don't have actual post_id / comment_ids from the conversation,
    # so mark as placeholder — will be replaced on first `scan`
    print("  ℹ️  Run `scan` to fetch actual post/comment IDs from API")

    conn.commit()
    stats = db.get_stats(conn)
    conn.close()
    print(f"\n📊 After seed: {json.dumps(stats)}")


def cmd_quick_reply(comment_id, text):
    """Shortcut: draft + approve + send in one step (for pre-approved replies)."""
    conn = db.get_conn()
    comment = conn.execute("SELECT * FROM comments WHERE comment_id=?", (comment_id,)).fetchone()
    if not comment:
        print(f"  ❌ Comment {comment_id} not found")
        conn.close()
        return

    reply_id = db.add_reply(conn, comment_id, comment["post_id"], text, status="pending")
    conn.commit()
    conn.close()
    print(f"  ✅ Quick reply #{reply_id} created (pending). Run `send` to publish.")


# ── Main ──

USAGE = """
Usage: threads_reply.py <command> [args]

Commands:
  scan                         Fetch posts + comments from API → DB
  pending [post_id]            Show unreplied comments
  dive <username>              Deep dive a user's profile
  draft <comment_id> <text>    Create a draft reply
  review                       Show drafts for review
  approve <draft_id> [text]    Approve (optionally revise) a draft
  reject <draft_id>            Reject a draft
  send [--dry-run]             Send all pending replies
  quick <comment_id> <text>    Draft + approve in one step
  status                       Show overall stats
  seed                         Seed DB with conversation data
"""

if __name__ == "__main__":
    db.init_db()

    if len(sys.argv) < 2:
        print(USAGE)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "scan":
        cmd_scan()
    elif cmd == "pending":
        cmd_pending(sys.argv[2] if len(sys.argv) > 2 else None)
    elif cmd == "dive":
        if len(sys.argv) < 3:
            print("Usage: dive <username>")
        else:
            cmd_dive(sys.argv[2])
    elif cmd == "draft":
        if len(sys.argv) < 4:
            print("Usage: draft <comment_id> <text> [tone] [strategy]")
        else:
            cmd_draft(sys.argv[2], sys.argv[3],
                      tone=sys.argv[4] if len(sys.argv) > 4 else "strategic",
                      strategy=sys.argv[5] if len(sys.argv) > 5 else None)
    elif cmd == "review":
        cmd_review()
    elif cmd == "approve":
        if len(sys.argv) < 3:
            print("Usage: approve <draft_id> [revised_text]")
        else:
            cmd_approve(int(sys.argv[2]),
                        sys.argv[3] if len(sys.argv) > 3 else None)
    elif cmd == "reject":
        if len(sys.argv) < 3:
            print("Usage: reject <draft_id>")
        else:
            cmd_reject(int(sys.argv[2]))
    elif cmd == "send":
        cmd_send(dry_run="--dry-run" in sys.argv)
    elif cmd == "quick":
        if len(sys.argv) < 4:
            print("Usage: quick <comment_id> <text>")
        else:
            cmd_quick_reply(sys.argv[2], sys.argv[3])
    elif cmd == "status":
        cmd_status()
    elif cmd == "seed":
        cmd_seed()
    elif cmd == "backfill":
        cmd_backfill()
    else:
        print(f"Unknown command: {cmd}")
        print(USAGE)
