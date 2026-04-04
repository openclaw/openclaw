#!/usr/bin/env python3
"""BioCorpus Sync — 五脈輪生物數據採集

從 5 個數據源採集生物指標，輸出 JSON 結構映射到脈輪系統。

Chakra mapping:
  1. Muladhara (根) → Hormone state (season, focus, ttl)
  2. Svadhisthana (流) → Nerve pulses (recent activity)
  3. Manipura (煉) → Threads coverage (reply coverage %)
  4. Vishuddhi (言) → Shadow Clone quality (avg score, excellence %)
  5. Sahasrara (空) → Memory count (stored memories)

Usage:
    python3 workspace/scripts/bio_corpus_sync.py
    # → prints JSON to stdout

    from workspace.scripts.bio_corpus_sync import collect_bio_corpus
    data = collect_bio_corpus()  # → dict
"""
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

CLAWD = Path(__file__).parent.parent.parent
CLAWD = CLAWD.resolve()

HORMONE_FILE = CLAWD / ".hormone"
NERVE_FILE = CLAWD / ".nerve"
THREADS_DB = CLAWD / "workspace" / "tools" / "threads-reply" / "threads.db"
SHADOW_LOG = CLAWD / "workspace" / "tools" / "threads-reply" / "shadow-quality-log.jsonl"
MEMORY_DIR = Path.home() / ".openclaw" / "memory"
LANCEDB_DIR = Path.home() / ".openclaw" / "memory" / "lancedb-pro"

SEASON_SCORES = {
    "grow": 90,
    "seed": 70,
    "harvest": 80,
    "rest": 40,
}


def _safe_read(path: Path) -> str:
    try:
        return path.read_text() if path.exists() else ""
    except Exception:
        return ""


def _yaml_val(text: str, key: str) -> str | None:
    m = re.search(rf"^{key}:\s*(.+)", text, re.M)
    return m.group(1).strip() if m else None


def collect_hormone() -> dict:
    season = "rest"
    focus = ""
    ttl = None
    suppress = []
    amplify = []
    raw_score = 50

    text = _safe_read(HORMONE_FILE)
    if text:
        season = _yaml_val(text, "season") or "rest"
        focus = _yaml_val(text, "focus") or ""
        ttl_str = _yaml_val(text, "ttl")
        if ttl_str:
            try:
                ttl = ttl_str.strip()
                from datetime import datetime as _dt
                ttl_dt = _dt.fromisoformat(ttl)
                now = datetime.now()
                remaining_h = max(0, (ttl_dt - now).total_seconds() / 3600)
                if remaining_h < 1:
                    raw_score = 20
                elif remaining_h < 6:
                    raw_score = 50
                else:
                    raw_score = 80
            except Exception:
                pass
        suppress = re.findall(r"^\s+-\s+(\S+)", text[0:text.find("amplify")] if "amplify" in text else text, re.M)
        amplify = re.findall(r"^\s+-\s+(\S+)", text, re.M)

    base = SEASON_SCORES.get(season, 50)
    if raw_score > 50:
        score = base
    else:
        score = min(base, raw_score)

    if not text:
        score = 30

    return {
        "chakra": "muladhara",
        "label": "Hormone",
        "score": score,
        "season": season,
        "focus": focus,
        "ttl": ttl,
        "suppress_count": len(suppress),
        "amplify_count": len(amplify),
        "status": "active" if text and season != "rest" else "dormant",
    }


def collect_nerve() -> dict:
    score = 30
    recent_count = 0
    sources = set()
    now = datetime.now()

    text = _safe_read(NERVE_FILE)
    if text.strip():
        try:
            data = json.loads(text)
            entries = data.get("entries", [])
            if isinstance(entries, list):
                cutoff = now - timedelta(minutes=5)
                recent = []
                for e in entries:
                    try:
                        ts = e.get("ts", "")
                        dt = datetime.fromisoformat(ts) if ts else None
                        if dt and dt > cutoff:
                            recent.append(e)
                            sources.add(e.get("who", "unknown"))
                    except Exception:
                        pass
                recent_count = len(recent)
                score = min(95, 30 + recent_count * 15) if recent_count > 0 else 30
            elif isinstance(data, dict) and "who" in data:
                recent_count = 1
                score = 45
        except json.JSONDecodeError:
            single_match = re.search(r'\{"who":\s*"([^"]+)"', text)
            if single_match:
                recent_count = 1
                score = 45

    return {
        "chakra": "svadhisthana",
        "label": "Nerve",
        "score": score,
        "recent_pulses_5m": recent_count,
        "active_sources": len(sources),
        "source_list": sorted(sources)[:10],
        "status": "active" if recent_count > 0 else "quiet",
    }


def collect_threads_coverage() -> dict:
    coverage_pct = 0.0
    total_comments = 0
    replied_count = 0
    unreplied_count = 0
    status = "no_data"

    if not THREADS_DB.exists():
        return {
            "chakra": "manipura",
            "label": "Threads",
            "score": 0,
            "coverage_pct": 0,
            "total_comments": 0,
            "replied": 0,
            "unreplied": 0,
            "status": "no_db",
        }

    try:
        conn = sqlite3.connect(f"file:{THREADS_DB}?mode=ro", uri=True, timeout=2)
        row = conn.execute("""
            SELECT
                COUNT(DISTINCT c.comment_id) as total,
                COUNT(DISTINCT CASE WHEN r.reply_id IS NOT NULL THEN c.comment_id END) as replied
            FROM comments c
            LEFT JOIN replies r ON c.comment_id = r.comment_id AND r.status = 'sent'
            JOIN profiles p ON c.user_id = p.user_id
            WHERE p.username != 'tangcruzz'
        """).fetchone()
        conn.close()

        total_comments = row[0] or 0
        replied_count = row[1] or 0
        unreplied_count = total_comments - replied_count
        coverage_pct = round(replied_count / total_comments * 100, 1) if total_comments > 0 else 0.0

        if total_comments > 0:
            score = min(100, int(coverage_pct))
            if coverage_pct >= 85:
                status = "excellent"
            elif coverage_pct >= 70:
                status = "good"
            elif coverage_pct >= 50:
                status = "moderate"
            else:
                status = "low"
        else:
            score = 50
            status = "no_comments"
    except Exception:
        status = "error"

    return {
        "chakra": "manipura",
        "label": "Threads",
        "score": score,
        "coverage_pct": coverage_pct,
        "total_comments": total_comments,
        "replied": replied_count,
        "unreplied": unreplied_count,
        "status": status,
    }


def collect_shadow_clone() -> dict:
    avg_score = 0.0
    excellence_pct = 0.0
    total_24h = 0
    score_8_plus = 0
    trend = "stable"
    status = "no_data"
    score = 0

    if not SHADOW_LOG.exists():
        return {
            "chakra": "vishuddhi",
            "label": "ShadowClone",
            "score": 0,
            "avg_score_24h": 0,
            "excellence_pct": 0,
            "total_replies_24h": 0,
            "trend": "no_data",
            "status": "no_log",
        }

    try:
        cutoff = datetime.now() - timedelta(hours=24)
        entries = []
        with open(SHADOW_LOG) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                    ts = e.get("ts", "")
                    if ts:
                        dt = datetime.fromisoformat(ts)
                        if dt > cutoff:
                            entries.append(e)
                except (json.JSONDecodeError, ValueError):
                    continue

        total_24h = len(entries)
        if total_24h > 0:
            scores = [e.get("score", 0) for e in entries if isinstance(e.get("score"), (int, float))]
            if scores:
                avg_score = round(sum(scores) / len(scores), 1)
                score_8_plus = sum(1 for s in scores if s >= 8.0)
                excellence_pct = round(score_8_plus / len(scores) * 100, 1)

            half = total_24h // 2
            if half > 0:
                first_half = [e.get("score", 0) for e in entries[:half] if isinstance(e.get("score"), (int, float))]
                second_half = [e.get("score", 0) for e in entries[half:] if isinstance(e.get("score"), (int, float))]
                if first_half and second_half:
                    avg_first = sum(first_half) / len(first_half)
                    avg_second = sum(second_half) / len(second_half)
                    diff = avg_second - avg_first
                    if diff > 0.3:
                        trend = "improving"
                    elif diff < -0.3:
                        trend = "declining"
                    else:
                        trend = "stable"

            score = min(100, int(avg_score * 10))
            if avg_score >= 8.0:
                status = "excellent"
            elif avg_score >= 7.0:
                status = "good"
            elif avg_score >= 6.0:
                status = "moderate"
            else:
                status = "low"
    except Exception:
        status = "error"

    return {
        "chakra": "vishuddhi",
        "label": "ShadowClone",
        "score": score,
        "avg_score_24h": avg_score,
        "excellence_pct": excellence_pct,
        "total_replies_24h": total_24h,
        "trend": trend,
        "status": status,
    }


def collect_memory() -> dict:
    count = 0
    status = "no_data"

    if LANCEDB_DIR.exists():
        try:
            for p in LANCEDB_DIR.iterdir():
                if p.suffix in (".lance", ".idx") or p.is_dir():
                    count += 1
        except Exception:
            pass

    if MEMORY_DIR.exists():
        try:
            for p in MEMORY_DIR.iterdir():
                if p.suffix == ".sqlite" and p.is_file():
                    try:
                        conn = sqlite3.connect(f"file:{p}?mode=ro", uri=True, timeout=1)
                        rows = conn.execute("SELECT COUNT(*) FROM memories").fetchone()
                        conn.close()
                        if rows:
                            count += rows[0]
                    except Exception:
                        try:
                            size_kb = p.stat().st_size / 1024
                            count += max(1, int(size_kb))
                        except Exception:
                            count += 1
                elif p.suffix == ".jsonl" and p.is_file():
                    try:
                        lc = sum(1 for _ in open(p) if _.strip())
                        count += lc
                    except Exception:
                        pass
        except Exception:
            pass

    if count > 1000:
        score = min(95, 70 + (count - 1000) // 100)
        status = "rich"
    elif count > 100:
        score = 60 + (count - 100) // 15
        status = "growing"
    elif count > 0:
        score = 40 + count // 5
        status = "sparse"
    else:
        score = 20
        status = "empty"

    return {
        "chakra": "sahasrara",
        "label": "Memory",
        "score": min(100, score),
        "count": count,
        "status": status,
    }


def collect_bio_corpus() -> dict:
    return {
        "updated_at": datetime.now().isoformat(),
        "hormone": collect_hormone(),
        "nerve": collect_nerve(),
        "threads": collect_threads_coverage(),
        "shadow_clone": collect_shadow_clone(),
        "memory": collect_memory(),
        "maturity": _calc_maturity(
            collect_hormone()["score"],
            collect_nerve()["score"],
            collect_threads_coverage()["score"],
            collect_shadow_clone()["score"],
            collect_memory()["score"],
        ),
    }


def _calc_maturity(h, n, t, s, m) -> dict:
    m1 = (h + n) / 2
    m2 = (t + s) / 2
    m3 = (s + m) / 2
    overall = (m1 + m2 + m3) / 3

    if overall >= 75:
        level = "M3"
    elif overall >= 55:
        level = "M2"
    elif overall >= 35:
        level = "M1"
    else:
        level = "M0"

    return {
        "level": level,
        "m1_root_flow": round(m1, 1),
        "m2_forge_bond": round(m2, 1),
        "m3_voice_mirror_void": round(m3, 1),
        "overall": round(overall, 1),
    }


if __name__ == "__main__":
    try:
        data = collect_bio_corpus()
        print(json.dumps(data, ensure_ascii=False, indent=2))
    except Exception as e:
        print(json.dumps({
            "updated_at": datetime.now().isoformat(),
            "error": str(e),
            "hormone": {"chakra": "muladhara", "score": 0, "status": "error"},
            "nerve": {"chakra": "svadhisthana", "score": 0, "status": "error"},
            "threads": {"chakra": "manipura", "score": 0, "status": "error"},
            "shadow_clone": {"chakra": "vishuddhi", "score": 0, "status": "error"},
            "memory": {"chakra": "sahasrara", "score": 0, "status": "error"},
            "maturity": {"level": "M0", "overall": 0},
        }, ensure_ascii=False))
        sys.exit(1)
