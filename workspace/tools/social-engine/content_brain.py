#!/usr/bin/env python3
"""
content_brain.py — 自媒體內容大腦

純規則引擎，不燒 AI API。讀 social.db + threads.db，
判斷內容共振、評分、排程、回饋迴圈。

Usage:
    python3 content_brain.py heartbeat
    python3 content_brain.py suggest
    python3 content_brain.py brief
    python3 content_brain.py score "some text to evaluate"
    python3 content_brain.py resonance "some text to check"
    python3 content_brain.py rank
"""

import os
import sys
import re
import json
import sqlite3
import math
from datetime import datetime, timezone, timedelta
from pathlib import Path
from collections import defaultdict

# ── Paths ──────────────────────────────────────────────────────

BASE_DIR = Path(__file__).parent
SOCIAL_DB = BASE_DIR / "social.db"
THREADS_DB = BASE_DIR.parent / "threads-reply" / "threads.db"
THREADS_REPLY_DIR = BASE_DIR.parent / "threads-reply"
CONFIG_PATH = THREADS_REPLY_DIR / "config.json"

# Load threads config
THREADS_CONFIG = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
USER_ID = os.environ.get("THREADS_USER_ID", THREADS_CONFIG.get("user_id", ""))
MY_USERNAME = THREADS_CONFIG.get("username", "tangcruzz")

# ── Timezone ───────────────────────────────────────────────────

TW_TZ = timezone(timedelta(hours=8))

# ── Category weights — DATA-DRIVEN (2026-03-20 feedback loop) ──
# Source: 698 posts with real engagement data from threads.db
# geopolitics dominates (avg engagement 544), ai strong second (65)
# These weights auto-update via FeedbackLoop.update_scores()

CATEGORY_WEIGHTS = {
    "geopolitics":  1.0,    # avg 544 — 台海/國防/國際 ← 最強
    "ai":           0.5,    # avg 65 — AI/自動化/開源
    "local":        0.15,   # avg 18 — 苗栗/在地/LINE
    "resilience":   0.15,   # (merged with geopolitics in data)
    "other":        0.1,    # avg 11
    "thought":      0.08,   # avg 5 — 純思考文互動低
    "personal":     0.02,   # avg 0 — 個人生活無互動
}

# Min text length for crosspost consideration
MIN_TEXT_LENGTH = 30

# Optimal posting hours (TW time, 0-23) with weight
# Derived from typical Threads engagement patterns in TW market
OPTIMAL_HOURS = {
    7: 0.7,  8: 0.85, 9: 0.8,
    12: 0.9, 13: 0.85,
    18: 0.7, 19: 0.8, 20: 0.95, 21: 1.0, 22: 0.9, 23: 0.7,
}

# ── Cruz Resonance Frequencies ─────────────────────────────────
# Extracted from cruz-war-doctrine.md
# Each frequency: (name, keyword_set, weight)

FREQUENCIES = [
    (
        "taiwan_defense",
        {"台海", "國防", "韌性", "LNG", "飛彈", "圍台", "斷油", "備戰",
         "戰爭", "台灣", "防禦", "國土", "砲彈", "不對稱", "封鎖",
         "taiwan", "defense", "resilience", "blockade", "missile"},
        1.0,
    ),
    (
        "ai_automation",
        {"AI", "ai", "自動化", "開源", "Claude", "GPT", "LLM", "agent",
         "prompt", "模型", "機器學習", "OpenClaw", "Docker", "GitHub",
         "automation", "open source", "neural", "AGI", "演化"},
        0.95,
    ),
    (
        "asymmetric_warfare",
        {"不對稱", "成本比", "代理人", "無人機", "消耗戰", "帳單",
         "胡塞", "1:427", "proxy", "drone", "cost ratio", "attrition",
         "帝國", "國債", "利息", "印鈔", "去美元", "黃金", "SWIFT"},
        0.9,
    ),
    (
        "memory_evolution",
        {"記憶", "進化", "系統思考", "念", "無極", "知識",
         "遺忘", "迴響", "鏡", "化", "川", "衛",
         "memory", "evolution", "system thinking", "knowledge graph"},
        0.85,
    ),
    (
        "miaoli_local",
        {"苗栗", "在地", "LINE", "好朋友", "社區", "鄉下", "據點",
         "大湖", "miaoli", "local", "community", "LINE OA"},
        0.8,
    ),
    (
        "invisible_army",
        {"博弈", "隱形軍團", "USDT", "遠端", "傭兵", "套利",
         "數據分析", "徒弟", "BG666", "gambling", "crypto",
         "時間密度", "挖礦"},
        0.7,
    ),
]


# ── DB Helpers ─────────────────────────────────────────────────

def _get_social_conn():
    """Connect to social.db (read/write)."""
    conn = sqlite3.connect(str(SOCIAL_DB), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=10000")
    return conn


def _get_threads_conn():
    """Connect to threads.db (read-only)."""
    if not THREADS_DB.exists():
        return None
    conn = sqlite3.connect(str(THREADS_DB), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=10000")
    return conn


# ══════════════════════════════════════════════════════════════
# 1. ResonanceFilter
# ══════════════════════════════════════════════════════════════

class ResonanceFilter:
    """Judge whether a piece of text resonates with Cruz's core frequencies."""

    def __init__(self, frequencies=None):
        self.frequencies = frequencies or FREQUENCIES

    def score(self, text: str) -> dict:
        """
        Return {
            total_score: 0-100,
            top_frequencies: [(name, hit_count, weighted_score), ...],
            should_engage: bool
        }
        """
        if not text:
            return {"total_score": 0, "top_frequencies": [], "should_engage": False}

        text_lower = text.lower()
        freq_scores = []
        max_possible = sum(w for _, _, w in self.frequencies)

        for name, keywords, weight in self.frequencies:
            hits = 0
            for kw in keywords:
                # Case-insensitive match for ASCII, exact match for CJK
                if kw.isascii():
                    if kw.lower() in text_lower:
                        hits += 1
                else:
                    if kw in text:
                        hits += 1
            if hits > 0:
                # Diminishing returns: sqrt scale so 4 hits != 4x score
                hit_factor = math.sqrt(hits) / math.sqrt(len(keywords))
                weighted = hit_factor * weight
                freq_scores.append((name, hits, weighted))

        # Normalize to 0-100
        raw_sum = sum(ws for _, _, ws in freq_scores)
        total_score = min(100, int((raw_sum / max_possible) * 100 * 3))  # 3x amplifier

        # Sort by weighted score desc
        freq_scores.sort(key=lambda x: -x[2])
        top = freq_scores[:3]

        return {
            "total_score": total_score,
            "top_frequencies": [(n, h, round(w, 3)) for n, h, w in top],
            "should_engage": total_score >= 25,
        }


# ══════════════════════════════════════════════════════════════
# 1.5 ResonanceAmplifier — 共振增強器
# ══════════════════════════════════════════════════════════════

# Bridge phrases: when a frequency is missing, inject these to connect the content
# to Cruz's core frequencies without changing the original message
FREQUENCY_BRIDGES = {
    "taiwan_defense": [
        "\n\n這對台灣意味著什麼？",
        "\n\n在台海局勢越來越緊的現在，這不是選修，是必修。",
        "\n\n台灣 2300 萬人都該知道這件事。",
    ],
    "ai_automation": [
        "\n\nAI 已經在做這件事了。你呢？",
        "\n\n這就是自動化真正的意義——不是取代你，是讓你的時間密度翻倍。",
    ],
    "asymmetric_warfare": [
        "\n\n成本比才是關鍵。你花一塊，對方花四百二十七塊擋你。",
        "\n\n不對稱戰爭的邏輯：不需要打贏，只需要讓對方帳單比收入高。",
    ],
    "memory_evolution": [
        "\n\n記憶不是日誌，是活的器官。它的內容、結構、使用方式全都可以演化。",
        "\n\n差距不在智商，在於你有沒有把痛苦變成資產的系統。",
    ],
    "miaoli_local": [
        "\n\n從苗栗開始，一個鄉鎮一個鄉鎮接起來。",
    ],
    "invisible_army": [
        "\n\n時間密度不一樣的人，看起來像超人。其實只是系統在跑。",
    ],
}


class ResonanceAmplifier:
    """Take content with low resonance and boost it by injecting missing frequencies."""

    def __init__(self):
        self.filter = ResonanceFilter()

    def amplify(self, text: str, target_score: int = 65) -> dict:
        """
        Boost text resonance toward target_score.
        Returns {
            original_score, amplified_score,
            original_text, amplified_text,
            injected_frequencies, bridges_added
        }
        """
        original = self.filter.score(text)
        if original["total_score"] >= target_score:
            return {
                "original_score": original["total_score"],
                "amplified_score": original["total_score"],
                "original_text": text,
                "amplified_text": text,
                "injected_frequencies": [],
                "bridges_added": 0,
            }

        # Find which frequencies are missing or weak
        hit_freqs = {f[0] for f in original["top_frequencies"]}
        missing = []
        for name, _, weight in FREQUENCIES:
            if name not in hit_freqs and weight >= 0.8:  # Only inject high-weight freqs
                missing.append(name)

        # Inject bridges for top 2 missing frequencies
        amplified_text = text
        injected = []
        import random
        for freq_name in missing[:2]:
            bridges = FREQUENCY_BRIDGES.get(freq_name, [])
            if bridges:
                bridge = random.choice(bridges)
                amplified_text += bridge
                injected.append(freq_name)

        new_score = self.filter.score(amplified_text)

        return {
            "original_score": original["total_score"],
            "amplified_score": new_score["total_score"],
            "original_text": text,
            "amplified_text": amplified_text,
            "injected_frequencies": injected,
            "bridges_added": len(injected),
        }


# ══════════════════════════════════════════════════════════════
# 2. ContentScorer
# ══════════════════════════════════════════════════════════════

class ContentScorer:
    """Score content for crosspost priority."""

    def __init__(self):
        self.resonance = ResonanceFilter()

    def score(self, text: str, category: str = "other", reply_count: int = 0) -> float:
        """Return 0-100 score for crosspost priority."""
        if not text:
            return 0.0

        score = 0.0

        # 1. Length factor (0-15 pts): too short = bad, sweet spot ~100-500 chars
        length = len(text)
        if length < MIN_TEXT_LENGTH:
            return 0.0  # Below threshold, skip entirely
        elif length < 80:
            score += 5
        elif length < 200:
            score += 10
        elif length < 500:
            score += 15
        elif length < 1000:
            score += 12
        else:
            score += 8  # Very long posts lose some points

        # 2. Category weight (0-25 pts)
        cat_weight = CATEGORY_WEIGHTS.get(category, CATEGORY_WEIGHTS["other"])
        score += cat_weight * 25

        # 3. Resonance score (0-30 pts)
        res = self.resonance.score(text)
        score += res["total_score"] * 0.3

        # 4. Evergreen check (0-15 pts): penalize time-sensitive content
        time_markers = ["今天", "剛剛", "昨天", "明天", "等等", "現在直播",
                        "today", "just now", "right now", "breaking"]
        has_time_ref = any(m in text.lower() if m.isascii() else m in text
                          for m in time_markers)
        if has_time_ref:
            score += 3  # Time-sensitive: low evergreen
        else:
            score += 15  # Evergreen content bonus

        # 5. Reply/engagement bonus (0-15 pts)
        if reply_count >= 10:
            score += 15
        elif reply_count >= 5:
            score += 10
        elif reply_count >= 1:
            score += 5

        return min(100.0, round(score, 1))

    def rank_pipeline(self, conn=None) -> list:
        """Read content_pipeline from social.db, return sorted by score."""
        own_conn = False
        if conn is None:
            conn = _get_social_conn()
            own_conn = True

        try:
            rows = conn.execute("""
                SELECT id, source_platform, source_text, category, score,
                       threads_status, fb_page_status, fb_group_status,
                       linkedin_status, created_at
                FROM content_pipeline
                ORDER BY created_at DESC
            """).fetchall()
        except Exception as e:
            print(f"  Error reading content_pipeline: {e}")
            if own_conn:
                conn.close()
            return []

        results = []
        for row in rows:
            text = row["source_text"] or ""
            category = row["category"] or "other"
            new_score = self.score(text, category)
            results.append({
                "id": row["id"],
                "source_platform": row["source_platform"],
                "text_preview": text[:80],
                "category": category,
                "old_score": row["score"] or 0,
                "new_score": new_score,
                "threads_status": row["threads_status"],
                "fb_status": row["fb_page_status"],
                "created_at": row["created_at"],
            })

        results.sort(key=lambda x: -x["new_score"])

        if own_conn:
            conn.close()
        return results


# ══════════════════════════════════════════════════════════════
# 3. PostScheduler
# ══════════════════════════════════════════════════════════════

class PostScheduler:
    """Decide optimal posting times based on historical engagement data."""

    def __init__(self):
        self._hour_engagement = None

    def _analyze_history(self):
        """Build hour->engagement map from threads.db posts."""
        conn = _get_threads_conn()
        if not conn:
            self._hour_engagement = dict(OPTIMAL_HOURS)
            return

        try:
            rows = conn.execute("""
                SELECT posted_at, like_count, reply_count, repost_count
                FROM posts
                WHERE user_id = ? AND posted_at IS NOT NULL
            """, (USER_ID,)).fetchall()
        except Exception:
            rows = []
        finally:
            conn.close()

        if len(rows) < 5:
            # Not enough data, use defaults
            self._hour_engagement = dict(OPTIMAL_HOURS)
            return

        hour_stats = defaultdict(lambda: {"total_engagement": 0, "count": 0})
        for row in rows:
            try:
                ts = row["posted_at"]
                if not ts:
                    continue
                # Parse ISO format
                dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                tw_hour = (dt.hour + 8) % 24  # UTC to TW
                engagement = (row["like_count"] or 0) + (row["reply_count"] or 0) * 2 + (row["repost_count"] or 0) * 3
                hour_stats[tw_hour]["total_engagement"] += engagement
                hour_stats[tw_hour]["count"] += 1
            except (ValueError, TypeError):
                continue

        if not hour_stats:
            self._hour_engagement = dict(OPTIMAL_HOURS)
            return

        # Normalize: avg engagement per hour, then scale 0-1
        hour_avg = {}
        for h, s in hour_stats.items():
            hour_avg[h] = s["total_engagement"] / s["count"] if s["count"] > 0 else 0

        max_avg = max(hour_avg.values()) if hour_avg else 1
        if max_avg == 0:
            max_avg = 1

        # Blend: 60% historical data + 40% default weights
        blended = {}
        for h in range(24):
            hist_weight = hour_avg.get(h, 0) / max_avg
            default_weight = OPTIMAL_HOURS.get(h, 0.2)
            blended[h] = hist_weight * 0.6 + default_weight * 0.4

        self._hour_engagement = blended

    def optimal_time(self) -> datetime:
        """Based on historical data, when should the next post go out?"""
        if self._hour_engagement is None:
            self._analyze_history()

        now_tw = datetime.now(TW_TZ)

        # Find the next best hour from now
        best_hour = None
        best_weight = -1

        # Look ahead up to 24 hours
        for offset in range(1, 25):
            candidate = now_tw + timedelta(hours=offset)
            h = candidate.hour
            w = self._hour_engagement.get(h, 0.1)
            if w > best_weight:
                best_weight = w
                best_hour = candidate.replace(minute=0, second=0, microsecond=0)

        return best_hour

    def get_hour_weights(self) -> dict:
        """Return hour->weight map (for debugging/display)."""
        if self._hour_engagement is None:
            self._analyze_history()
        return {h: round(w, 3) for h, w in sorted(self._hour_engagement.items())}

    def schedule_post(self, text: str, publish_time: datetime = None) -> dict:
        """
        Create a scheduled Threads post.
        If no time given, use optimal.
        Returns dict with status and details.
        """
        if not text:
            return {"ok": False, "error": "empty text"}

        if publish_time is None:
            publish_time = self.optimal_time()

        # Use Playwright-based scheduler (browser UI, not API)
        try:
            sys.path.insert(0, str(BASE_DIR))
            from threads_scheduler import schedule_post as browser_schedule, post_now
        except ImportError:
            return {"ok": False, "error": "cannot import threads_scheduler"}

        tw_time = publish_time.astimezone(TW_TZ)
        date_str = tw_time.strftime('%Y-%m-%d')
        time_str = tw_time.strftime('%H:%M')

        # If less than 20 min from now, post immediately
        delta = (publish_time - datetime.now(TW_TZ)).total_seconds()
        if delta < 1200:
            try:
                post_now(text)
                return {"ok": True, "method": "immediate", "time": tw_time.isoformat()}
            except Exception as e:
                return {"ok": False, "error": str(e)}

        try:
            browser_schedule(text, date_str, time_str)
            return {"ok": True, "method": "scheduled", "date": date_str, "time": time_str}
        except Exception as e:
            return {"ok": False, "error": str(e)}

        # (old API code removed — now using Playwright browser scheduler)


# ══════════════════════════════════════════════════════════════
# 4. FeedbackLoop
# ══════════════════════════════════════════════════════════════

class FeedbackLoop:
    """Track post performance and update category weights."""

    def update_scores(self, conn=None):
        """
        Scan recent posts from threads.db, match to content_pipeline,
        update scores based on actual engagement.
        """
        own_conn = False
        if conn is None:
            conn = _get_social_conn()
            own_conn = True

        threads_conn = _get_threads_conn()
        if not threads_conn:
            print("  No threads.db available")
            if own_conn:
                conn.close()
            return

        # Get recent posts with engagement data
        try:
            posts = threads_conn.execute("""
                SELECT post_id, text_content, like_count, reply_count, repost_count, posted_at
                FROM posts
                WHERE user_id = ? AND posted_at IS NOT NULL
                ORDER BY posted_at DESC
                LIMIT 50
            """, (USER_ID,)).fetchall()
        except Exception:
            posts = []
        finally:
            threads_conn.close()

        if not posts:
            print("  No posts to analyze")
            if own_conn:
                conn.close()
            return

        # Group engagement by category
        category_engagement = defaultdict(lambda: {"total": 0, "count": 0})
        scorer = ContentScorer()

        for post in posts:
            text = post["text_content"] or ""
            engagement = (post["like_count"] or 0) + (post["reply_count"] or 0) * 2 + (post["repost_count"] or 0) * 3
            # Guess category from resonance
            res = scorer.resonance.score(text)
            if res["top_frequencies"]:
                freq_name = res["top_frequencies"][0][0]
                # Map frequency to category
                cat = _freq_to_category(freq_name)
            else:
                cat = "other"
            category_engagement[cat]["total"] += engagement
            category_engagement[cat]["count"] += 1

        # Update pipeline scores
        try:
            pipeline = conn.execute("SELECT id, source_text, category FROM content_pipeline").fetchall()
            updated = 0
            for row in pipeline:
                text = row["source_text"] or ""
                cat = row["category"] or "other"
                new_score = scorer.score(text, cat)
                conn.execute("UPDATE content_pipeline SET score = ? WHERE id = ?",
                             (new_score, row["id"]))
                updated += 1
            conn.commit()
            print(f"  Updated {updated} pipeline entries")
        except Exception as e:
            print(f"  Error updating pipeline: {e}")

        # Print category performance
        print("\n  Category performance (recent 50 posts):")
        for cat, data in sorted(category_engagement.items(), key=lambda x: -x[1]["total"]):
            avg = data["total"] / data["count"] if data["count"] > 0 else 0
            print(f"    {cat:15s}  posts={data['count']:3d}  avg_engagement={avg:.1f}")

        if own_conn:
            conn.close()

    def get_insights(self) -> dict:
        """What topics are trending up/down?"""
        threads_conn = _get_threads_conn()
        if not threads_conn:
            return {"error": "no threads.db"}

        try:
            posts = threads_conn.execute("""
                SELECT text_content, like_count, reply_count, repost_count, posted_at
                FROM posts
                WHERE user_id = ? AND posted_at IS NOT NULL
                ORDER BY posted_at DESC
                LIMIT 100
            """, (USER_ID,)).fetchall()
        except Exception:
            posts = []
        finally:
            threads_conn.close()

        if len(posts) < 4:
            return {"error": "not enough data", "post_count": len(posts)}

        # Split into recent half vs older half
        mid = len(posts) // 2
        recent = posts[:mid]
        older = posts[mid:]

        resonance = ResonanceFilter()

        def _aggregate(subset):
            cat_data = defaultdict(lambda: {"engagement": 0, "count": 0})
            for p in subset:
                text = p["text_content"] or ""
                eng = (p["like_count"] or 0) + (p["reply_count"] or 0) * 2 + (p["repost_count"] or 0) * 3
                res = resonance.score(text)
                if res["top_frequencies"]:
                    cat = _freq_to_category(res["top_frequencies"][0][0])
                else:
                    cat = "other"
                cat_data[cat]["engagement"] += eng
                cat_data[cat]["count"] += 1
            return cat_data

        recent_data = _aggregate(recent)
        older_data = _aggregate(older)

        trends = {}
        all_cats = set(list(recent_data.keys()) + list(older_data.keys()))
        for cat in all_cats:
            r = recent_data.get(cat, {"engagement": 0, "count": 0})
            o = older_data.get(cat, {"engagement": 0, "count": 0})
            r_avg = r["engagement"] / r["count"] if r["count"] > 0 else 0
            o_avg = o["engagement"] / o["count"] if o["count"] > 0 else 0
            if o_avg > 0:
                change_pct = ((r_avg - o_avg) / o_avg) * 100
            elif r_avg > 0:
                change_pct = 100
            else:
                change_pct = 0
            trends[cat] = {
                "recent_avg": round(r_avg, 1),
                "older_avg": round(o_avg, 1),
                "change_pct": round(change_pct, 1),
                "direction": "up" if change_pct > 10 else ("down" if change_pct < -10 else "flat"),
            }

        return {
            "total_posts_analyzed": len(posts),
            "recent_window": mid,
            "trends": dict(sorted(trends.items(), key=lambda x: -x[1]["change_pct"])),
        }


def _freq_to_category(freq_name: str) -> str:
    """Map resonance frequency name to content category."""
    mapping = {
        "taiwan_defense": "geopolitics",
        "ai_automation": "ai",
        "asymmetric_warfare": "geopolitics",
        "memory_evolution": "thought",
        "miaoli_local": "local",
        "invisible_army": "personal",
    }
    return mapping.get(freq_name, "other")


# ══════════════════════════════════════════════════════════════
# 5. ContentBrain — 總控
# ══════════════════════════════════════════════════════════════

class ContentBrain:
    """Orchestrator: perceive, judge, select, schedule, feedback."""

    def __init__(self):
        self.resonance = ResonanceFilter()
        self.amplifier = ResonanceAmplifier()
        self.scorer = ContentScorer()
        self.scheduler = PostScheduler()
        self.feedback = FeedbackLoop()

    def heartbeat(self):
        """
        Each heartbeat cycle:
        1. Perceive: what's new? (new Threads comments, pipeline entries)
        2. Judge: does it resonate? (ResonanceFilter)
        3. Select: pick best candidate (ContentScorer)
        4. Schedule: optimal time (PostScheduler)
        5. Feedback: update scores (FeedbackLoop)
        """
        print("=" * 60)
        print("  Content Brain Heartbeat")
        print(f"  {datetime.now(TW_TZ).strftime('%Y-%m-%d %H:%M TW')}")
        print("=" * 60)

        # 1. Perceive
        print("\n[1] Perceive...")
        social_conn = _get_social_conn()
        threads_conn = _get_threads_conn()

        pipeline_count = 0
        new_comments = 0
        try:
            pipeline_count = social_conn.execute(
                "SELECT COUNT(*) as c FROM content_pipeline"
            ).fetchone()["c"]
        except Exception:
            pass

        if threads_conn:
            try:
                new_comments = threads_conn.execute("""
                    SELECT COUNT(*) as c FROM comments
                    WHERE posted_at > datetime('now', '-24 hours')
                """).fetchone()["c"]
            except Exception:
                pass
            finally:
                threads_conn.close()

        print(f"  Pipeline entries: {pipeline_count}")
        print(f"  New comments (24h): {new_comments}")

        # 2. Judge + 3. Select
        print("\n[2-3] Judge & Select...")
        ranked = self.scorer.rank_pipeline(social_conn)
        if ranked:
            top = ranked[0]
            print(f"  Best candidate: [{top['category']}] score={top['new_score']:.1f}")
            print(f"  Preview: {top['text_preview']}")
        else:
            print("  No candidates in pipeline")

        # 4. Schedule
        print("\n[4] Schedule...")
        next_time = self.scheduler.optimal_time()
        if next_time:
            print(f"  Next optimal slot: {next_time.strftime('%Y-%m-%d %H:%M TW')}")

        # 5. Feedback
        print("\n[5] Feedback...")
        self.feedback.update_scores(social_conn)

        social_conn.close()
        print("\n" + "=" * 60)
        print("  Heartbeat complete")

    def suggest_next_post(self) -> dict:
        """Return the single best post to publish next, with reasoning."""
        conn = _get_social_conn()
        ranked = self.scorer.rank_pipeline(conn)
        conn.close()

        if not ranked:
            return {"suggestion": None, "reason": "Pipeline is empty"}

        # Filter: items not yet posted on FB (crosspost candidates)
        candidates = [r for r in ranked if r.get("fb_page_status") in ("na", "queued", None)]
        if not candidates:
            # Fallback: items not yet posted on any secondary platform
            candidates = [r for r in ranked if r.get("linkedin_status") in ("na", None)]
        if not candidates:
            candidates = ranked[:5]  # Last resort: top 5 overall

        best = candidates[0]
        res = self.resonance.score(best["text_preview"])
        next_time = self.scheduler.optimal_time()

        return {
            "suggestion": {
                "pipeline_id": best["id"],
                "text_preview": best["text_preview"],
                "category": best["category"],
                "score": best["new_score"],
            },
            "resonance": res,
            "recommended_time": next_time.strftime("%Y-%m-%d %H:%M TW") if next_time else None,
            "reason": (
                f"Category '{best['category']}' scores {best['new_score']:.0f}/100. "
                f"Resonance: {res['total_score']}/100. "
                f"Top freq: {', '.join(f[0] for f in res['top_frequencies'][:2]) if res['top_frequencies'] else 'none'}."
            ),
        }

    def daily_brief(self) -> str:
        """Generate a daily content intelligence brief for Cruz."""
        lines = []
        lines.append("Content Brain Daily Brief")
        lines.append(f"{datetime.now(TW_TZ).strftime('%Y-%m-%d %H:%M TW')}")
        lines.append("-" * 40)

        # Pipeline status
        conn = _get_social_conn()
        try:
            total = conn.execute("SELECT COUNT(*) as c FROM content_pipeline").fetchone()["c"]
            by_status = conn.execute("""
                SELECT threads_status, COUNT(*) as c
                FROM content_pipeline
                GROUP BY threads_status
            """).fetchall()
            lines.append(f"\nPipeline: {total} entries")
            for row in by_status:
                lines.append(f"  {row['threads_status'] or 'null'}: {row['c']}")
        except Exception as e:
            lines.append(f"\nPipeline: error ({e})")

        # Top candidates
        ranked = self.scorer.rank_pipeline(conn)
        conn.close()
        if ranked:
            lines.append(f"\nTop 5 candidates:")
            for i, r in enumerate(ranked[:5], 1):
                lines.append(f"  {i}. [{r['category']}] {r['new_score']:.0f}pts — {r['text_preview'][:50]}")

        # Engagement insights
        insights = self.feedback.get_insights()
        if "trends" in insights:
            lines.append(f"\nTrend analysis ({insights['total_posts_analyzed']} posts):")
            for cat, t in insights["trends"].items():
                arrow = {"up": "+", "down": "-", "flat": "="}[t["direction"]]
                lines.append(f"  {arrow} {cat}: avg {t['recent_avg']:.0f} ({t['change_pct']:+.0f}%)")

        # Schedule
        next_time = self.scheduler.optimal_time()
        if next_time:
            lines.append(f"\nNext optimal post time: {next_time.strftime('%Y-%m-%d %H:%M TW')}")

        # Hour weights (top 5)
        weights = self.scheduler.get_hour_weights()
        if weights:
            top_hours = sorted(weights.items(), key=lambda x: -x[1])[:5]
            lines.append("Best hours (TW): " + ", ".join(f"{h:02d}:00({w:.2f})" for h, w in top_hours))

        return "\n".join(lines)


# ── CLI ────────────────────────────────────────────────────────

USAGE = """
Usage: python3 content_brain.py <command> [args]

Commands:
    heartbeat           Run full heartbeat cycle (perceive/judge/select/schedule/feedback)
    suggest             Suggest the single best post to publish next
    brief               Generate daily content intelligence brief
    score "text"        Score a piece of text for crosspost priority
    resonance "text"    Check resonance with Cruz's frequencies
    rank                Rank all content_pipeline entries by score
    insights            Show engagement trend insights
    hours               Show optimal posting hours
"""

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(USAGE)
        sys.exit(1)

    cmd = sys.argv[1]
    brain = ContentBrain()

    if cmd == "heartbeat":
        brain.heartbeat()

    elif cmd == "suggest":
        result = brain.suggest_next_post()
        print(json.dumps(result, indent=2, ensure_ascii=False, default=str))

    elif cmd == "brief":
        print(brain.daily_brief())

    elif cmd == "score":
        if len(sys.argv) < 3:
            print("Usage: score \"text to evaluate\"")
            sys.exit(1)
        text = " ".join(sys.argv[2:])
        score = brain.scorer.score(text)
        res = brain.resonance.score(text)
        print(f"Content score: {score:.1f}/100")
        print(f"Resonance:     {res['total_score']}/100")
        print(f"Should engage: {res['should_engage']}")
        if res["top_frequencies"]:
            print(f"Top frequencies:")
            for name, hits, w in res["top_frequencies"]:
                print(f"  {name}: {hits} hits (w={w:.3f})")

    elif cmd == "resonance":
        if len(sys.argv) < 3:
            print("Usage: resonance \"text to check\"")
            sys.exit(1)
        text = " ".join(sys.argv[2:])
        result = brain.resonance.score(text)
        print(json.dumps(result, indent=2, ensure_ascii=False))

    elif cmd == "rank":
        ranked = brain.scorer.rank_pipeline()
        if not ranked:
            print("Pipeline is empty")
        else:
            print(f"{'#':>3} {'Score':>6} {'Cat':>12} {'Platform':>10} {'Preview'}")
            print("-" * 70)
            for i, r in enumerate(ranked, 1):
                print(f"{i:3d} {r['new_score']:6.1f} {r['category']:>12} {r['source_platform']:>10} {r['text_preview'][:40]}")

    elif cmd == "insights":
        result = brain.feedback.get_insights()
        print(json.dumps(result, indent=2, ensure_ascii=False))

    elif cmd == "hours":
        weights = brain.scheduler.get_hour_weights()
        print("Optimal posting hours (TW time):\n")
        for h in range(24):
            w = weights.get(h, 0)
            bar = "#" * int(w * 30)
            print(f"  {h:02d}:00  {w:.3f}  {bar}")

    elif cmd == "amplify":
        if len(sys.argv) < 3:
            print('Usage: amplify "text to boost"')
            sys.exit(1)
        text = " ".join(sys.argv[2:])
        result = brain.amplifier.amplify(text)
        print(f"Original score:  {result['original_score']}/100")
        print(f"Amplified score: {result['amplified_score']}/100")
        print(f"Bridges added:   {result['bridges_added']} ({', '.join(result['injected_frequencies'])})")
        print(f"\n{'='*40}\n{result['amplified_text']}")

    elif cmd == "schedule":
        # schedule "text" tomorrow 21:00
        # schedule "text" 2026-03-21 20:30
        # schedule "text" +2h
        if len(sys.argv) < 4:
            print('Usage: schedule "text" <date> [time]')
            sys.exit(1)
        text = sys.argv[2]
        date_str = sys.argv[3]
        time_str = sys.argv[4] if len(sys.argv) > 4 else None
        from threads_scheduler import schedule_post, post_now, _parse_time
        gridcell, h, m = _parse_time(date_str, time_str)
        schedule_post(text, date_str, time_str)

    elif cmd == "post":
        if len(sys.argv) < 3:
            print('Usage: post "text"')
            sys.exit(1)
        from threads_scheduler import post_now
        post_now(sys.argv[2])

    else:
        print(f"Unknown command: {cmd}")
        print(USAGE)
        sys.exit(1)
