"""
meihui CLI — wisdom + health commands.
"""

import os
import subprocess
import sys
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parent.parent  # workspace/
WISDOM_ENGINE = WORKSPACE / "wisdom-engine"
MEIHUI_WS = Path(__file__).resolve().parent


# ── wisdom ──────────────────────────────────────────────────────────

def wisdom_search(agent, args):
    """Search wisdom cards (delegates to search_wisdom)."""
    if not args:
        print("  usage: wuji meihui wisdom search <query>")
        return
    query = args[0]
    cmd = [
        sys.executable, str(WISDOM_ENGINE / "search_wisdom"),
        query, "--user", "meihui", "--scene", "E",
    ]
    # Pass through extra flags
    cmd.extend(args[1:])
    subprocess.run(cmd, cwd=str(WISDOM_ENGINE))


def wisdom_stats(agent, args):
    """Show wisdom card statistics."""
    cmd = [
        sys.executable, str(WISDOM_ENGINE / "search_wisdom"),
        "--stats", "--user", "meihui",
    ]
    subprocess.run(cmd, cwd=str(WISDOM_ENGINE))


def wisdom_cards(agent, args):
    """List all wisdom cards."""
    cmd = [
        sys.executable, str(WISDOM_ENGINE / "search_wisdom"),
        "--list", "--user", "meihui",
    ]
    subprocess.run(cmd, cwd=str(WISDOM_ENGINE))


def wisdom_ingest(agent, args):
    """Ingest new source articles."""
    generate = WISDOM_ENGINE / "generate_cards"
    if not generate.exists():
        print(f"  generate_cards not found at {generate}")
        return
    cmd = [sys.executable, str(generate), "--user", "meihui"]
    if args and args[0] == "--dry-run":
        cmd.append("--dry-run")
    subprocess.run(cmd, cwd=str(WISDOM_ENGINE))


# ── health ──────────────────────────────────────────────────────────

def health_summary(agent, args):
    """Show health profile summary (latest weight, recent records)."""
    profile = MEIHUI_WS / "health-profile.md"
    log = MEIHUI_WS / "health-log.md"

    if profile.exists():
        lines = profile.read_text().splitlines()
        print("  ── health-profile.md ──")
        # Show basic data section (first ~20 lines)
        for line in lines[:20]:
            print(f"  {line}")
        if len(lines) > 20:
            print(f"  ... ({len(lines)} lines total)")

    if log.exists():
        lines = log.read_text().splitlines()
        print("\n  ── health-log.md (last 15 lines) ──")
        for line in lines[-15:]:
            print(f"  {line}")


# ── COMMANDS registry ───────────────────────────────────────────────

COMMANDS = {
    "wisdom": {
        "search": wisdom_search,
        "stats": wisdom_stats,
        "cards": wisdom_cards,
        "ingest": wisdom_ingest,
    },
    "health": health_summary,
}
