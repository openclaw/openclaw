"""Hormone — 內分泌系統執行引擎

讀取 .hormone，評估 triggers，自動調節。
被 Sentinel 每 15 分鐘呼叫，或任何 session 手動呼叫。

Usage:
    from workspace.lib.hormone import evaluate_triggers, get_autonomy, is_suppressed, is_amplified

    # 在做任何動作前
    if is_suppressed("fb_new_groups"):
        skip()

    # 決定回覆層級
    level = get_autonomy("threads_reply", "A_pro")  # → "notify"

    # Sentinel 定期跑
    evaluate_triggers()  # 自動評估所有條件
"""
import json
import re
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

CLAWD = Path(__file__).parent.parent
HORMONE = CLAWD / ".hormone"
NERVE = CLAWD / ".nerve"
THREADS_DB = CLAWD / "tools" / "threads-reply" / "threads.db"
SOCIAL_DB = CLAWD / "tools" / "social-engine" / "social.db"
HORMONE_LOG = CLAWD / ".hormone-log"


def _read_hormone() -> str:
    if HORMONE.exists():
        return HORMONE.read_text()
    return ""


def _parse_yaml_value(text, key):
    """Quick regex parse for top-level YAML key."""
    m = re.search(rf'^{key}:\s*(.+)', text, re.M)
    return m.group(1).strip() if m else None


def _parse_list(text, section):
    """Parse a YAML list under a section."""
    pattern = rf'^{section}:\s*\n((?:\s+-\s+.+\n?)+)'
    m = re.search(pattern, text, re.M)
    if not m:
        return []
    return re.findall(r'^\s+-\s+(\S+)', m.group(1), re.M)


def get_season() -> str:
    return _parse_yaml_value(_read_hormone(), "season") or "rest"


def get_focus() -> str:
    return _parse_yaml_value(_read_hormone(), "focus") or ""


def get_ttl() -> datetime | None:
    v = _parse_yaml_value(_read_hormone(), "ttl")
    if v:
        try:
            return datetime.fromisoformat(v)
        except Exception:
            pass
    return None


def is_suppressed(action: str) -> bool:
    return action in _parse_list(_read_hormone(), "suppress")


def is_amplified(action: str) -> bool:
    return action in _parse_list(_read_hormone(), "amplify")


def get_autonomy(domain: str, tier: str = None) -> str:
    """Get autonomy level for a domain+tier.

    Returns: 'auto', 'notify', 'draft', 'approve', 'stop'
    """
    text = _read_hormone()

    # Find the autonomy section for this domain
    pattern = rf'^\s+{domain}:\s*\n((?:\s+\S+:.+\n?)+)'
    m = re.search(pattern, text, re.M)
    if not m:
        return "auto"

    block = m.group(1)

    if tier:
        # Look for specific tier
        tier_pattern = rf'^\s+{tier}:\s*(\S+)'
        tm = re.search(tier_pattern, block, re.M)
        if tm:
            return tm.group(1).strip()

    # Look for general level
    for line in block.strip().split('\n'):
        parts = line.strip().split(':')
        if len(parts) == 2:
            return parts[1].strip()

    return "auto"


def _pulse(what: str):
    """Write to nerve bus."""
    try:
        from workspace.lib.nerve import pulse
        pulse(what, who="hormone")
    except Exception:
        # Inline fallback
        data = {"ts": datetime.now().isoformat(), "entries": []}
        if NERVE.exists():
            try:
                data = json.loads(NERVE.read_text())
            except Exception:
                pass
        entries = data.get("entries", [])
        entries.append({"ts": datetime.now().isoformat(), "who": "hormone", "what": what})
        data["entries"] = entries[-20:]
        data["ts"] = datetime.now().isoformat()
        NERVE.write_text(json.dumps(data, ensure_ascii=False))


def _log(entry: dict):
    """Append to hormone log."""
    try:
        with open(HORMONE_LOG, "a") as f:
            f.write(json.dumps({"ts": datetime.now().isoformat(), **entry}, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _update_hormone(key: str, value: str):
    """Update a top-level key in .hormone."""
    text = _read_hormone()
    pattern = rf'^({key}:\s*).+$'
    new_text = re.sub(pattern, rf'\g<1>{value}', text, flags=re.M)
    HORMONE.write_text(new_text)


def _check_threads_spike() -> bool:
    """unreplied_to_us > 10 within 30m"""
    if not THREADS_DB.exists():
        return False
    try:
        conn = sqlite3.connect(f"file:{THREADS_DB}?mode=ro", uri=True, timeout=2)
        conn.row_factory = sqlite3.Row
        count = conn.execute('''
            SELECT COUNT(*) FROM comments c
            LEFT JOIN replies r ON c.comment_id = r.comment_id
            JOIN profiles p ON c.user_id = p.user_id
            WHERE r.reply_id IS NULL AND p.username != 'tangcruzz'
                  AND length(c.text_content) > 5
                  AND c.posted_at > datetime('now', '-30 minutes')
        ''').fetchone()[0]
        conn.close()
        return count > 10
    except Exception:
        return False


def _check_threads_cold() -> bool:
    """unreplied_to_us == 0 for 6h"""
    if not THREADS_DB.exists():
        return False
    try:
        conn = sqlite3.connect(f"file:{THREADS_DB}?mode=ro", uri=True, timeout=2)
        count = conn.execute('''
            SELECT COUNT(*) FROM comments c
            LEFT JOIN replies r ON c.comment_id = r.comment_id
            JOIN profiles p ON c.user_id = p.user_id
            WHERE r.reply_id IS NULL AND p.username != 'tangcruzz'
                  AND length(c.text_content) > 5
                  AND c.posted_at > datetime('now', '-6 hours')
        ''').fetchone()[0]
        conn.close()
        return count == 0
    except Exception:
        return False


def _check_coverage_drop() -> bool:
    """coverage_pct drops below 85"""
    if not THREADS_DB.exists():
        return False
    try:
        conn = sqlite3.connect(f"file:{THREADS_DB}?mode=ro", uri=True, timeout=2)
        sent = conn.execute('SELECT COUNT(*) FROM replies WHERE status="sent"').fetchone()[0]
        total = conn.execute(
            "SELECT COUNT(DISTINCT c.comment_id) FROM comments c "
            "JOIN profiles p ON c.user_id=p.user_id WHERE p.username != 'tangcruzz'"
        ).fetchone()[0]
        conn.close()
        if total == 0:
            return False
        return (sent / total * 100) < 85
    except Exception:
        return False


def _check_recruit_signal() -> bool:
    """New recruitment_signal in last hour."""
    if not SOCIAL_DB.exists():
        return False
    try:
        conn = sqlite3.connect(f"file:{SOCIAL_DB}?mode=ro", uri=True, timeout=2)
        # Check if any contact got a new recruitment signal recently
        # Simple heuristic: check if last_interaction is recent for contacts with signals
        count = conn.execute('''
            SELECT COUNT(*) FROM contacts
            WHERE recruitment_signal IS NOT NULL
                  AND last_interaction > datetime('now', '-1 hour')
        ''').fetchone()[0]
        conn.close()
        return count > 0
    except Exception:
        return False


def _check_ttl_expired() -> bool:
    ttl = get_ttl()
    if ttl and datetime.now() > ttl:
        return True
    return False


def _check_gateway_down() -> bool:
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(1)
        s.connect(("127.0.0.1", 18789))
        s.close()
        return False
    except Exception:
        return True


TRIGGER_CHECKS = {
    "threads_spike": {
        "check": _check_threads_spike,
        "action": lambda: (_update_hormone("season", "grow"), _pulse("threads spike → season:grow, all hands on deck")),
        "notify": True,
    },
    "threads_cold": {
        "check": _check_threads_cold,
        "action": lambda: _pulse("threads cold 6h — build don't patrol"),
        "notify": False,
    },
    "coverage_drop": {
        "check": _check_coverage_drop,
        "action": lambda: _pulse("coverage dropped below 85% — amplifying replies"),
        "notify": True,
    },
    "recruit_signal": {
        "check": _check_recruit_signal,
        "action": lambda: _pulse("new recruitment signal — notify Cruz"),
        "notify": True,
    },
    "ttl_expired": {
        "check": _check_ttl_expired,
        "action": lambda: _pulse("hormone TTL expired — Cruz 需要重新評估 season + focus"),
        "notify": True,
    },
    "gateway_down": {
        "check": _check_gateway_down,
        "action": lambda: (_repair_gateway(), _pulse("gateway down — auto repaired")),
        "notify": False,
    },
}


def _repair_gateway():
    """Auto-repair gateway via launchctl kickstart."""
    import subprocess
    try:
        uid = subprocess.run(["id", "-u"], capture_output=True, text=True).stdout.strip()
        subprocess.run(
            ["launchctl", "kickstart", "-k", f"gui/{uid}/ai.openclaw.gateway"],
            capture_output=True, timeout=15
        )
    except Exception:
        pass


def evaluate_triggers() -> list[str]:
    """Evaluate all trigger conditions. Returns list of fired trigger names."""
    fired = []

    for name, trigger in TRIGGER_CHECKS.items():
        try:
            if trigger["check"]():
                trigger["action"]()
                fired.append(name)
                _log({"trigger": name, "fired": True, "notify": trigger["notify"]})
        except Exception as e:
            _log({"trigger": name, "error": str(e)})

    if fired:
        _pulse(f"triggers fired: {', '.join(fired)}")

    return fired


if __name__ == "__main__":
    print(f"Season: {get_season()}")
    print(f"Focus: {get_focus()}")
    print(f"TTL: {get_ttl()}")
    print(f"Suppressed: {_parse_list(_read_hormone(), 'suppress')}")
    print(f"Amplified: {_parse_list(_read_hormone(), 'amplify')}")
    print()
    print("Evaluating triggers...")
    fired = evaluate_triggers()
    if fired:
        print(f"  FIRED: {fired}")
    else:
        print("  All clear.")
