"""
xo CLI — query commands.
"""

import subprocess
import sys
from pathlib import Path

XO_WS = Path(__file__).resolve().parent
WORKSPACE = XO_WS.parent.parent  # workspace/
QUERY_RUNNER = WORKSPACE / "agents" / "vivi-tutor" / "query-runner.py"


# ── query ───────────────────────────────────────────────────────────

def query_cmd(agent, args):
    """Delegate to query-runner.py (bg666/matomo SQL queries)."""
    if not args:
        print("  usage: wuji xo query <bg666|matomo> <SQL>")
        print("  examples:")
        print('    wuji xo query bg666 "SELECT COUNT(*) FROM sys_player"')
        return

    if not QUERY_RUNNER.exists():
        print(f"  query-runner.py not found at {QUERY_RUNNER}")
        return

    cmd = [sys.executable, str(QUERY_RUNNER)] + list(args)
    subprocess.run(cmd, cwd=str(QUERY_RUNNER.parent))


# ── COMMANDS registry ───────────────────────────────────────────────

COMMANDS = {
    "query": query_cmd,
}
