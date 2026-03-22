#!/usr/bin/env python3
"""
X CLI — X/Twitter 統一操作入口

手動控制 X 社群互動：掃描、草稿管理、發推、互動追蹤。

用法:
  python3 x_cli.py scan                    # 掃描目標帳號 + 關鍵字搜尋
  python3 x_cli.py drafts                  # 看待發草稿
  python3 x_cli.py send <id>               # 發送指定草稿
  python3 x_cli.py send-all                # 發送所有已核可草稿
  python3 x_cli.py score "text"            # 評估一段文字的品質
  python3 x_cli.py post "text"             # 發一條推文
  python3 x_cli.py thread "t1" "t2" "t3"   # 發推文串
  python3 x_cli.py reply <url> "text"      # 回覆指定推文
  python3 x_cli.py quote <url> "text"      # 引用推文
  python3 x_cli.py engage <handle>         # 互動指定帳號（掃描 + 產生草稿）
  python3 x_cli.py follow <handle>         # 追蹤帳號
  python3 x_cli.py profile <handle>        # 查看帳號資訊
  python3 x_cli.py notifications           # 查看通知
  python3 x_cli.py metrics                 # 顯示互動指標
  python3 x_cli.py status                  # 總覽
"""

import sys
import time
import random
from datetime import datetime, timezone
from pathlib import Path

WORK_DIR = Path(__file__).parent
sys.path.insert(0, str(WORK_DIR))


def cmd_scan():
    """Full scan: target accounts + keyword search + draft generation."""
    from x_patrol import cmd_scan as patrol_scan
    patrol_scan()


def cmd_drafts():
    """Show pending reply drafts."""
    from x_patrol import cmd_drafts as patrol_drafts
    patrol_drafts()


def cmd_send(tweet_id):
    """Send a specific draft reply."""
    from x_patrol import get_db, record_interaction, mark_tweet_replied
    from adapters.x_twitter import XTwitterAdapter

    conn = get_db()
    row = conn.execute(
        "SELECT id, url, author, content, reply_text, reply_score "
        "FROM tweets WHERE id = ? AND replied = FALSE",
        (tweet_id,)
    ).fetchone()

    if not row:
        # Try matching by partial ID
        row = conn.execute(
            "SELECT id, url, author, content, reply_text, reply_score "
            "FROM tweets WHERE id LIKE ? AND replied = FALSE",
            (f"%{tweet_id}%",)
        ).fetchone()

    if not row:
        print(f"  Tweet {tweet_id} not found or already replied.")
        conn.close()
        return False

    if not row['reply_text']:
        print(f"  No draft reply for this tweet. Run: x_cli.py scan")
        conn.close()
        return False

    print(f"  Sending reply to @{row['author']}...")
    print(f"  Tweet: {row['content'][:80]}...")
    print(f"  Reply: {row['reply_text']}")
    print(f"  Quality: {row['reply_score']:.1f}/10")

    adapter = XTwitterAdapter()
    success = adapter.reply_to_tweet(row['url'], row['reply_text'])

    if success:
        mark_tweet_replied(row['id'], row['reply_text'])
        record_interaction('reply', row['url'], row['author'],
                          row['reply_text'], row['reply_score'])
        print(f"\n  Reply sent to @{row['author']}")
    else:
        print(f"\n  Failed to send reply")

    conn.close()
    return success


def cmd_send_all():
    """Send all pending drafts with quality >= 6.0."""
    from x_patrol import get_db

    conn = get_db()
    rows = conn.execute("""
        SELECT id, author, reply_score
        FROM tweets
        WHERE replied = FALSE AND reply_text IS NOT NULL AND reply_text != ''
          AND reply_score >= 6.0
        ORDER BY reply_score DESC
    """).fetchall()
    conn.close()

    if not rows:
        print("  No approved drafts to send.")
        return

    print(f"  Sending {len(rows)} drafts...\n")
    sent = 0
    for r in rows:
        print(f"  [{sent+1}/{len(rows)}] @{r['author']} (q={r['reply_score']:.1f})")
        ok = cmd_send(r['id'])
        if ok:
            sent += 1
        # Rate limit: 3 minute gap between replies
        if sent < len(rows):
            wait = random.randint(180, 300)
            print(f"  Waiting {wait}s before next...\n")
            time.sleep(wait)

    print(f"\n  Sent {sent}/{len(rows)} replies")


def cmd_score(text):
    """Score a potential tweet/reply."""
    from x_patrol import score_tweet
    from x_shadow import score_reply

    # Rule-based relevance score
    relevance = score_tweet(text, "self")
    print(f"  Relevance score:  {relevance:.1f}/10")

    # Content brain resonance
    try:
        from content_brain import ResonanceFilter
        rf = ResonanceFilter()
        res = rf.score(text)
        print(f"  Resonance score:  {res['total_score']}/100")
        print(f"  Should engage:    {res['should_engage']}")
        if res['top_frequencies']:
            freqs = ', '.join(f[0] for f in res['top_frequencies'])
            print(f"  Top frequencies:  {freqs}")
    except Exception:
        pass

    print(f"\n  Text length:      {len(text)} chars")
    if len(text) > 280:
        print(f"  WARNING: exceeds 280 char limit by {len(text) - 280}")


def cmd_post(text):
    """Post a new tweet."""
    from adapters.x_twitter import XTwitterAdapter
    from x_patrol import record_interaction

    if len(text) > 280:
        print(f"  WARNING: {len(text)} chars (limit 280). Truncating.")
        text = text[:277] + "..."

    print(f"  Posting tweet ({len(text)} chars):")
    print(f"  {text}\n")

    adapter = XTwitterAdapter()
    success = adapter.send("self", text)

    if success:
        record_interaction('post', '', 'self', text, 0)
        print("  Tweet posted")
    else:
        print("  Failed to post")


def cmd_thread(tweets):
    """Post a thread of multiple tweets."""
    from adapters.x_twitter import XTwitterAdapter
    from x_patrol import record_interaction

    print(f"  Posting thread ({len(tweets)} tweets):\n")
    for i, t in enumerate(tweets, 1):
        print(f"  [{i}] {t[:60]}{'...' if len(t) > 60 else ''} ({len(t)} chars)")
        if len(t) > 280:
            print(f"      WARNING: exceeds 280 limit")

    adapter = XTwitterAdapter()
    url = adapter.post_thread(tweets)

    if url:
        record_interaction('thread', url, 'self', tweets[0][:200], 0)
        print(f"\n  Thread posted: {url}")
    else:
        print(f"\n  Failed to post thread")


def cmd_reply(url, text):
    """Reply to a specific tweet by URL."""
    from adapters.x_twitter import XTwitterAdapter
    from x_patrol import record_interaction

    if len(text) > 280:
        print(f"  WARNING: {len(text)} chars. Truncating.")
        text = text[:277] + "..."

    print(f"  Replying to: {url}")
    print(f"  Reply: {text}\n")

    adapter = XTwitterAdapter()
    success = adapter.reply_to_tweet(url, text)

    if success:
        # Extract author from URL
        author = url.split('x.com/')[-1].split('/')[0] if 'x.com/' in url else '?'
        record_interaction('reply', url, author, text, 0)
        print("  Reply sent")
    else:
        print("  Failed to reply")


def cmd_quote(url, text):
    """Quote tweet with commentary."""
    from adapters.x_twitter import XTwitterAdapter
    from x_patrol import record_interaction

    print(f"  Quoting: {url}")
    print(f"  Comment: {text}\n")

    adapter = XTwitterAdapter()
    success = adapter.quote_tweet(url, text)

    if success:
        author = url.split('x.com/')[-1].split('/')[0] if 'x.com/' in url else '?'
        record_interaction('quote', url, author, text, 0)
        print("  Quote tweet posted")
    else:
        print("  Failed to quote tweet")


def cmd_engage(handle):
    """Engage with a specific account: scan their tweets + generate drafts."""
    from adapters.x_twitter import XTwitterAdapter
    from x_patrol import get_db, score_tweet, generate_reply_draft

    print(f"=== Engaging @{handle} ===\n")

    # 1. Get profile
    adapter = XTwitterAdapter()
    profile = adapter.get_profile(handle)
    print(f"  Name:      {profile.get('name', '?')}")
    print(f"  Bio:       {profile.get('bio', '?')[:100]}")
    print(f"  Followers: {profile.get('followers', '?')}")

    # 2. Scan their recent tweets
    print(f"\n  Scanning @{handle}'s tweets...")
    tweets = adapter.scan_account(handle, max_results=8)
    print(f"  Found {len(tweets)} tweets\n")

    if not tweets:
        print("  No tweets found.")
        return

    # 3. Score and store
    conn = get_db()
    candidates = []
    for tw in tweets:
        tweet_id = tw.get('id', '')
        if not tweet_id:
            continue

        relevance = score_tweet(tw['text'], handle)

        conn.execute(
            "INSERT OR IGNORE INTO tweets (id, url, author, content, relevance_score, found_at) "
            "VALUES (?,?,?,?,?,?)",
            (tweet_id, tw.get('url', ''), handle, tw['text'][:500],
             relevance, datetime.now(timezone.utc).isoformat())
        )
        candidates.append({
            'id': tweet_id, 'url': tw.get('url', ''),
            'text': tw['text'], 'score': relevance,
        })

    conn.commit()

    # 4. Generate drafts for top tweets
    candidates.sort(key=lambda x: x['score'], reverse=True)
    top = [c for c in candidates if c['score'] >= 5.0][:3]

    if not top:
        print("  No tweets scored high enough for replies.")
        conn.close()
        return

    print(f"  Top {len(top)} reply candidates:\n")
    for c in top:
        print(f"  [{c['score']:.1f}] {c['text'][:80]}...")

        reply, quality = generate_reply_draft(c['text'], handle)
        if reply and quality >= 5.0:
            conn.execute(
                "UPDATE tweets SET reply_text = ?, reply_score = ? WHERE id = ?",
                (reply, quality, c['id'])
            )
            print(f"    Draft (q={quality:.1f}): {reply[:80]}...")
        else:
            print(f"    (skipped)")
        print()

    conn.commit()
    conn.close()
    print(f"  Done. Run 'x_cli.py drafts' to review, 'x_cli.py send <id>' to post.")


def cmd_follow(handle):
    """Follow an account."""
    from adapters.x_twitter import XTwitterAdapter
    from x_patrol import record_interaction

    adapter = XTwitterAdapter()
    success = adapter.follow(handle)

    if success:
        record_interaction('follow', f'https://x.com/{handle}', handle, '', 0)
        print(f"  Followed @{handle}")
    else:
        print(f"  Failed to follow @{handle} (may already follow)")


def cmd_profile(handle):
    """Show profile info + engagement stats."""
    from adapters.x_twitter import XTwitterAdapter
    from x_patrol import get_db

    adapter = XTwitterAdapter()
    profile = adapter.get_profile(handle)

    print(f"=== @{handle} ===\n")
    print(f"  Name:      {profile.get('name', '?')}")
    print(f"  Bio:       {profile.get('bio', '(none)')}")
    print(f"  Followers: {profile.get('followers', '?')}")

    # Check our interaction history
    conn = get_db()
    interactions = conn.execute(
        "SELECT type, our_text, quality_score, timestamp "
        "FROM x_interactions WHERE target_author = ? ORDER BY timestamp DESC LIMIT 10",
        (handle,)
    ).fetchall()

    tweets_from = conn.execute(
        "SELECT COUNT(*) as c FROM tweets WHERE author = ?",
        (handle,)
    ).fetchone()['c']

    replied_to = conn.execute(
        "SELECT COUNT(*) as c FROM tweets WHERE author = ? AND replied = TRUE",
        (handle,)
    ).fetchone()['c']

    conn.close()

    print(f"\n  Tweets tracked: {tweets_from}")
    print(f"  We replied to:  {replied_to}")

    if interactions:
        print(f"\n  Recent interactions:")
        for ix in interactions:
            ts = ix['timestamp'][:10] if ix['timestamp'] else '?'
            print(f"    [{ts}] {ix['type']}  q={ix['quality_score']:.1f}  {ix['our_text'][:50]}")


def cmd_notifications():
    """Check notifications."""
    from adapters.x_twitter import XTwitterAdapter

    adapter = XTwitterAdapter()
    notifs = adapter.get_notifications()

    if not notifs:
        print("  No notifications found.")
        return

    print(f"=== {len(notifs)} Notifications ===\n")
    for n in notifs:
        handle = n.get('handle', '?')
        text = n.get('text', '')[:100]
        ts = n.get('timestamp', '')[:10]
        print(f"  @{handle} [{ts}]")
        print(f"    {text}")
        if n.get('url'):
            print(f"    {n['url']}")
        print()


def cmd_metrics():
    """Show engagement metrics."""
    from x_patrol import cmd_metrics as patrol_metrics
    patrol_metrics()


def cmd_status():
    """Show overall status."""
    from x_shadow import cmd_status as shadow_status
    shadow_status()


# ── Entry point ──────────────────────────────────────────────

USAGE = __doc__

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(USAGE)
        sys.exit(0)

    cmd = sys.argv[1]

    if cmd == "scan":
        cmd_scan()
    elif cmd == "drafts":
        cmd_drafts()
    elif cmd == "send" and len(sys.argv) >= 3:
        cmd_send(sys.argv[2])
    elif cmd == "send-all":
        cmd_send_all()
    elif cmd == "score" and len(sys.argv) >= 3:
        cmd_score(" ".join(sys.argv[2:]))
    elif cmd == "post" and len(sys.argv) >= 3:
        cmd_post(" ".join(sys.argv[2:]))
    elif cmd == "thread" and len(sys.argv) >= 4:
        cmd_thread(sys.argv[2:])
    elif cmd == "reply" and len(sys.argv) >= 4:
        cmd_reply(sys.argv[2], " ".join(sys.argv[3:]))
    elif cmd == "quote" and len(sys.argv) >= 4:
        cmd_quote(sys.argv[2], " ".join(sys.argv[3:]))
    elif cmd == "engage" and len(sys.argv) >= 3:
        cmd_engage(sys.argv[2])
    elif cmd == "follow" and len(sys.argv) >= 3:
        cmd_follow(sys.argv[2])
    elif cmd == "profile" and len(sys.argv) >= 3:
        cmd_profile(sys.argv[2])
    elif cmd == "notifications":
        cmd_notifications()
    elif cmd == "metrics":
        cmd_metrics()
    elif cmd == "status":
        cmd_status()
    else:
        print(USAGE)
        sys.exit(1)
