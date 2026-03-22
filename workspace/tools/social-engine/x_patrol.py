#!/usr/bin/env python3
"""
X Patrol — X/Twitter 巡邏引擎

掃描目標帳號 + 關鍵字搜尋，評分推文價值，產生回覆草稿。
結果存入 x_social.db 追蹤互動歷史。

用法:
  python3 x_patrol.py scan                 # 掃描目標帳號 + 關鍵字搜尋
  python3 x_patrol.py scan-accounts        # 只掃目標帳號
  python3 x_patrol.py scan-search          # 只做關鍵字搜尋
  python3 x_patrol.py drafts               # 看待發草稿
  python3 x_patrol.py scored               # 看已評分推文（按分數排序）
  python3 x_patrol.py history [n]          # 看最近 n 筆互動歷史
  python3 x_patrol.py metrics              # 今日指標
  python3 x_patrol.py mark-replied <id> <text>  # 手動標記已回覆
"""

import json
import os
import sys
import time
import random
import sqlite3
import subprocess
from datetime import datetime, timezone, timedelta
from pathlib import Path

WORK_DIR = Path(__file__).parent
DB_PATH = WORK_DIR / "x_social.db"

# ── Target accounts & keywords ──────────────────────────────

TARGET_ACCOUNTS = [
    "AnthropicAI",
    "alexalbert__",
    "swyx",
    "simonw",
    "kaboroevich",
    "mckaywrigley",
    "levelsio",
    "skiaboron",
    "amasad",
    "sdrzn",
    "karpathy",
    "emaborevich",
]

SEARCH_KEYWORDS = [
    "claude code",
    "ai agent production",
    "autonomous agent",
    "multi-agent system",
    "CLAUDE.md",
    "coding agent",
    "agent architecture",
    "LLM in production",
    "self-healing agent",
    "agentic coding",
]

# ── SOUL for reply generation ────────────────────────────────

REPLY_SOUL = """
You are Cruz Tang (@TangCruzZ), an engineer running 10+ AI agents in production for 90+ days.

Rules for generating a reply:
1. Add a unique technical insight — not just agreement
2. Draw from real experience running agents in production
3. Keep it 1-3 sentences, under 280 characters
4. NO product mentions, NO links, NO self-promotion
5. Sound like a knowledgeable peer, not a fan
6. NO hashtags
7. English only
8. If the tweet is not about AI agents/coding/automation, output SKIP
"""

# ── DB setup ─────────────────────────────────────────────────

def get_db():
    """Connect to x_social.db and ensure schema exists."""
    conn = sqlite3.connect(str(DB_PATH), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=10000")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS tweets (
            id TEXT PRIMARY KEY,
            url TEXT,
            author TEXT,
            content TEXT,
            relevance_score REAL,
            found_at TEXT,
            replied BOOLEAN DEFAULT FALSE,
            reply_text TEXT,
            reply_score REAL
        );

        CREATE TABLE IF NOT EXISTS x_interactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT,
            target_url TEXT,
            target_author TEXT,
            our_text TEXT,
            quality_score REAL,
            timestamp TEXT
        );

        CREATE TABLE IF NOT EXISTS x_metrics (
            date TEXT PRIMARY KEY,
            impressions INTEGER DEFAULT 0,
            profile_visits INTEGER DEFAULT 0,
            followers INTEGER DEFAULT 0,
            replies_sent INTEGER DEFAULT 0,
            avg_quality REAL DEFAULT 0
        );
    """)
    return conn


def call_llm(prompt, system=""):
    """Call Claude CLI for AI-powered scoring/generation."""
    full = f"{system}\n\n{prompt}" if system else prompt
    env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
    try:
        result = subprocess.run(
            ["claude", "--print", "--model", "haiku"],
            input=full, capture_output=True, text=True, timeout=60,
            env=env, cwd="/tmp",
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except Exception:
        pass
    return ""


# ── Scoring ──────────────────────────────────────────────────

def score_tweet(text: str, author: str) -> float:
    """Score a tweet on reply-worthiness (0-10). Pure rules, no AI cost."""
    if not text or len(text) < 30:
        return 0.0

    score = 5.0  # baseline
    text_lower = text.lower()

    # Keyword relevance boost
    high_value_kw = [
        "claude code", "ai agent", "production", "autonomous",
        "multi-agent", "CLAUDE.md", "agentic", "coding agent",
        "self-healing", "agent architecture", "llm ops",
        "prompt engineering", "hallucination", "memory",
    ]
    medium_value_kw = [
        "claude", "gpt", "llm", "cursor", "copilot",
        "windsurf", "vscode", "automation", "devtools",
        "monitoring", "observability", "deployment",
    ]

    high_hits = sum(1 for kw in high_value_kw if kw.lower() in text_lower)
    medium_hits = sum(1 for kw in medium_value_kw if kw.lower() in text_lower)
    score += min(high_hits * 1.0, 3.0)
    score += min(medium_hits * 0.3, 1.0)

    # Author boost — higher score for known influencers
    top_tier = {"AnthropicAI", "alexalbert__", "karpathy", "swyx", "simonw", "levelsio"}
    mid_tier = {"kaboroevich", "mckaywrigley", "skiaboron", "amasad", "sdrzn"}
    if author in top_tier:
        score += 1.5
    elif author in mid_tier:
        score += 0.8

    # Length penalty: very short tweets are low-value
    if len(text) < 50:
        score -= 1.0
    # Very long tweets (threads) get a slight boost
    elif len(text) > 200:
        score += 0.5

    # Question tweets are great for replies
    if '?' in text:
        score += 0.5

    # Penalize retweets / quote tweets with no original content
    if text_lower.startswith('rt ') or text.startswith('"'):
        score -= 2.0

    return max(0.0, min(10.0, round(score, 1)))


def generate_reply_draft(tweet_text: str, author: str) -> tuple[str, float]:
    """Generate a reply draft and score it. Returns (reply_text, quality_score)."""
    prompt = f"""Tweet by @{author}:
"{tweet_text[:400]}"

Write a reply following the rules. If the tweet is not about AI/agents/coding, output only: SKIP"""

    reply = call_llm(prompt, system=REPLY_SOUL)

    if not reply or reply.strip() == "SKIP" or len(reply) < 10:
        return "", 0.0

    # Trim to 280 chars
    if len(reply) > 280:
        reply = reply[:277] + "..."

    # Remove quotes if the LLM wrapped the reply
    reply = reply.strip('"').strip("'").strip()

    # Score the reply quality
    score_prompt = f"""Rate this X reply 1-10:

Reply to @{author}: "{reply}"

Criteria: technical depth, relevance, tone (not sycophantic), conciseness.
Would a senior engineer find this valuable?

Score (just the number):"""

    score_str = call_llm(score_prompt)
    try:
        quality = float(score_str.strip().split('\n')[0].split('/')[0])
    except (ValueError, IndexError):
        quality = 5.0

    return reply, min(10.0, quality)


# ── Patrol operations ────────────────────────────────────────

def scan_accounts(accounts=None, max_per_account=5):
    """Scan target accounts for new tweets."""
    from adapters.x_twitter import XTwitterAdapter

    adapter = XTwitterAdapter()
    conn = get_db()
    accounts = accounts or TARGET_ACCOUNTS
    # Randomize and pick a subset to avoid rate limits
    to_scan = random.sample(accounts, min(4, len(accounts)))

    total_found = 0
    total_new = 0

    for handle in to_scan:
        print(f"  Scanning @{handle}...")
        try:
            tweets = adapter.scan_account(handle, max_results=max_per_account)
        except Exception as e:
            print(f"    Error: {e}")
            continue

        for tw in tweets:
            tweet_id = tw.get('id', '')
            if not tweet_id:
                # Generate a deterministic ID from URL
                tweet_id = tw.get('url', '').split('/status/')[-1].split('/')[0] if '/status/' in tw.get('url', '') else ''
            if not tweet_id:
                continue

            total_found += 1

            # Check if already in DB
            existing = conn.execute("SELECT id FROM tweets WHERE id = ?", (tweet_id,)).fetchone()
            if existing:
                continue

            relevance = score_tweet(tw['text'], handle)

            conn.execute(
                "INSERT OR IGNORE INTO tweets (id, url, author, content, relevance_score, found_at) VALUES (?,?,?,?,?,?)",
                (tweet_id, tw.get('url', ''), handle, tw['text'][:500],
                 relevance, datetime.now(timezone.utc).isoformat())
            )
            total_new += 1

        conn.commit()
        print(f"    Found {len(tweets)} tweets")
        _human_pause()

    conn.close()
    print(f"\n  Total: {total_found} scanned, {total_new} new")
    return total_new


def scan_search(keywords=None, max_per_query=5):
    """Search X for keywords."""
    from adapters.x_twitter import XTwitterAdapter

    adapter = XTwitterAdapter()
    conn = get_db()
    keywords = keywords or SEARCH_KEYWORDS
    # Pick a subset of keywords
    to_search = random.sample(keywords, min(3, len(keywords)))

    total_found = 0
    total_new = 0

    for query in to_search:
        print(f'  Searching: "{query}"...')
        try:
            tweets = adapter.scan_search(query, max_results=max_per_query)
        except Exception as e:
            print(f"    Error: {e}")
            continue

        for tw in tweets:
            tweet_id = tw.get('id', '')
            if not tweet_id:
                tweet_id = tw.get('url', '').split('/status/')[-1].split('/')[0] if '/status/' in tw.get('url', '') else ''
            if not tweet_id:
                continue

            total_found += 1

            existing = conn.execute("SELECT id FROM tweets WHERE id = ?", (tweet_id,)).fetchone()
            if existing:
                continue

            author = tw.get('handle', tw.get('source_account', '?'))
            relevance = score_tweet(tw['text'], author)

            conn.execute(
                "INSERT OR IGNORE INTO tweets (id, url, author, content, relevance_score, found_at) VALUES (?,?,?,?,?,?)",
                (tweet_id, tw.get('url', ''), author, tw['text'][:500],
                 relevance, datetime.now(timezone.utc).isoformat())
            )
            total_new += 1

        conn.commit()
        print(f"    Found {len(tweets)} results")
        _human_pause()

    conn.close()
    print(f"\n  Total: {total_found} scanned, {total_new} new")
    return total_new


def generate_drafts(min_score=6.0, max_drafts=5):
    """Generate reply drafts for top-scored unreplied tweets."""
    conn = get_db()

    # Get top unreplied tweets above threshold
    rows = conn.execute("""
        SELECT id, url, author, content, relevance_score
        FROM tweets
        WHERE replied = FALSE AND reply_text IS NULL
          AND relevance_score >= ?
        ORDER BY relevance_score DESC
        LIMIT ?
    """, (min_score, max_drafts)).fetchall()

    if not rows:
        print("  No tweets above threshold to draft replies for.")
        conn.close()
        return 0

    print(f"  Generating drafts for {len(rows)} tweets...\n")
    drafted = 0

    for row in rows:
        print(f"  @{row['author']} (score={row['relevance_score']:.1f})")
        print(f"    {row['content'][:80]}...")

        reply, quality = generate_reply_draft(row['content'], row['author'])
        if reply and quality >= 5.0:
            conn.execute(
                "UPDATE tweets SET reply_text = ?, reply_score = ? WHERE id = ?",
                (reply, quality, row['id'])
            )
            drafted += 1
            print(f"    Draft (q={quality:.1f}): {reply[:80]}...")
        else:
            # Mark as skipped (set reply_text to empty so we don't retry)
            conn.execute(
                "UPDATE tweets SET reply_text = '', reply_score = 0 WHERE id = ?",
                (row['id'],)
            )
            print(f"    Skipped (irrelevant or low quality)")
        print()

    conn.commit()
    conn.close()
    print(f"  Drafted {drafted}/{len(rows)} replies")
    return drafted


def _human_pause():
    """Pause between operations to appear human."""
    time.sleep(random.uniform(2, 5))


# ── CLI commands ─────────────────────────────────────────────

def cmd_scan():
    """Full scan: accounts + search + generate drafts."""
    print("=== X Patrol: Full Scan ===\n")

    print("[1] Scanning target accounts...")
    new_acct = scan_accounts()

    print("\n[2] Searching keywords...")
    new_search = scan_search()

    print(f"\n[3] Generating reply drafts...")
    drafted = generate_drafts()

    print(f"\n=== Done: {new_acct + new_search} new tweets, {drafted} drafts ===")


def cmd_scan_accounts():
    """Scan target accounts only."""
    print("=== X Patrol: Account Scan ===\n")
    scan_accounts()


def cmd_scan_search():
    """Search keywords only."""
    print("=== X Patrol: Keyword Search ===\n")
    scan_search()


def cmd_drafts():
    """Show pending reply drafts."""
    conn = get_db()
    rows = conn.execute("""
        SELECT id, url, author, content, relevance_score, reply_text, reply_score
        FROM tweets
        WHERE reply_text IS NOT NULL AND reply_text != '' AND replied = FALSE
        ORDER BY reply_score DESC
    """).fetchall()
    conn.close()

    if not rows:
        print("No pending drafts. Run: x_patrol.py scan")
        return

    print(f"=== {len(rows)} Pending Drafts ===\n")
    for i, r in enumerate(rows, 1):
        print(f"[{i}] @{r['author']} (relevance={r['relevance_score']:.1f}, quality={r['reply_score']:.1f})")
        print(f"    Tweet: {r['content'][:100]}...")
        print(f"    Draft: {r['reply_text']}")
        print(f"    URL:   {r['url']}")
        print(f"    ID:    {r['id']}")
        print()


def cmd_scored():
    """Show all scored tweets."""
    conn = get_db()
    rows = conn.execute("""
        SELECT id, url, author, content, relevance_score, replied,
               reply_text, reply_score, found_at
        FROM tweets
        ORDER BY relevance_score DESC
        LIMIT 30
    """).fetchall()
    conn.close()

    if not rows:
        print("No tweets in database. Run: x_patrol.py scan")
        return

    print(f"=== Top {len(rows)} Scored Tweets ===\n")
    print(f"{'Score':>5}  {'Author':>18}  {'Status':>8}  Tweet")
    print("-" * 80)
    for r in rows:
        status = 'REPLIED' if r['replied'] else ('DRAFT' if r['reply_text'] else 'NEW')
        print(f"{r['relevance_score']:5.1f}  @{r['author']:>17s}  {status:>8}  {r['content'][:45]}...")


def cmd_history(n=20):
    """Show recent interaction history."""
    conn = get_db()
    rows = conn.execute("""
        SELECT type, target_url, target_author, our_text, quality_score, timestamp
        FROM x_interactions
        ORDER BY timestamp DESC
        LIMIT ?
    """, (n,)).fetchall()
    conn.close()

    if not rows:
        print("No interaction history yet.")
        return

    print(f"=== Last {len(rows)} Interactions ===\n")
    for r in rows:
        ts = r['timestamp'][:16] if r['timestamp'] else '?'
        print(f"  [{ts}] {r['type']:>6}  @{r['target_author']}  q={r['quality_score']:.1f}")
        if r['our_text']:
            print(f"           {r['our_text'][:80]}")
        print()


def cmd_metrics():
    """Show today's metrics."""
    conn = get_db()
    today = datetime.now().strftime("%Y-%m-%d")

    row = conn.execute("SELECT * FROM x_metrics WHERE date = ?", (today,)).fetchone()

    # Count from actual data
    total_tweets = conn.execute("SELECT COUNT(*) as c FROM tweets").fetchone()['c']
    today_tweets = conn.execute(
        "SELECT COUNT(*) as c FROM tweets WHERE found_at >= ?",
        (today,)
    ).fetchone()['c']
    unreplied = conn.execute(
        "SELECT COUNT(*) as c FROM tweets WHERE replied = FALSE AND reply_text IS NOT NULL AND reply_text != ''"
    ).fetchone()['c']
    replied_today = conn.execute(
        "SELECT COUNT(*) as c FROM x_interactions WHERE type = 'reply' AND timestamp >= ?",
        (today,)
    ).fetchone()['c']
    all_replies = conn.execute(
        "SELECT COUNT(*) as c FROM x_interactions WHERE type = 'reply'"
    ).fetchone()['c']

    # Average quality
    avg_q = conn.execute(
        "SELECT AVG(quality_score) as avg FROM x_interactions WHERE type = 'reply' AND quality_score > 0"
    ).fetchone()['avg'] or 0

    conn.close()

    print(f"=== X Patrol Metrics ({today}) ===\n")
    print(f"  Total tweets tracked:  {total_tweets}")
    print(f"  Found today:           {today_tweets}")
    print(f"  Pending drafts:        {unreplied}")
    print(f"  Replies sent today:    {replied_today}")
    print(f"  Total replies sent:    {all_replies}")
    print(f"  Avg reply quality:     {avg_q:.1f}/10")

    if row:
        print(f"\n  Followers:             {row['followers']}")
        print(f"  Impressions:           {row['impressions']}")
        print(f"  Profile visits:        {row['profile_visits']}")


def cmd_mark_replied(tweet_id, reply_text):
    """Manually mark a tweet as replied."""
    conn = get_db()
    conn.execute(
        "UPDATE tweets SET replied = TRUE, reply_text = ? WHERE id = ?",
        (reply_text, tweet_id)
    )
    conn.execute(
        "INSERT INTO x_interactions (type, target_url, target_author, our_text, quality_score, timestamp) "
        "SELECT 'reply', url, author, ?, 7.0, ? FROM tweets WHERE id = ?",
        (reply_text, datetime.now(timezone.utc).isoformat(), tweet_id)
    )
    conn.commit()
    conn.close()
    print(f"  Marked {tweet_id} as replied.")


# ── Record interaction (used by x_shadow and x_cli) ──────────

def record_interaction(interaction_type: str, target_url: str,
                       target_author: str, our_text: str,
                       quality_score: float = 0.0):
    """Record an interaction in x_social.db."""
    conn = get_db()
    conn.execute(
        "INSERT INTO x_interactions (type, target_url, target_author, our_text, quality_score, timestamp) "
        "VALUES (?,?,?,?,?,?)",
        (interaction_type, target_url, target_author, our_text,
         quality_score, datetime.now(timezone.utc).isoformat())
    )
    # Update daily metrics
    today = datetime.now().strftime("%Y-%m-%d")
    conn.execute(
        "INSERT INTO x_metrics (date, replies_sent) VALUES (?, 1) "
        "ON CONFLICT(date) DO UPDATE SET replies_sent = replies_sent + 1",
        (today,)
    )
    conn.commit()
    conn.close()


def mark_tweet_replied(tweet_id: str, reply_text: str):
    """Mark a tweet as replied in the DB."""
    conn = get_db()
    conn.execute(
        "UPDATE tweets SET replied = TRUE, reply_text = ? WHERE id = ?",
        (reply_text, tweet_id)
    )
    conn.commit()
    conn.close()


# ── Entry point ──────────────────────────────────────────────

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"

    commands = {
        "scan": cmd_scan,
        "scan-accounts": cmd_scan_accounts,
        "scan-search": cmd_scan_search,
        "drafts": cmd_drafts,
        "scored": cmd_scored,
        "metrics": cmd_metrics,
    }

    if cmd == "history":
        n = int(sys.argv[2]) if len(sys.argv) > 2 else 20
        cmd_history(n)
    elif cmd == "mark-replied" and len(sys.argv) >= 4:
        cmd_mark_replied(sys.argv[2], " ".join(sys.argv[3:]))
    elif cmd in commands:
        commands[cmd]()
    else:
        print(__doc__)
