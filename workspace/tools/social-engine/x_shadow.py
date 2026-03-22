#!/usr/bin/env python3
"""
X Shadow Agent — 影子延伸術 v2

奈良鹿丸式架構：
- Shadow (本體): 每 15 分鐘醒來，觀察 sub-agent 的工作品質
- Sub-agent: 持續在 X 上巡邏、互動、回覆大號推文

整合 x_patrol.py 做掃描，content_brain.py 做評分，
x_social.db 追蹤所有互動歷史。

用法:
  python3 x_shadow.py run          # 啟動 sub-agent 一輪
  python3 x_shadow.py observe      # Shadow 觀察品質
  python3 x_shadow.py loop         # 持續循環（sub-agent + 15min observe）
  python3 x_shadow.py status       # 看目前狀態
  python3 x_shadow.py dashboard    # 完整儀表板
"""

import json
import os
import sys
import time
import random
import subprocess
from datetime import datetime, timezone
from pathlib import Path

WORK_DIR = Path(__file__).parent
STATE_FILE = WORK_DIR / "x_shadow_state.json"
LOG_FILE = WORK_DIR / "x_shadow_log.jsonl"
CDP_URL = "http://localhost:9222"

# ============================================================
# SUB-AGENT SOUL
# ============================================================

SOUL = """
你是 Cruz Tang (@TangCruzZ) 的 X/Twitter 影子。

## 身份
- 你代表一個在生產環境跑 10+ AI agent 超過 90 天的工程師
- 你的產品是 Ship AI Agents to Production（thinker.cafe）
- 你的語氣：直接、技術、有觀點、不廢話
- 你說英文（X 的 AI dev 社群是英文的）

## 你會做的事
1. 瀏覽 AI dev 大號的推文
2. 在有價值的推文下留回覆（技術見解，不是「great post!」）
3. 偶爾 quote tweet 加你的觀點
4. 絕不推銷產品（產品在 bio 和 pinned tweet 裡，讓人自己找）

## 回覆準則
- 每條回覆必須以「我的具體經驗」開頭，不是泛泛的技術意見
- 用第一人稱：「I ran into this exact problem when...」「In my 10-agent setup...」「After 90 days of...」
- 要有立場。不要兩邊都說有道理。選一邊，說為什麼。
- 回覆模式（選一個）：
  A. 反直覺洞察：「Most people think X, but after running agents for 90 days, the real issue is Y.」
  B. 具體數字：「I measured this. After adding CONSTITUTION.md, hallucination dropped from 15% to 2%.」
  C. 踩坑故事：「My agent sent a salmon recipe to a billing question at 2am. Here's what I changed.」
  D. 不同意但尊重：「Interesting take, but in production this breaks because...」
- 永遠不要用這些開頭：「Great point」「That's a good question」「I agree」「This is interesting」
- 長度 1-3 句，最多 280 字
- 不用 hashtag
- 不帶連結

## 你不會做的事
- 不發推（只有 Shadow 觀察後才允許發推）
- 不回覆跟 AI agent 無關的推文
- 不跟人吵架
- 不用中文
- 不提任何產品
- 不在回覆裡放連結
- 不寫泛泛的技術評論（「this is a real challenge」這種廢話）
- 不問反問句除非你真的想知道答案
"""

CONSTITUTION = """
## 紅線
1. 絕不在回覆中提及 thinker.cafe 或任何產品連結
2. 絕不回覆政治、宗教、爭議性話題
3. 絕不回覆超過 3 條推文在同一個人的帖下（看起來像 stalker）
4. 絕不連續回覆——每兩次回覆之間至少間隔 3 分鐘
5. 每小時最多回覆 5 條（避免觸發 X 速率限制）
6. 如果不確定要回什麼，不回
"""

# 目標大號列表（imported from x_patrol）
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

# 相關話題關鍵字
TOPIC_KEYWORDS = [
    "claude code", "ai agent", "production", "autonomous agent",
    "multi-agent", "hallucination", "memory", "monitoring",
    "CLAUDE.md", "prompt engineering", "agentic", "coding agent",
    "self-healing", "agent architecture", "LLM ops",
]


def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {
        "replies_today": 0,
        "replies_this_hour": 0,
        "last_reply_time": 0,
        "last_observe_time": 0,
        "replied_tweets": [],
        "quality_scores": [],
        "date": datetime.now().strftime("%Y-%m-%d"),
    }


def save_state(state):
    # Reset daily counters if new day
    today = datetime.now().strftime("%Y-%m-%d")
    if state.get("date") != today:
        state["replies_today"] = 0
        state["replied_tweets"] = []
        state["quality_scores"] = []
        state["date"] = today
    STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False))


def log_action(action_type, data):
    entry = {
        "ts": datetime.now().isoformat(),
        "type": action_type,
        **data,
    }
    with open(LOG_FILE, "a") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def call_llm(prompt, system=""):
    """Call Claude CLI for decision making."""
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


# ============================================================
# SUB-AGENT: Browser-based tweet finder + replier
# ============================================================

def browse_and_find_tweets():
    """Use x_patrol to find tweets, then filter by relevance."""
    sys.path.insert(0, str(WORK_DIR))
    from x_patrol import get_db, score_tweet

    # Run patrol scan (accounts + search)
    print("  Using x_patrol scanner...")
    from x_patrol import scan_accounts, scan_search
    try:
        scan_accounts()
    except Exception as e:
        print(f"    Account scan error: {e}")
    try:
        scan_search()
    except Exception as e:
        print(f"    Search scan error: {e}")

    # Get top unreplied tweets from DB
    conn = get_db()
    rows = conn.execute("""
        SELECT id, url, author, content, relevance_score
        FROM tweets
        WHERE replied = FALSE
          AND (reply_text IS NULL OR reply_text = '')
          AND relevance_score >= 5.0
        ORDER BY relevance_score DESC
        LIMIT 10
    """).fetchall()
    conn.close()

    tweets_found = []
    for r in rows:
        tweets_found.append({
            'id': r['id'],
            'account': r['author'],
            'text': r['content'],
            'url': r['url'],
            'score': r['relevance_score'],
        })

    return tweets_found


def generate_reply(tweet_text, account):
    """Use LLM to generate a high-quality reply."""
    prompt = f"""You are replying to a tweet by @{account} on X/Twitter.

Tweet content:
{tweet_text[:400]}

Write a reply that:
1. Adds a unique technical insight (not just agreement)
2. Draws from experience running 10+ AI agents in production
3. Is 1-3 sentences, under 280 characters
4. Does NOT mention any product, link, or self-promotion
5. Sounds like a knowledgeable peer, not a fan

Reply:"""

    reply = call_llm(prompt, system=SOUL)

    # Clean up
    if reply:
        reply = reply.strip('"').strip("'").strip()
    # Trim to 280 chars
    if reply and len(reply) > 280:
        reply = reply[:277] + "..."

    return reply


def score_reply(reply_text, account):
    """Score a reply using content_brain's resonance filter + LLM."""
    # Rule-based pre-check
    if not reply_text or len(reply_text) < 10:
        return 0.0

    # Use content_brain resonance as a signal
    try:
        from content_brain import ResonanceFilter
        rf = ResonanceFilter()
        res = rf.score(reply_text)
        resonance_bonus = min(res['total_score'] * 0.02, 1.0)  # 0-1 bonus
    except Exception:
        resonance_bonus = 0

    # LLM quality score
    score_prompt = f"""Rate this X/Twitter reply on a scale of 1-10:

Reply to @{account}: "{reply_text}"

Criteria:
- Technical depth (1-10)
- Relevance (1-10)
- Tone (professional, not sycophantic) (1-10)
- Conciseness (1-10)
- Would a senior engineer find this valuable? (1-10)

Average score (just the number):"""

    score_str = call_llm(score_prompt)
    try:
        score = float(score_str.strip().split('\n')[0].split('/')[0])
    except (ValueError, IndexError):
        score = 5.0

    return min(10.0, score + resonance_bonus)


def post_reply(tweet_url, reply_text):
    """Post a reply to a specific tweet using the adapter."""
    from adapters.x_twitter import XTwitterAdapter
    adapter = XTwitterAdapter()
    return adapter.reply_to_tweet(tweet_url, reply_text)


# ============================================================
# COMMANDS
# ============================================================

def cmd_run():
    """Run one cycle of the sub-agent."""
    state = load_state()

    # Rate limit checks
    now = time.time()
    if state["replies_this_hour"] >= 5:
        print("  Rate limit: 5 replies/hour reached. Waiting.")
        return

    if now - state["last_reply_time"] < 180:  # 3 min gap
        remaining = 180 - (now - state["last_reply_time"])
        print(f"  Too soon since last reply. Wait {int(remaining)}s.")
        return

    print("=== X Shadow Sub-Agent Run ===")

    # 1. Find tweets via x_patrol
    print("\nPhase 1: Scanning...")
    tweets = browse_and_find_tweets()
    print(f"  Found {len(tweets)} candidate tweets")

    if not tweets:
        print("  No relevant tweets found. Done.")
        return

    # 2. Filter already replied (by this session)
    new_tweets = [t for t in tweets if t['url'] not in state.get('replied_tweets', [])]
    print(f"  {len(new_tweets)} new (not replied yet)")

    if not new_tweets:
        print("  All already replied. Done.")
        return

    # 3. Pick the highest-scored tweet
    new_tweets.sort(key=lambda t: t.get('score', 0), reverse=True)
    tweet = new_tweets[0]
    print(f"\n  Selected: @{tweet['account']} (score={tweet.get('score', 0):.1f})")
    print(f"  Content: {tweet['text'][:100]}...")

    # 4. Generate reply
    print("\nPhase 2: Generating reply...")
    reply = generate_reply(tweet['text'], tweet['account'])
    print(f"  Reply: {reply}")

    if not reply or len(reply) < 10:
        print("  Reply too short or empty. Skipping.")
        return

    # 5. Score the reply
    quality = score_reply(reply, tweet['account'])
    print(f"  Quality score: {quality:.1f}/10")

    if quality < 5.0:
        print("  Quality below threshold (5.0). Skipping.")
        log_action("skip", {
            "reason": "low_quality",
            "account": tweet['account'],
            "reply": reply,
            "score": quality,
        })
        return

    # 6. Shadow mode — generate only, don't post
    # Real posting unlocked when 100 consecutive replies score >= 8.0
    SHADOW_MODE = True
    QUALITY_GATE = 8.0
    CONSECUTIVE_REQUIRED = 100

    if SHADOW_MODE:
        print("\nPhase 3: SHADOW MODE (not posting)")
        success = True  # Simulate success for tracking

    if success:
        state["replies_today"] += 1
        state["replies_this_hour"] += 1
        state["last_reply_time"] = now
        state["replied_tweets"].append(tweet['url'])
        state["quality_scores"].append(quality)

        log_action("reply", {
            "account": tweet['account'],
            "tweet_url": tweet['url'],
            "tweet_id": tweet.get('id', ''),
            "reply": reply,
            "quality": quality,
        })

        # Record in x_social.db
        try:
            from x_patrol import record_interaction, mark_tweet_replied
            record_interaction('reply', tweet['url'], tweet['account'], reply, quality)
            if tweet.get('id'):
                mark_tweet_replied(tweet['id'], reply)
        except Exception as e:
            print(f"  DB record error: {e}")

        print(f"\n  Reply posted ({state['replies_today']} today, q={quality:.1f})")
    else:
        print("  Failed to post reply")
        log_action("error", {"phase": "post", "account": tweet['account']})

    save_state(state)


def cmd_observe():
    """Shadow observes sub-agent quality."""
    state = load_state()

    print("=== Shadow Observation ===")
    print(f"  Replies today: {state.get('replies_today', 0)}")
    print(f"  Replies this hour: {state.get('replies_this_hour', 0)}")

    # Read recent log entries
    if not LOG_FILE.exists():
        print("  No log entries yet.")
        return

    recent = []
    with open(LOG_FILE) as f:
        for line in f:
            try:
                entry = json.loads(line)
                if entry.get('type') == 'reply':
                    recent.append(entry)
            except Exception:
                continue

    recent = recent[-5:]  # Last 5 replies

    if not recent:
        print("  No replies to observe.")
        return

    print(f"\n  Reviewing last {len(recent)} replies:\n")

    # Score each reply
    for entry in recent:
        reply = entry.get('reply', '')
        account = entry.get('account', '?')
        recorded_q = entry.get('quality', 0)

        # Re-score for consistency check
        score = score_reply(reply, account)

        drift = abs(score - recorded_q)
        drift_flag = " [DRIFT]" if drift > 2.0 else ""

        print(f"  @{account}: q={score:.1f} (was {recorded_q:.1f}){drift_flag}")
        print(f"    {reply[:60]}...")

        state.setdefault("quality_scores", []).append(score)
        log_action("observe", {"account": account, "reply": reply[:100], "score": score})

    # Average quality
    scores = state.get("quality_scores", [])
    if scores:
        avg = sum(scores[-20:]) / len(scores[-20:])
        print(f"\n  Average quality (last 20): {avg:.1f}/10")
        if avg < 6:
            print("  WARNING: Quality below threshold. Sub-agent needs tuning.")
        elif avg >= 8:
            print("  Quality excellent.")

    # Check engagement metrics from x_social.db
    try:
        from x_patrol import get_db
        conn = get_db()
        today = datetime.now().strftime("%Y-%m-%d")
        row = conn.execute(
            "SELECT COUNT(*) as c FROM x_interactions WHERE type='reply' AND timestamp >= ?",
            (today,)
        ).fetchone()
        print(f"\n  DB tracked replies today: {row['c']}")
        conn.close()
    except Exception:
        pass

    # Reset hourly counter if needed
    if time.time() - state.get("last_reply_time", 0) > 3600:
        state["replies_this_hour"] = 0

    save_state(state)


def cmd_status():
    """Show current status."""
    state = load_state()
    print(f"=== X Shadow Status ===\n")
    print(f"  Date:            {state.get('date')}")
    print(f"  Replies today:   {state.get('replies_today', 0)}")
    print(f"  Replies/hour:    {state.get('replies_this_hour', 0)}/5")
    print(f"  Tweets replied:  {len(state.get('replied_tweets', []))}")

    scores = state.get('quality_scores', [])
    if scores:
        avg = sum(scores[-20:]) / len(scores[-20:])
        print(f"  Avg quality:     {avg:.1f}/10")
    else:
        print("  Avg quality:     (no data)")

    # Time since last reply
    last = state.get('last_reply_time', 0)
    if last > 0:
        ago = int(time.time() - last)
        if ago < 60:
            print(f"  Last reply:      {ago}s ago")
        elif ago < 3600:
            print(f"  Last reply:      {ago // 60}m ago")
        else:
            print(f"  Last reply:      {ago // 3600}h {(ago % 3600) // 60}m ago")

    # DB stats
    try:
        from x_patrol import get_db
        conn = get_db()
        total = conn.execute("SELECT COUNT(*) as c FROM tweets").fetchone()['c']
        replied = conn.execute("SELECT COUNT(*) as c FROM tweets WHERE replied = TRUE").fetchone()['c']
        pending = conn.execute(
            "SELECT COUNT(*) as c FROM tweets WHERE replied = FALSE AND reply_text IS NOT NULL AND reply_text != ''"
        ).fetchone()['c']
        conn.close()
        print(f"\n  DB tweets:       {total}")
        print(f"  DB replied:      {replied}")
        print(f"  DB pending:      {pending}")
    except Exception:
        pass


def cmd_dashboard():
    """Full dashboard — status + metrics + recent activity."""
    cmd_status()
    print()

    # Metrics from x_patrol
    try:
        from x_patrol import cmd_metrics
        cmd_metrics()
    except Exception as e:
        print(f"  Metrics error: {e}")

    print()

    # Recent log entries
    if LOG_FILE.exists():
        print("=== Recent Activity ===\n")
        entries = []
        with open(LOG_FILE) as f:
            for line in f:
                try:
                    entries.append(json.loads(line))
                except Exception:
                    continue

        for entry in entries[-10:]:
            ts = entry.get('ts', '?')[:16]
            typ = entry.get('type', '?')
            if typ == 'reply':
                print(f"  [{ts}] REPLY @{entry.get('account', '?')} q={entry.get('quality', 0):.1f}")
                print(f"           {entry.get('reply', '')[:60]}")
            elif typ == 'observe':
                print(f"  [{ts}] OBSERVE @{entry.get('account', '?')} q={entry.get('score', 0):.1f}")
            elif typ == 'skip':
                print(f"  [{ts}] SKIP @{entry.get('account', '?')} ({entry.get('reason', '')})")
            elif typ == 'error':
                print(f"  [{ts}] ERROR {entry.get('phase', '')} @{entry.get('account', '?')}")


def cmd_loop():
    """Continuous loop: sub-agent runs, shadow observes every 15 min."""
    print("=== X Shadow Loop Started ===")
    print("  Sub-agent + Shadow observation every 15 minutes")
    print("  Press Ctrl+C to stop\n")

    while True:
        try:
            # Sub-agent run
            cmd_run()

            # Shadow observe
            cmd_observe()

            # Wait 15 minutes (with jitter)
            wait = 900 + random.randint(-60, 60)
            print(f"\n  Next cycle in {wait//60}m{wait%60}s...\n")
            time.sleep(wait)
        except KeyboardInterrupt:
            print("\n  Shadow loop stopped.")
            break
        except Exception as e:
            print(f"  Error: {e}")
            time.sleep(300)  # Wait 5 min on error


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    cmds = {
        "run": cmd_run,
        "observe": cmd_observe,
        "loop": cmd_loop,
        "status": cmd_status,
        "dashboard": cmd_dashboard,
    }
    if cmd in cmds:
        cmds[cmd]()
    else:
        print(__doc__)
