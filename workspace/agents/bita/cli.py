"""
bita CLI — knowledge base + escalation commands.
"""

import os
import subprocess
from pathlib import Path

BITA_WS = Path(__file__).resolve().parent
KB_DIR = BITA_WS / "knowledge"


# ── kb ──────────────────────────────────────────────────────────────

def kb_search(agent, args):
    """Grep-search knowledge base .md files."""
    if not args:
        print("  usage: wuji bita kb search <query>")
        return
    query = args[0]

    if not KB_DIR.exists():
        print(f"  knowledge/ not found at {KB_DIR}")
        return

    found = False
    for md in sorted(KB_DIR.glob("*.md")):
        lines = md.read_text().splitlines()
        matches = [(i + 1, line) for i, line in enumerate(lines) if query.lower() in line.lower()]
        if matches:
            found = True
            print(f"\n  ── {md.name} ──")
            for lineno, line in matches:
                print(f"  {lineno:4d}: {line}")

    if not found:
        print(f"  No matches for '{query}' in knowledge/")


def kb_list(agent, args):
    """List knowledge base files."""
    if not KB_DIR.exists():
        print(f"  knowledge/ not found at {KB_DIR}")
        return

    files = sorted(KB_DIR.glob("*.md"))
    if not files:
        print("  (no .md files in knowledge/)")
        return

    for f in files:
        size = f.stat().st_size
        print(f"  {f.name:<30s} {size:>7,} bytes")
    print(f"\n  {len(files)} files")


# ── escalation ──────────────────────────────────────────────────────

def escalation_show(agent, args):
    """Show escalation process from knowledge/escalation.md."""
    esc = KB_DIR / "escalation.md"
    if not esc.exists():
        print(f"  escalation.md not found in {KB_DIR}")
        return
    print(esc.read_text())


# ── COMMANDS registry ───────────────────────────────────────────────

COMMANDS = {
    "kb": {
        "search": kb_search,
        "list": kb_list,
    },
    "escalation": escalation_show,
}
