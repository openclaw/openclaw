"""Nerve — shared activity bus for cross-session awareness.

Any session writes here after significant actions.
The perception hook reads it and injects into all sessions.

Usage:
    from workspace.lib.nerve import pulse
    pulse("built social engine core")
    pulse("repaired gateway", who="sentinel")
    pulse("scanning 軍事茶館", who="loop-fb")
"""
import json
import os
from datetime import datetime
from pathlib import Path

NERVE = Path(__file__).parent.parent / ".nerve"
MAX_ENTRIES = 20


def pulse(what: str, who: str = None):
    """Write an activity pulse to the nerve bus."""
    if not who:
        who = f"s{os.getpid()}"

    entry = {
        "ts": datetime.now().isoformat(),
        "who": who,
        "what": what,
    }

    data = {"ts": datetime.now().isoformat(), "entries": []}
    if NERVE.exists():
        try:
            data = json.loads(NERVE.read_text())
        except Exception:
            pass

    entries = data.get("entries", [])
    entries.append(entry)
    # Keep only last MAX_ENTRIES
    data["entries"] = entries[-MAX_ENTRIES:]
    data["ts"] = datetime.now().isoformat()

    NERVE.write_text(json.dumps(data, ensure_ascii=False))


def read_recent(minutes=10):
    """Read recent pulses."""
    if not NERVE.exists():
        return []
    try:
        data = json.loads(NERVE.read_text())
        now = datetime.now()
        return [
            e for e in data.get("entries", [])
            if (now - datetime.fromisoformat(e["ts"])).total_seconds() < minutes * 60
        ]
    except Exception:
        return []
