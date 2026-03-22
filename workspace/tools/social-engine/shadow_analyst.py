#!/usr/bin/env python3
"""
shadow_analyst.py — 影子情報分析引擎

讀 shadow_targets.yaml，掃描各目標，偵測變化，產出信號。

Usage:
  python3 shadow_analyst.py scan              # 掃描所有 semi 目標（Threads）
  python3 shadow_analyst.py check             # 檢查所有 auto 目標狀態
  python3 shadow_analyst.py signals           # 列出待處理信號
  python3 shadow_analyst.py report            # 完整影子情報報告
  python3 shadow_analyst.py target <handle>   # 查看特定目標歷史
"""

import sys
import json
import sqlite3
import yaml
import time
from pathlib import Path
from datetime import datetime, timezone, timedelta
from collections import defaultdict

BASE_DIR = Path(__file__).parent
TARGETS_FILE = BASE_DIR / "shadow_targets.yaml"
SOCIAL_DB = BASE_DIR / "social.db"
SIGNALS_DB = BASE_DIR / "shadow.db"

TW_TZ = timezone(timedelta(hours=8))


def _load_targets():
    """Load shadow targets from YAML."""
    if not TARGETS_FILE.exists():
        print("shadow_targets.yaml not found")
        return {}
    return yaml.safe_load(TARGETS_FILE.read_text()).get("targets", {})


def _get_db():
    """Get or create shadow observations database."""
    conn = sqlite3.connect(str(SIGNALS_DB), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        data_json TEXT,
        summary TEXT
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_id TEXT NOT NULL,
        signal_type TEXT NOT NULL,
        priority TEXT DEFAULT 'medium',
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed INTEGER DEFAULT 0,
        consumed_by TEXT
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_signals_consumed ON signals(consumed)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_obs_target ON observations(target_id, observed_at)")
    conn.commit()
    return conn


def _get_social_db():
    conn = sqlite3.connect(str(SOCIAL_DB), timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


# ── Scanners ──

def scan_threads_targets(targets):
    """Scan Threads-based targets during patrol or standalone."""
    semi_targets = {k: v for k, v in targets.items()
                    if v.get("automation") == "semi" and v.get("platform") == "threads"}

    if not semi_targets:
        return []

    # Get latest feed data
    feed_path = Path("/tmp/threads-feed-500.json")
    if not feed_path.exists():
        print("  No feed data. Run threads_patrol first.")
        return []

    feed = json.loads(feed_path.read_text())
    feed_by_author = defaultdict(list)
    for post in feed:
        feed_by_author[post.get("author", "")].append(post)

    db = _get_db()
    now = datetime.now(TW_TZ).isoformat()
    signals = []

    for tid, cfg in semi_targets.items():
        handle = cfg.get("handle", "")
        if handle.startswith("__"):
            continue  # skip filters for now

        posts = feed_by_author.get(handle, [])
        if not posts:
            continue

        # Get previous observation
        prev = db.execute(
            "SELECT data_json FROM observations WHERE target_id=? ORDER BY observed_at DESC LIMIT 1",
            (tid,)
        ).fetchone()

        prev_data = json.loads(prev["data_json"]) if prev else {}
        prev_post_count = prev_data.get("post_count", 0)
        prev_total_likes = prev_data.get("total_likes", 0)

        # Current observation
        current_data = {
            "post_count": len(posts),
            "total_likes": sum(p.get("likes", 0) for p in posts),
            "top_text": posts[0].get("text", "")[:150] if posts else "",
            "topics": _extract_topics(posts),
        }

        # Save observation
        db.execute(
            "INSERT INTO observations (target_id, observed_at, data_json, summary) VALUES (?,?,?,?)",
            (tid, now, json.dumps(current_data, ensure_ascii=False),
             f"{len(posts)} posts, {current_data['total_likes']} likes")
        )

        # Detect changes → signals
        watch_for = cfg.get("watch_for", [])
        category = cfg.get("category", "unknown")

        # New activity from target
        if len(posts) > 0 and prev_post_count == 0:
            sig = _create_signal(db, tid, "new_activity", _priority_for(category),
                                 f"@{handle} 出現在 feed（{len(posts)} 篇）| {current_data['top_text'][:60]}", now)
            signals.append(sig)

        # Spike in engagement
        if current_data["total_likes"] > prev_total_likes * 2 and prev_total_likes > 0:
            sig = _create_signal(db, tid, "engagement_spike", "high",
                                 f"@{handle} 互動暴漲 {prev_total_likes}→{current_data['total_likes']}", now)
            signals.append(sig)

        # Topic shift detection
        if prev_data.get("topics") and current_data["topics"]:
            old_topics = set(prev_data["topics"])
            new_topics = set(current_data["topics"]) - old_topics
            if new_topics:
                sig = _create_signal(db, tid, "topic_shift", "medium",
                                     f"@{handle} 新話題：{', '.join(new_topics)}", now)
                signals.append(sig)

    # Scan quiet zone (buddha's filter target)
    quiet = [p for p in feed if p.get("likes", 0) < 5 and len(p.get("text", "")) > 100]
    if quiet:
        db.execute(
            "INSERT INTO observations (target_id, observed_at, data_json, summary) VALUES (?,?,?,?)",
            ("quiet_zone", now, json.dumps({"count": len(quiet), "samples": [
                {"author": p["author"], "text": p["text"][:100]} for p in quiet[:5]
            ]}, ensure_ascii=False), f"{len(quiet)} quiet posts")
        )

    db.commit()
    db.close()
    return signals


def check_auto_targets(targets):
    """Check auto targets (RSS, API, internal)."""
    auto_targets = {k: v for k, v in targets.items()
                    if v.get("automation") == "auto"}

    db = _get_db()
    now = datetime.now(TW_TZ).isoformat()
    signals = []

    for tid, cfg in auto_targets.items():
        platform = cfg.get("platform", "")

        if platform == "internal" and cfg.get("handle") == "__system__":
            # System health check
            import subprocess
            services = {"9223": "Brave", "18789": "GW", "18796": "TG-D"}
            down = []
            for port, name in services.items():
                r = subprocess.run(["lsof", "-i", f":{port}"], capture_output=True, text=True)
                if not r.stdout.strip():
                    down.append(name)
            if down:
                sig = _create_signal(db, tid, "service_down", "critical",
                                     f"服務離線：{', '.join(down)}", now)
                signals.append(sig)

        elif platform == "internal" and cfg.get("handle") == "__internal__":
            # Cruz energy monitor
            social = _get_social_db()
            today = datetime.now(TW_TZ).strftime("%Y-%m-%d")
            posts_today = social.execute("""
                SELECT COUNT(*) FROM content_pipeline
                WHERE threads_status='posted' AND scheduled_at LIKE ?
            """, (f"{today}%",)).fetchone()[0]
            social.close()

            thresholds = cfg.get("thresholds", {})
            max_posts = thresholds.get("posts_per_day_max", 1)
            if posts_today > max_posts:
                sig = _create_signal(db, tid, "energy_warn", "high",
                                     f"Cruz 今天已發 {posts_today} 篇（上限 {max_posts}）", now)
                signals.append(sig)

        elif platform == "api" and cfg.get("handle") == "__health__":
            # Threads API health — check rate limit state
            pass  # TODO: implement when we have rate limit tracking

    db.commit()
    db.close()
    return signals


def _extract_topics(posts):
    """Simple keyword-based topic extraction."""
    topics = set()
    for p in posts:
        t = p.get("text", "")
        if any(w in t for w in ["AI", "Claude", "GPT", "LLM", "agent"]):
            topics.add("AI")
        if any(w in t for w in ["台灣", "政治", "國防", "選舉", "台海"]):
            topics.add("politics")
        if any(w in t for w in ["程式", "code", "bug", "API", "開發"]):
            topics.add("tech")
        if any(w in t for w in ["投資", "股", "經濟", "房", "薪"]):
            topics.add("finance")
    return list(topics)


def _priority_for(category):
    return {"opponent": "high", "critic": "high", "family": "high",
            "ally": "medium", "competitor": "medium",
            "source": "low", "field": "low", "infra": "medium",
            "self": "high"}.get(category, "medium")


def _create_signal(db, target_id, signal_type, priority, message, created_at):
    db.execute(
        "INSERT INTO signals (target_id, signal_type, priority, message, created_at) VALUES (?,?,?,?,?)",
        (target_id, signal_type, priority, message, created_at)
    )
    return {"target": target_id, "type": signal_type, "priority": priority, "message": message}


# ── Signal Router (米開朗基羅) ──

def get_pending_signals():
    """Get unconsumed signals, ordered by priority."""
    db = _get_db()
    priority_order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    rows = db.execute(
        "SELECT * FROM signals WHERE consumed=0 ORDER BY created_at DESC"
    ).fetchall()
    db.close()

    signals = [dict(r) for r in rows]
    signals.sort(key=lambda s: priority_order.get(s["priority"], 9))
    return signals


def consume_signal(signal_id, consumed_by="manual"):
    """Mark a signal as consumed."""
    db = _get_db()
    db.execute("UPDATE signals SET consumed=1, consumed_by=? WHERE id=?", (consumed_by, signal_id))
    db.commit()
    db.close()


def route_signals(signals):
    """Route signals to appropriate destinations."""
    routed = {"warroom": [], "forge_input": [], "archive": []}

    for sig in signals:
        p = sig.get("priority", "medium")
        if p in ("critical", "high"):
            routed["warroom"].append(sig)
        elif p == "medium":
            routed["forge_input"].append(sig)
        else:
            routed["archive"].append(sig)

    return routed


def format_warroom_report(signals):
    """Format signals for war room TG message."""
    if not signals:
        return ""

    lines = ["影子情報："]
    for sig in signals[:5]:
        icon = {"critical": "🔴", "high": "🟡", "medium": "🔵"}.get(sig["priority"], "⚪")
        lines.append(f"  {icon} {sig['message']}")

    return "\n".join(lines)


# ── Reports ──

def full_report(targets):
    """Generate complete shadow intelligence report."""
    db = _get_db()
    now = datetime.now(TW_TZ)

    print(f"影子情報報告 — {now.strftime('%Y-%m-%d %H:%M')}")
    print(f"{'='*50}")

    # Group by general
    by_general = defaultdict(list)
    for tid, cfg in targets.items():
        by_general[cfg.get("general", "unknown")].append((tid, cfg))

    general_names = {
        "buddha": "佛陀", "sadhguru": "薩古魯", "musk": "馬斯克",
        "tesla": "特斯拉", "einstein": "愛因斯坦", "sunzi": "孫子",
        "zhuge": "諸葛亮", "musashi": "宮本武藏"
    }

    for gen, items in sorted(by_general.items()):
        print(f"\n── {general_names.get(gen, gen)} ({len(items)} 目標) ──")
        for tid, cfg in items:
            handle = cfg.get("handle", tid)
            last_obs = db.execute(
                "SELECT summary, observed_at FROM observations WHERE target_id=? ORDER BY observed_at DESC LIMIT 1",
                (tid,)
            ).fetchone()

            recent_signals = db.execute(
                "SELECT message, priority FROM signals WHERE target_id=? AND consumed=0 ORDER BY created_at DESC LIMIT 2",
                (tid,)
            ).fetchall()

            status = "📡" if last_obs else "⏸️"
            obs_text = f"最近：{last_obs['summary']}" if last_obs else "尚未觀測"
            print(f"  {status} {handle} [{cfg.get('category','')}] — {obs_text}")

            for sig in recent_signals:
                icon = {"critical": "🔴", "high": "🟡"}.get(sig["priority"], "")
                if icon:
                    print(f"     {icon} {sig['message'][:60]}")

    # Pending signals summary
    pending = get_pending_signals()
    if pending:
        print(f"\n── 待處理信號：{len(pending)} ──")
        for sig in pending[:10]:
            print(f"  [{sig['priority']}] {sig['message'][:70]}")

    db.close()


# ── CLI ──

if __name__ == "__main__":
    targets = _load_targets()

    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(0)

    cmd = sys.argv[1]

    if cmd == "scan":
        print("掃描 Threads 影子目標...")
        signals = scan_threads_targets(targets)
        print(f"產出 {len(signals)} 個信號")
        for s in signals:
            print(f"  [{s['priority']}] {s['message']}")

    elif cmd == "check":
        print("檢查自動目標...")
        signals = check_auto_targets(targets)
        print(f"產出 {len(signals)} 個信號")
        for s in signals:
            print(f"  [{s['priority']}] {s['message']}")

    elif cmd == "signals":
        pending = get_pending_signals()
        if not pending:
            print("無待處理信號")
        else:
            print(f"待處理信號：{len(pending)}")
            for s in pending:
                print(f"  [{s['priority']}] @{s['target_id']}: {s['message']}")

    elif cmd == "report":
        full_report(targets)

    elif cmd == "target" and len(sys.argv) >= 3:
        handle = sys.argv[2]
        db = _get_db()
        obs = db.execute(
            "SELECT * FROM observations WHERE target_id=? ORDER BY observed_at DESC LIMIT 5",
            (handle,)
        ).fetchall()
        sigs = db.execute(
            "SELECT * FROM signals WHERE target_id=? ORDER BY created_at DESC LIMIT 5",
            (handle,)
        ).fetchall()
        print(f"目標：{handle}")
        print(f"觀測記錄：{len(obs)}")
        for o in obs:
            print(f"  {o['observed_at'][:16]}: {o['summary']}")
        print(f"信號：{len(sigs)}")
        for s in sigs:
            print(f"  [{s['priority']}] {s['message'][:60]}")
        db.close()

    elif cmd == "route":
        pending = get_pending_signals()
        routed = route_signals(pending)
        print(f"路由結果：")
        print(f"  戰情室：{len(routed['warroom'])}")
        print(f"  Forge 素材：{len(routed['forge_input'])}")
        print(f"  歸檔：{len(routed['archive'])}")
        if routed["warroom"]:
            print(f"\n{format_warroom_report(routed['warroom'])}")

    else:
        print(__doc__)
