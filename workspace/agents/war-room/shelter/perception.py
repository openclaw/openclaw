#!/usr/bin/env python3
"""
Perception Layer — 眼睛 + 耳朵
Scans all data sources, produces event summaries.
Called by heartbeat every fast-tick (5 min).
Zero LLM. Pure I/O. <10 seconds.
"""

import json
import os
import re
import shutil
import sqlite3
import subprocess
from datetime import datetime, timedelta
from pathlib import Path

# ── Paths ──────────────────────────────────────────────────────────
WAR_ROOM = Path(__file__).resolve().parent.parent
SHELTER = WAR_ROOM / "shelter"
CLAWD_ROOT = WAR_ROOM.parent.parent.parent  # ~/clawd
DATA_DIR = SHELTER / "data"

DEFAULT_TRANSCRIPTS_DIR = CLAWD_ROOT / "workspace" / "river" / "data" / "transcripts"
DEFAULT_THREADS_DB = CLAWD_ROOT / "workspace" / "tools" / "threads-reply" / "threads.db"
DEFAULT_GATEWAY_LOG = Path.home() / ".openclaw" / "logs" / "gateway.log"
DEFAULT_SESSIONS_DIR = Path.home() / ".claude" / "projects"
DEFAULT_DOWNLOADS_DIR = Path.home() / "Downloads"

# ── Identity detection keywords ────────────────────────────────────
IDENTITY_RULES = [
    {
        "keywords": ["882", "马甲包", "前端", "后端", "验收", "bug", "測試站", "88r"],
        "project": "24bet",
        "identity": "andrew",
    },
    {
        "keywords": ["Danny", "弟哥", "苗栗", "選舉", "里長", "好朋友", "議員"],
        "project": "miaoli-hi",
        "identity": "cruz",
    },
    {
        "keywords": ["bita", "客服", "LINE", "幣塔", "出金", "入金"],
        "project": "bg666",
        "identity": "dufu",
    },
    {
        "keywords": ["思考者", "守夜人", "進化", "shelter", "thinker"],
        "project": "war-room",
        "identity": "cruz",
    },
]


# ══════════════════════════════════════════════════════════════════
# a) watch_transcripts
# ══════════════════════════════════════════════════════════════════

def _parse_srt(text: str) -> list[dict]:
    """Parse SRT format into list of {index, start, end, speaker, text}."""
    blocks = re.split(r"\n\n+", text.strip())
    entries = []
    for block in blocks:
        lines = block.strip().split("\n")
        if len(lines) < 2:
            continue
        # First line: index (optional, may be missing)
        # Second line: timestamps
        # Remaining: text
        timestamp_line = None
        text_lines = []
        for i, line in enumerate(lines):
            if "-->" in line:
                timestamp_line = line
                text_lines = lines[i + 1:]
                break
        if not timestamp_line:
            continue

        full_text = " ".join(text_lines).strip()
        # Detect speaker label: [Speaker 1] or (Speaker 1)
        speaker = None
        speaker_match = re.match(r"\[([^\]]+)\]\s*(.*)", full_text)
        if not speaker_match:
            speaker_match = re.match(r"\(([^)]+)\)\s*(.*)", full_text)
        if speaker_match:
            speaker = speaker_match.group(1)
            full_text = speaker_match.group(2)

        entries.append({
            "start": timestamp_line.split("-->")[0].strip(),
            "end": timestamp_line.split("-->")[1].strip() if "-->" in timestamp_line else "",
            "speaker": speaker,
            "text": full_text,
        })
    return entries


def _detect_identity(text: str) -> tuple[str, str]:
    """Detect project and identity from text content."""
    for rule in IDENTITY_RULES:
        if any(kw in text for kw in rule["keywords"]):
            return rule["project"], rule["identity"]
    return "general", "cruz"


def watch_transcripts(transcripts_dir: str = None, processed_dir: str = None) -> list[dict]:
    """Scan for new .srt files, parse, detect identity, move to processed."""
    t_dir = Path(transcripts_dir) if transcripts_dir else DEFAULT_TRANSCRIPTS_DIR
    p_dir = Path(processed_dir) if processed_dir else t_dir / "processed"

    if not t_dir.exists():
        return []

    p_dir.mkdir(parents=True, exist_ok=True)

    # Load last scan time
    state_file = DATA_DIR / "perception-state.json"
    last_scan = 0.0
    if state_file.exists():
        try:
            state = json.loads(state_file.read_text())
            last_scan = state.get("last_transcript_scan", 0.0)
        except Exception:
            pass

    events = []
    for srt_file in sorted(t_dir.glob("*.srt")):
        if srt_file.stat().st_mtime <= last_scan:
            continue

        try:
            content = srt_file.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue

        entries = _parse_srt(content)
        if not entries:
            continue

        # Combine all text for identity detection
        all_text = " ".join(e["text"] for e in entries)
        project, identity = _detect_identity(all_text)

        # Build summary (first 200 chars of combined text)
        summary = all_text[:200].strip()
        if len(all_text) > 200:
            summary += "..."

        events.append({
            "source": "transcript",
            "identity": identity,
            "project": project,
            "summary": summary,
            "timestamp": datetime.fromtimestamp(srt_file.stat().st_mtime).isoformat(),
            "file": srt_file.name,
            "entries_count": len(entries),
            "speakers": list(set(e["speaker"] for e in entries if e["speaker"])),
        })

        # Move to processed
        try:
            dest = p_dir / srt_file.name
            shutil.move(str(srt_file), str(dest))
        except Exception:
            pass  # Leave in place if move fails

    # Update scan time
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _state = {}
    if state_file.exists():
        try:
            _state = json.loads(state_file.read_text())
        except Exception:
            pass
    _state["last_transcript_scan"] = datetime.now().timestamp()
    state_file.write_text(json.dumps(_state, ensure_ascii=False, indent=2))

    return events


# ══════════════════════════════════════════════════════════════════
# b) scan_threads_db
# ══════════════════════════════════════════════════════════════════

def scan_threads_db(db_path: str = None) -> dict:
    """Read threads.db (read-only, WAL safe). Return comment/reply stats."""
    db = db_path or str(DEFAULT_THREADS_DB)

    if not Path(db).exists():
        return {"new_1h": 0, "new_24h": 0, "unreplied": 0, "atier_unreplied": 0,
                "total_comments": 0, "total_profiles": 0}

    result = {}
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row

        # New comments last 1h
        row = conn.execute(
            "SELECT COUNT(*) as cnt FROM comments WHERE posted_at > datetime('now', '-1 hours')"
        ).fetchone()
        result["new_1h"] = row["cnt"] if row else 0

        # New comments last 24h
        row = conn.execute(
            "SELECT COUNT(*) as cnt FROM comments WHERE posted_at > datetime('now', '-24 hours')"
        ).fetchone()
        result["new_24h"] = row["cnt"] if row else 0

        # Unreplied: 根留言且非 Cruz 自己寫的且非垃圾（純讚/單字）且沒有 reply
        # 1. parent_comment_id IS NULL = 根留言
        # 2. 排除 Cruz 自己的 user_id（抓帖子的 user_id 跟 comment 的比對）
        # 3. 排除 length(text) <= 3 的垃圾留言（讚、留、？）
        row = conn.execute("""
            SELECT COUNT(*) as cnt FROM comments c
            WHERE c.parent_comment_id IS NULL
            AND length(c.text_content) > 3
            AND c.user_id NOT IN (
                SELECT DISTINCT p.user_id FROM posts p
                UNION SELECT 'tangcruzz'
            )
            AND NOT EXISTS (
                SELECT 1 FROM replies r WHERE r.comment_id = c.comment_id
            )
        """).fetchone()
        result["unreplied"] = row["cnt"] if row else 0

        # A-tier unreplied: join with profiles where value_tier in ('A', 'S')
        try:
            row = conn.execute("""
                SELECT COUNT(*) as cnt FROM comments c
                JOIN profiles p ON c.user_id = p.user_id
                WHERE p.value_tier IN ('A', 'S')
                AND NOT EXISTS (
                    SELECT 1 FROM replies r WHERE r.comment_id = c.comment_id
                )
            """).fetchone()
            result["atier_unreplied"] = row["cnt"] if row else 0
        except Exception:
            result["atier_unreplied"] = 0

        # Totals
        row = conn.execute("SELECT COUNT(*) as cnt FROM comments").fetchone()
        result["total_comments"] = row["cnt"] if row else 0

        row = conn.execute("SELECT COUNT(*) as cnt FROM profiles").fetchone()
        result["total_profiles"] = row["cnt"] if row else 0

        conn.close()
    except Exception:
        result.setdefault("new_1h", 0)
        result.setdefault("new_24h", 0)
        result.setdefault("unreplied", 0)
        result.setdefault("atier_unreplied", 0)
        result.setdefault("total_comments", 0)
        result.setdefault("total_profiles", 0)

    return result


# ══════════════════════════════════════════════════════════════════
# c) scan_gateway_log
# ══════════════════════════════════════════════════════════════════

def scan_gateway_log(log_path: str = None, tail_lines: int = 200) -> dict:
    """Read last N lines of gateway.log. Count bita messages, nen activity, failures."""
    gw_log = Path(log_path) if log_path else DEFAULT_GATEWAY_LOG

    if not gw_log.exists():
        return {"bita_messages": 0, "nen_created": 0, "nen_merged": 0, "nen_fails": 0}

    try:
        lines = gw_log.read_text(encoding="utf-8", errors="replace").splitlines()
        lines = lines[-tail_lines:]
    except Exception:
        return {"bita_messages": 0, "nen_created": 0, "nen_merged": 0, "nen_fails": 0}

    bita_messages = sum(1 for l in lines if "bita" in l.lower())
    nen_created = sum(1 for l in lines if "smart-extractor: created" in l)
    nen_merged = sum(1 for l in lines if "smart-extractor: merged" in l)
    nen_fails = sum(1 for l in lines if "FAIL:" in l)

    return {
        "bita_messages": bita_messages,
        "nen_created": nen_created,
        "nen_merged": nen_merged,
        "nen_fails": nen_fails,
    }


# ══════════════════════════════════════════════════════════════════
# d) scan_sessions
# ══════════════════════════════════════════════════════════════════

def scan_sessions(projects_dir: str = None) -> dict:
    """Count active Claude Code sessions by checking JSONL file mtimes."""
    p_dir = Path(projects_dir) if projects_dir else DEFAULT_SESSIONS_DIR

    if not p_dir.exists():
        return {"active_sessions": 0, "total_today": 0}

    now_ts = datetime.now()
    one_hour_ago = now_ts - timedelta(hours=1)
    today_start = now_ts.replace(hour=0, minute=0, second=0, microsecond=0)

    active = 0
    today_total = 0

    try:
        for root, dirs, files in os.walk(str(p_dir)):
            for f in files:
                if not f.endswith(".jsonl"):
                    continue
                fp = Path(root) / f
                try:
                    mtime = datetime.fromtimestamp(fp.stat().st_mtime)
                    if mtime > one_hour_ago:
                        active += 1
                    if mtime > today_start:
                        today_total += 1
                except Exception:
                    continue
    except Exception:
        pass

    return {"active_sessions": active, "total_today": today_total}


# ══════════════════════════════════════════════════════════════════
# e) generate_daily_intel
# ══════════════════════════════════════════════════════════════════

def generate_daily_intel(
    events: list[dict],
    threads: dict,
    gateway: dict,
    sessions: dict,
    schedule: dict,
    now: datetime = None,
    weather: dict = None,
    rhythm: dict = None,
    priorities: list[dict] = None,
    news: dict = None,
    chatgpt: dict = None,
    body: dict = None,
) -> str:
    """Combine all scan results into a markdown daily intel report."""
    if now is None:
        now = datetime.now()

    lines = [
        f"# 今日情報 — {now.strftime('%Y-%m-%d %H:%M')}",
        "",
    ]

    # ── Top 5 priorities (placed at top before everything else) ──
    if priorities:
        lines.append("## Top 5")
        for p in priorities:
            lines.append(f"{p['rank']}. [{p['urgency']}] {p['item']} -- {p['project']}")
        lines.append("")

    # ── 你可能需要的 ──
    needs = []
    if threads.get("unreplied", 0) > 5:
        atier = threads.get("atier_unreplied", 0)
        msg = f"Threads {threads['unreplied']} 則未回覆"
        if atier > 0:
            msg += f"（{atier} 則 A/S-tier）"
        needs.append(msg)
    elif threads.get("atier_unreplied", 0) > 0:
        needs.append(f"Threads {threads['atier_unreplied']} 則 A/S-tier 未回覆")

    for ev in events:
        if ev.get("source") == "transcript":
            identity_label = ev.get("identity", "unknown")
            project_label = ev.get("project", "unknown")
            needs.append(
                f"新錄音：{ev.get('file', '?')} ({project_label}/{identity_label}, "
                f"{ev.get('entries_count', 0)} 段)"
            )

    if gateway.get("nen_fails", 0) > 5:
        needs.append(f"念系統 {gateway['nen_fails']} 次失敗 — 檢查 Ollama")

    if weather and weather.get("condition", "unknown") != "unknown":
        w_cond = weather.get("condition", "")
        w_temp = weather.get("temp", "")
        if any(kw in w_cond for kw in ("雨", "暴", "颱")):
            needs.append(f"天氣異常：{w_cond} {w_temp}")

    if rhythm and not rhythm.get("sustainable", True):
        y_end = rhythm.get("yesterday_end", "?")
        t_start = rhythm.get("today_start", "?")
        rest = rhythm.get("rest_hours", 0)
        needs.append(
            f"作息提醒：昨天 {y_end} 收工，今天 {t_start} 開始，只休息了 {rest}h"
        )

    if chatgpt and chatgpt.get("unprocessed", 0) > 0:
        needs.append(f"{chatgpt['unprocessed']} 份 ChatGPT 對話待處理")

    if news and news.get("module_matches"):
        for match in news["module_matches"][:3]:  # cap at 3
            needs.append(
                f"世界新聞：\"{match['headline']}\" → 可能影響 {match['module']}"
            )

    lines.append("## 你可能需要的")
    if needs:
        for n in needs:
            lines.append(f"- {n}")
    else:
        lines.append("- 沒有需要立即處理的事")
    lines.append("")

    # ── 各線狀態 ──
    lines.append("## 各線狀態")
    lines.append("| 線 | 今日 | 狀態 |")
    lines.append("|----|------|------|")

    # Threads
    t_status = "ok" if threads.get("unreplied", 0) <= 5 else "needs-attention"
    t_emoji = "v" if t_status == "ok" else "!"
    lines.append(
        f"| threads | +{threads.get('new_24h', 0)} comments, "
        f"{threads.get('unreplied', 0)} unreplied | {t_emoji} |"
    )

    # bita-cs
    bita_n = gateway.get("bita_messages", 0)
    lines.append(f"| bita-cs | {bita_n} messages in log tail | v |")

    # claude-code
    lines.append(
        f"| claude-code | {sessions.get('active_sessions', 0)} active, "
        f"{sessions.get('total_today', 0)} today | v |"
    )

    # nen
    nen_total = gateway.get("nen_created", 0) + gateway.get("nen_merged", 0)
    nen_status = "!" if gateway.get("nen_fails", 0) > 5 else "v"
    lines.append(
        f"| nen | +{nen_total} memories, {gateway.get('nen_fails', 0)} fails | {nen_status} |"
    )

    # transcripts
    lines.append(f"| transcripts | {len(events)} new | v |")

    # weather
    if weather and weather.get("condition", "unknown") != "unknown":
        w_cond = weather.get("condition", "")
        w_temp = weather.get("temp", "")
        lines.append(f"| weather | {w_cond} {w_temp} | v |")

    # news
    if news:
        n_headlines = news.get("headlines_found", 0)
        n_matches = len(news.get("module_matches", []))
        n_status = "!" if n_matches > 0 else "v"
        lines.append(f"| news | {n_headlines} headlines, {n_matches} module hits | {n_status} |")

    lines.append("")

    # ── 不需要注意的 ──
    normals = []
    if threads.get("unreplied", 0) <= 5:
        normals.append(f"Threads 未回覆 {threads.get('unreplied', 0)} (正常範圍)")
    if gateway.get("nen_fails", 0) <= 5:
        normals.append("念系統運作正常")
    if sessions.get("active_sessions", 0) >= 0:
        normals.append(f"Claude Code {sessions.get('active_sessions', 0)} 個活躍 session")

    # ── 身體狀態 ──
    if body and body.get("narrative"):
        lines.append(f"## 身體")
        lines.append(body["narrative"])
        lines.append("")

    lines.append("## 不需要注意的")
    for n in normals:
        lines.append(f"- {n}")
    lines.append("")

    intel_text = "\n".join(lines)

    # Write to file
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    intel_path = DATA_DIR / "daily-intel.md"
    try:
        intel_path.write_text(intel_text, encoding="utf-8")
    except Exception:
        pass

    return intel_text


# ══════════════════════════════════════════════════════════════════
# f) scan_weather
# ══════════════════════════════════════════════════════════════════

WEATHER_CACHE = DATA_DIR / "weather-cache.json"
WEATHER_CACHE_TTL = timedelta(minutes=30)

# ── World News module keyword mapping ──────────────────────────────
MODULE_KEYWORDS = {
    "TW-1-energy": ["LNG", "天然氣", "能源", "電力", "核電"],
    "K-1-taiwan-strait": ["台海", "台灣海峽", "解放軍", "軍演"],
    "K-2-hormuz": ["荷姆茲", "伊朗", "石油", "油價"],
    "TW-3-food": ["糧食", "小麥", "稻米", "食安"],
    "C-5-usa-military": ["美軍", "軍費", "砲彈", "軍售"],
    "G-2-dedollarization": ["去美元", "SWIFT", "CIPS", "人民幣"],
    "G-5-proxy-war": ["代理人戰爭", "胡塞", "葉門", "烏克蘭"],
}

NEWS_CACHE = DATA_DIR / "news-cache.json"
NEWS_CACHE_TTL = timedelta(hours=2)


# ══════════════════════════════════════════════════════════════════
# f-pre) scan_world_news
# ══════════════════════════════════════════════════════════════════

def scan_world_news(cache_path: Path = None) -> dict:
    """Fetch Google News RSS for geopolitical keywords, cross-reference with knowledge modules.

    Uses a 2-hour cache to avoid hitting Google too often.
    Never crashes — returns empty results on any failure.
    """
    cache = cache_path or NEWS_CACHE

    # Check cache first
    try:
        if cache.exists():
            data = json.loads(cache.read_text(encoding="utf-8"))
            cached_at = datetime.fromisoformat(data.get("cached_at", "2000-01-01"))
            if datetime.now() - cached_at < NEWS_CACHE_TTL:
                data["cached"] = True
                return data
    except Exception:
        pass

    # Fetch Google News RSS
    rss_url = (
        "https://news.google.com/rss/search?"
        "q=%E5%8F%B0%E6%B5%B7+OR+%E8%8D%B7%E5%A7%86%E8%8C%B2+OR+LNG"
        "+OR+%E5%8F%B0%E7%81%A3%E8%83%BD%E6%BA%90+OR+%E5%8D%97%E6%B5%B7"
        "&hl=zh-TW&gl=TW&ceid=TW:zh-Hant"
    )
    try:
        result = subprocess.run(
            ["curl", "-s", "--max-time", "5", rss_url],
            capture_output=True, text=True, timeout=8,
        )
        raw = result.stdout
        if not raw or result.returncode != 0:
            return {"headlines_found": 0, "module_matches": [], "cached": False}
    except Exception:
        return {"headlines_found": 0, "module_matches": [], "cached": False}

    # Parse headlines from XML using regex (keep it simple, no xml.etree)
    titles = re.findall(r"<title>(.*?)</title>", raw)
    # Skip the first title (it's the feed title, not a headline)
    headlines = [t.strip() for t in titles[1:] if t.strip()]

    # Cross-reference with module keywords
    module_matches = []
    for headline in headlines:
        for module, keywords in MODULE_KEYWORDS.items():
            if any(k in headline for k in keywords):
                module_matches.append({"headline": headline, "module": module})
                break  # one module per headline is enough

    result_data = {
        "headlines_found": len(headlines),
        "module_matches": module_matches,
        "cached": False,
        "cached_at": datetime.now().isoformat(),
    }

    # Cache result
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(result_data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass

    return result_data


def scan_weather(location: str = "Miaoli") -> dict:
    """Fetch weather from wttr.in. Returns dict with condition/temp/humidity/wind.
    Uses a 30-minute cache to avoid hitting the API too often.
    Never crashes — returns {"condition": "unknown"} on any failure.
    """
    # Check cache first
    try:
        if WEATHER_CACHE.exists():
            cache = json.loads(WEATHER_CACHE.read_text(encoding="utf-8"))
            cached_at = datetime.fromisoformat(cache.get("cached_at", "2000-01-01"))
            if datetime.now() - cached_at < WEATHER_CACHE_TTL:
                return cache
    except Exception:
        pass

    # Call wttr.in
    try:
        result = subprocess.run(
            ["curl", "-s", f"wttr.in/{location}?format=%C+%t+%h+%w&lang=zh-tw"],
            capture_output=True, text=True, timeout=3,
        )
        raw = result.stdout.strip()
        if not raw or result.returncode != 0:
            return {"condition": "unknown"}
    except Exception:
        return {"condition": "unknown"}

    # Parse: format is like "晴 +28°C 65% →3km/h"
    # Fields are space-separated but condition may contain spaces (e.g. "陽光充足")
    # Strategy: extract temp/humidity/wind from the end, rest is condition
    parts = raw.split()
    data = {"condition": "unknown", "raw": raw}

    try:
        # Find temp (contains °C), humidity (contains %), wind (contains km/h)
        temp_idx = None
        for i, p in enumerate(parts):
            if "°C" in p:
                temp_idx = i
                break

        if temp_idx is not None and temp_idx + 2 < len(parts):
            data["condition"] = " ".join(parts[:temp_idx])
            data["temp"] = parts[temp_idx]
            data["humidity"] = parts[temp_idx + 1]
            data["wind"] = parts[temp_idx + 2]
        elif len(parts) >= 4:
            # Fallback: last 3 are temp/humidity/wind
            data["condition"] = " ".join(parts[:-3])
            data["temp"] = parts[-3]
            data["humidity"] = parts[-2]
            data["wind"] = parts[-1]
        else:
            data["condition"] = raw
    except Exception:
        data["condition"] = raw

    # Cache result
    data["cached_at"] = datetime.now().isoformat()
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        WEATHER_CACHE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass

    return data


# ══════════════════════════════════════════════════════════════════
# g) analyze_cruz_rhythm
# ══════════════════════════════════════════════════════════════════

RHYTHM_CACHE = DATA_DIR / "rhythm-cache.json"
RHYTHM_CACHE_TTL = 6 * 3600  # 6 hours


def analyze_cruz_rhythm(projects_dir: str = None, now: datetime = None) -> dict:
    """Analyze Cruz's work/rest rhythm from session file mtimes (last 7 days).

    Returns dict with today_start, yesterday_end, rest_hours, peak_hours,
    sustainable (True if rest >= 6h), weekly_sessions count.
    Only uses file mtime -- never opens file contents.
    """
    if now is None:
        now = datetime.now()

    # Check cache
    if RHYTHM_CACHE.exists():
        try:
            cached = json.loads(RHYTHM_CACHE.read_text())
            cached_at = cached.get("_cached_at", 0)
            if now.timestamp() - cached_at < RHYTHM_CACHE_TTL:
                return cached
        except Exception:
            pass

    p_dir = Path(projects_dir) if projects_dir else DEFAULT_SESSIONS_DIR
    seven_days_ago = now - timedelta(days=7)
    today = now.date()
    yesterday = today - timedelta(days=1)

    # Collect all session file mtimes from last 7 days
    hourly_counts = [0] * 24  # index 0-23
    today_times: list[datetime] = []
    yesterday_times: list[datetime] = []
    weekly_sessions = 0
    all_activity_times: list[datetime] = []

    if p_dir.exists():
        for root, _dirs, files in os.walk(str(p_dir)):
            for f in files:
                if not f.endswith(".jsonl"):
                    continue
                fp = Path(root) / f
                try:
                    mtime_ts = fp.stat().st_mtime
                    mtime = datetime.fromtimestamp(mtime_ts)
                    if mtime < seven_days_ago:
                        continue

                    weekly_sessions += 1
                    hourly_counts[mtime.hour] += 1
                    all_activity_times.append(mtime)

                    if mtime.date() == today:
                        today_times.append(mtime)
                    elif mtime.date() == yesterday:
                        yesterday_times.append(mtime)
                except Exception:
                    continue

    # today_start: earliest activity today
    today_start = None
    if today_times:
        earliest = min(today_times)
        today_start = earliest.strftime("%H:%M")

    # yesterday_end: latest activity yesterday
    yesterday_end = None
    if yesterday_times:
        latest = max(yesterday_times)
        yesterday_end = latest.strftime("%H:%M")

    # peak_hours: top 3 most active hours
    indexed = sorted(enumerate(hourly_counts), key=lambda x: -x[1])
    peak_hours = [h for h, c in indexed[:3] if c > 0]

    # rest_hours: longest gap between consecutive activities
    rest_hours = 0.0
    if len(all_activity_times) >= 2:
        sorted_times = sorted(all_activity_times)
        max_gap = timedelta(0)
        for i in range(1, len(sorted_times)):
            gap = sorted_times[i] - sorted_times[i - 1]
            if gap > max_gap:
                max_gap = gap
        rest_hours = round(max_gap.total_seconds() / 3600, 2)

    # If we have today_start and yesterday_end, compute overnight rest directly
    overnight_rest = None
    if today_times and yesterday_times:
        overnight_gap = min(today_times) - max(yesterday_times)
        overnight_rest = round(overnight_gap.total_seconds() / 3600, 2)

    effective_rest = overnight_rest if overnight_rest is not None else rest_hours
    sustainable = effective_rest >= 6 if weekly_sessions > 0 else True  # No data = can't judge

    result = {
        "today_start": today_start,
        "yesterday_end": yesterday_end,
        "rest_hours": effective_rest,
        "peak_hours": peak_hours,
        "sustainable": sustainable,
        "weekly_sessions": weekly_sessions,
    }

    # Cache result
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    try:
        cache_data = dict(result)
        cache_data["_cached_at"] = now.timestamp()
        RHYTHM_CACHE.write_text(json.dumps(cache_data, ensure_ascii=False, indent=2))
    except Exception:
        pass

    return result



# ══════════════════════════════════════════════════════════════════
# h2) compute_priorities — "What should Cruz focus on right now?"
# ══════════════════════════════════════════════════════════════════

URGENCY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}

BULLETIN_PATH = CLAWD_ROOT / "workspace" / "BULLETIN.md"
PENDING_PATCHES_PATH = DATA_DIR / "pending-patches.jsonl"
DAILY_INTEL_PATH = DATA_DIR / "daily-intel.md"
EVOLUTION_LOG_PATH = SHELTER / "evolution-log.md"


def _parse_bulletin_alerts(bulletin_path: Path = None) -> list[dict]:
    """Extract active alerts from BULLETIN.md. Returns list of {level, text, project}."""
    bp = bulletin_path or BULLETIN_PATH
    if not bp.exists():
        return []

    try:
        content = bp.read_text(encoding="utf-8")
    except Exception:
        return []

    alerts = []
    for line in content.splitlines():
        line_stripped = line.strip()
        # Match ### [P0] ... or ### ~~[P1] ...~~ (skip RESOLVED)
        m = re.match(r"^###\s+(?:~~)?\[P(\d+)\]\s*(.*?)(?:~~)?$", line_stripped)
        if m:
            if "RESOLVED" in line_stripped.upper():
                continue
            level = int(m.group(1))
            text = m.group(2).strip()
            project = "openclaw"
            if any(kw in text.lower() for kw in ("db_sync", "rds", "bg666")):
                project = "bg666"
            elif "sentinel" in text.lower():
                project = "sentinel"
            elif "gateway" in text.lower():
                project = "openclaw"
            alerts.append({"level": level, "text": text, "project": project})
            continue

        # Match inline sentinel anomalies: "- [Sentinel Anomaly P0] score=64"
        m2 = re.match(r"^-\s+\[.*?P([01])\](.*)$", line_stripped)
        if m2:
            level = int(m2.group(1))
            text = m2.group(2).strip()
            alerts.append({"level": level, "text": f"Sentinel Anomaly {text}", "project": "sentinel"})

    return alerts


def _parse_pending_patches(patches_path: Path = None) -> dict:
    """Read pending-patches.jsonl. Return {count, by_type, oldest_days}."""
    pp = patches_path or PENDING_PATCHES_PATH
    if not pp.exists():
        return {"count": 0, "by_type": {}, "oldest_days": 0}

    try:
        raw_lines = pp.read_text(encoding="utf-8").strip().splitlines()
    except Exception:
        return {"count": 0, "by_type": {}, "oldest_days": 0}

    patches = []
    by_type = {}
    for line in raw_lines:
        if not line.strip():
            continue
        try:
            p = json.loads(line)
            patches.append(p)
            t = p.get("type", "unknown")
            by_type[t] = by_type.get(t, 0) + 1
        except Exception:
            continue

    oldest_days = 0
    now = datetime.now()
    for p in patches:
        logged_at = p.get("logged_at", "")
        if logged_at:
            try:
                dt = datetime.fromisoformat(logged_at)
                age = (now - dt).days
                if age > oldest_days:
                    oldest_days = age
            except Exception:
                pass

    return {"count": len(patches), "by_type": by_type, "oldest_days": oldest_days}


def _check_file_freshness(file_path: Path, stale_hours: float = 6.0) -> dict:
    """Check how fresh a file is. Returns {exists, hours_ago, stale}."""
    if not file_path.exists():
        return {"exists": False, "hours_ago": None, "stale": True}

    try:
        mtime = datetime.fromtimestamp(file_path.stat().st_mtime)
        hours_ago = (datetime.now() - mtime).total_seconds() / 3600
        return {
            "exists": True,
            "hours_ago": round(hours_ago, 1),
            "stale": hours_ago > stale_hours,
        }
    except Exception:
        return {"exists": False, "hours_ago": None, "stale": True}


def compute_priorities(
    threads: dict = None,
    bulletin_path: Path = None,
    patches_path: Path = None,
    intel_path: Path = None,
    evolution_log_path: Path = None,
) -> list[dict]:
    """Compute top 5 priority items for Cruz, sorted by urgency.

    Returns list of dicts: {rank, item, project, urgency}
    """
    items = []

    # 1) BULLETIN alerts
    alerts = _parse_bulletin_alerts(bulletin_path)
    for a in alerts:
        if a["level"] <= 1:
            urgency = "critical"
        elif a["level"] == 2:
            urgency = "high"
        else:
            urgency = "medium"
        items.append({
            "item": f"[P{a['level']}] {a['text']}",
            "project": a["project"],
            "urgency": urgency,
        })

    # 2) Pending patches
    patches = _parse_pending_patches(patches_path)
    if patches["oldest_days"] > 7:
        old_count = 0
        pp = patches_path or PENDING_PATCHES_PATH
        if pp.exists():
            try:
                now_ts = datetime.now()
                cutoff = now_ts - timedelta(days=7)
                for line in pp.read_text().strip().splitlines():
                    if not line.strip():
                        continue
                    try:
                        p = json.loads(line)
                        logged = p.get("logged_at", "")
                        if logged and datetime.fromisoformat(logged) < cutoff:
                            old_count += 1
                    except Exception:
                        continue
            except Exception:
                pass
        items.append({
            "item": f"{old_count} pending patches >7d (oldest {patches['oldest_days']}d)",
            "project": "war-room",
            "urgency": "medium",
        })
    elif patches["count"] > 0:
        items.append({
            "item": f"{patches['count']} pending patches (oldest {patches['oldest_days']}d)",
            "project": "war-room",
            "urgency": "low",
        })

    # 3) Threads (reuse scan_threads_db result if provided)
    if threads is None:
        threads = scan_threads_db()

    atier = threads.get("atier_unreplied", 0)
    unreplied = threads.get("unreplied", 0)

    if atier > 0:
        items.append({
            "item": f"Threads {unreplied} unreplied ({atier} A-tier)",
            "project": "threads",
            "urgency": "high",
        })
    elif unreplied > 100:
        items.append({
            "item": f"Threads {unreplied} unreplied",
            "project": "threads",
            "urgency": "medium",
        })
    elif unreplied > 5:
        items.append({
            "item": f"Threads {unreplied} unreplied",
            "project": "threads",
            "urgency": "low",
        })

    # 4) Daily intel freshness
    intel_fresh = _check_file_freshness(
        intel_path or DAILY_INTEL_PATH, stale_hours=6.0
    )
    if intel_fresh["stale"]:
        hours = intel_fresh["hours_ago"]
        label = f"{hours}h ago" if hours is not None else "missing"
        items.append({
            "item": f"Daily intel stale ({label})",
            "project": "war-room",
            "urgency": "low",
        })

    # 5) Evolution log freshness
    evo_fresh = _check_file_freshness(
        evolution_log_path or EVOLUTION_LOG_PATH, stale_hours=6.0
    )
    if evo_fresh["stale"]:
        hours = evo_fresh["hours_ago"]
        label = f"{hours}h ago" if hours is not None else "missing"
        items.append({
            "item": f"Evolution log not updated ({label})",
            "project": "war-room",
            "urgency": "low",
        })

    # Sort by urgency, take top 5
    items.sort(key=lambda x: URGENCY_ORDER.get(x["urgency"], 99))
    top5 = items[:5]

    for i, item in enumerate(top5):
        item["rank"] = i + 1

    return top5


# ══════════════════════════════════════════════════════════════════
# g2) scan_chatgpt_exports — check ~/Downloads for new ChatGPT JSON files
# ══════════════════════════════════════════════════════════════════

def scan_chatgpt_exports(downloads_dir: Path = None, max_age_hours: float = 2.0) -> dict:
    """Check ~/Downloads/ for new ChatGPT JSON files (mtime < max_age_hours).

    Returns dict with count of unprocessed exports and file list.
    Never crashes — returns empty results on any failure.
    """
    d_dir = downloads_dir or DEFAULT_DOWNLOADS_DIR
    if not d_dir.exists():
        return {"unprocessed": 0, "files": []}

    cutoff = datetime.now() - timedelta(hours=max_age_hours)
    state_file = DATA_DIR / "chatgpt-bridge-state.json"

    # Load processed state
    processed = {}
    if state_file.exists():
        try:
            state = json.loads(state_file.read_text(encoding="utf-8"))
            processed = state.get("processed", {})
        except Exception:
            pass

    unprocessed = []
    try:
        for f in d_dir.iterdir():
            if not f.is_file() or not f.name.endswith(".json"):
                continue
            if not f.name.startswith("ChatGPT"):
                continue
            try:
                mtime = datetime.fromtimestamp(f.stat().st_mtime)
                if mtime < cutoff:
                    continue
                key = str(f)
                if key in processed and processed[key] == f.stat().st_mtime:
                    continue
                # Quick format check
                data = json.loads(f.read_text(encoding="utf-8"))
                if (isinstance(data, dict)
                    and "metadata" in data
                    and "messages" in data
                    and isinstance(data["messages"], list)
                    and len(data["messages"]) > 0):
                    unprocessed.append(f.name)
            except Exception:
                continue
    except Exception:
        pass

    return {"unprocessed": len(unprocessed), "files": unprocessed}


# ══════════════════════════════════════════════════════════════════
# h) scan_all -- main entry point
# ══════════════════════════════════════════════════════════════════

def _load_schedule(schedule_path: str) -> dict:
    """Load schedule YAML. Uses PyYAML if available, else returns empty dict."""
    p = Path(schedule_path)
    if not p.exists():
        return {}
    try:
        import yaml
        return yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    except ImportError:
        # Fallback: just return the raw text info, no parsing
        return {"_raw": p.read_text(encoding="utf-8")}
    except Exception:
        return {}


def scan_all(schedule_path: str = None, now: datetime = None) -> dict:
    """Main entry point. Scan all sources, generate daily intel, return summary."""
    if now is None:
        now = datetime.now()
    if schedule_path is None:
        schedule_path = str(SHELTER / "cruz-schedule.yaml")

    schedule = _load_schedule(schedule_path)

    # a) Transcripts
    events = watch_transcripts()

    # b) Threads DB
    threads = scan_threads_db()

    # c) Gateway log
    gateway = scan_gateway_log()

    # d) Sessions
    sessions = scan_sessions()

    # e) Weather
    weather = scan_weather()

    # e2) World news
    news = scan_world_news()

    # f) Cruz rhythm
    rhythm = analyze_cruz_rhythm(now=now)

    # g) Priorities
    priorities = compute_priorities(threads=threads)

    # g2) ChatGPT exports
    chatgpt = scan_chatgpt_exports()

    # g3) Machine health (body narrative)
    body = scan_machine_health()

    # h) Generate daily intel (with priorities at top)
    generate_daily_intel(events, threads, gateway, sessions, schedule, now, weather, rhythm, priorities, news, chatgpt, body)

    # h) Hook health
    hook_health = scan_hook_health()

    return {
        "transcripts_count": len(events),
        "transcripts": events,
        "threads": threads,
        "gateway": gateway,
        "sessions": sessions,
        "weather": weather,
        "rhythm": rhythm,
        "priorities": priorities,
        "news": news,
        "hook_health": hook_health,
        "chatgpt_exports": chatgpt,
        "body": body,
        "generated_at": now.isoformat(),
    }


# ══════════════════════════════════════════════════════════════════
# i) scan_machine_health — Cruz 的 Mac 是一個身體
# ══════════════════════════════════════════════════════════════════

ANATOMY = {
    "brain":  {"name": "大腦",     "port": 11434, "alive": "清醒", "dead": "昏迷"},
    "heart":  {"name": "心臟",     "port": 18789, "alive": "在跳", "dead": "停了"},
    "eyes":   {"name": "眼睛",     "port": 9222,  "alive": "張開", "dead": "閉上"},
    "nerve1": {"name": "Andrew 神經", "port": 18795, "alive": "通", "dead": "斷"},
    "nerve2": {"name": "杜甫神經",    "port": 18796, "alive": "通", "dead": "斷"},
    "nerve3": {"name": "Eric 神經",   "port": 18797, "alive": "通", "dead": "斷"},
}

def scan_machine_health() -> dict:
    """Scan Cruz's Mac as a living body. Return organ status + narrative."""
    import socket

    organs = {}
    alive_count = 0
    total = len(ANATOMY)

    for key, organ in ANATOMY.items():
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(0.3)
            s.connect(("127.0.0.1", organ["port"]))
            s.close()
            organs[key] = {"status": "alive", "feeling": organ["alive"]}
            alive_count += 1
        except Exception:
            organs[key] = {"status": "dead", "feeling": organ["dead"]}

    # Check body temperature (CPU load)
    fever = ""
    try:
        load_1m = os.getloadavg()[0]
        if load_1m > 10:
            fever = " 在發高燒（CPU 過載）。"
        elif load_1m > 6:
            fever = " 體溫偏高。"
    except Exception:
        load_1m = 0

    # Build narrative
    if alive_count == total and not fever:
        narrative = "全身健康。大腦清醒，心臟在跳，眼睛張開，三條神經都在傳導。"
    elif alive_count == total:
        narrative = "器官都在跑。" + fever
    elif alive_count == 0:
        narrative = "全身停擺。"
    else:
        alive_parts = [ANATOMY[k]["name"] + organs[k]["feeling"] for k in organs if organs[k]["status"] == "alive"]
        dead_parts = [ANATOMY[k]["name"] + organs[k]["feeling"] for k in organs if organs[k]["status"] == "dead"]
        narrative = "、".join(alive_parts) + "。"
        if dead_parts:
            narrative += " 但" + "、".join(dead_parts) + "。"
        narrative += fever

    return {
        "organs": organs,
        "alive": alive_count,
        "total": total,
        "load": round(load_1m, 1),
        "narrative": narrative,
    }


def scan_hook_health() -> dict:
    """Check perception-dispatch hook log for errors and performance."""
    log_path = SHELTER / "data" / "hook-perception.jsonl"
    if not log_path.exists():
        return {"status": "no_log", "total": 0, "errors": 0}

    try:
        lines = log_path.read_text().splitlines()
        recent = lines[-100:]  # Last 100 executions

        total = len(recent)
        errors = sum(1 for l in recent if '"error"' in l and '"error": null' not in l)
        slow = 0
        total_ms = 0

        for line in recent:
            try:
                entry = json.loads(line)
                ms = entry.get("ms", 0)
                total_ms += ms
                if ms > 3000:  # >3 seconds is slow
                    slow += 1
            except Exception:
                continue

        avg_ms = round(total_ms / total) if total > 0 else 0
        error_rate = round(errors / total * 100) if total > 0 else 0

        return {
            "status": "degraded" if error_rate > 10 or slow > 5 else "ok",
            "total": total,
            "errors": errors,
            "error_rate_pct": error_rate,
            "slow": slow,
            "avg_ms": avg_ms,
        }
    except Exception:
        return {"status": "read_error", "total": 0, "errors": 0}
