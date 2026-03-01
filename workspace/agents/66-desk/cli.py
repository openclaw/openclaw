"""
66-desk CLI — sheets, query, project, report, track commands.

Layer 0: 能看 + 能跑
  project  — 瀏覽 ~/Documents/two
  report   — 日報/小時報 生成
  track    — P0/P1/P2/紅人 追蹤
  generate — P0 名單生成
  health   — 部署健康度檢查
"""

import os
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

DESK_WS = Path(__file__).resolve().parent
WORKSPACE = DESK_WS.parent.parent  # workspace/
SHEETS_RUNNER = DESK_WS / "sheets-runner.py"
QUERY_RUNNER = WORKSPACE / "agents" / "vivi-tutor" / "query-runner.py"
PROJECT_DIR = Path(os.path.expanduser("~/Documents/two"))

# Script paths in ~/Documents/two
DAILY_REPORT = PROJECT_DIR / "mcp-telegram" / "pipeline" / "daily_report_v2" / "run.py"
HOURLY_REPORT = PROJECT_DIR / "mcp-telegram" / "pipeline" / "hourly_report.py"
P0_GENERATE = PROJECT_DIR / "scripts" / "generate_p0_list.py"
P0_TRACK = PROJECT_DIR / "scripts" / "p0_tracking_v2.py"
PX_TRACK = PROJECT_DIR / "scripts" / "px_tracking_v4.py"
RED_REPORTS = PROJECT_DIR / "scripts" / "red_reports_generator.py"
HEALTH_CHECK = PROJECT_DIR / "deployment-health-check.sh"
WEEKLY_REPORT = PROJECT_DIR / "weekly_report" / "generate_pdf.py"


# ── sheets ──────────────────────────────────────────────────────────

def sheets_cmd(agent, args):
    """Delegate to sheets-runner.py (read, update, batch-update, find, append)."""
    if not args:
        print("  usage: wuji 66-desk sheets <read|update|find|append> [args...]")
        print("  examples:")
        print('    wuji 66-desk sheets read "A1:J10"')
        print('    wuji 66-desk sheets update "D3" "100%"')
        print('    wuji 66-desk sheets find "杜甫"')
        return

    if not SHEETS_RUNNER.exists():
        print(f"  sheets-runner.py not found at {SHEETS_RUNNER}")
        return

    cmd = [sys.executable, str(SHEETS_RUNNER)] + list(args)
    subprocess.run(cmd, cwd=str(DESK_WS))


# ── query ───────────────────────────────────────────────────────────

def query_cmd(agent, args):
    """Delegate to query-runner.py (bg666/matomo SQL queries)."""
    if not args:
        print("  usage: wuji 66-desk query <bg666|matomo> <SQL>")
        print("  examples:")
        print('    wuji 66-desk query bg666 "SELECT COUNT(*) FROM sys_player"')
        print('    wuji 66-desk query bg666 "SELECT ..." --format table')
        return

    if not QUERY_RUNNER.exists():
        print(f"  query-runner.py not found at {QUERY_RUNNER}")
        return

    cmd = [sys.executable, str(QUERY_RUNNER)] + list(args)
    subprocess.run(cmd, cwd=str(QUERY_RUNNER.parent))


# ── project (~/Documents/two) ──────────────────────────────────────

def _project_check():
    if not PROJECT_DIR.exists():
        print(f"  project dir not found: {PROJECT_DIR}")
        return False
    return True


def project_cmd(agent, args):
    """Browse ~/Documents/two — BG666 work project."""
    if not args:
        # Default: show overview
        project_status(agent, args)
        return

    sub = args[0]
    rest = args[1:]
    subs = {
        "status": project_status,
        "files": project_files,
        "scripts": project_scripts,
        "data": project_data,
        "read": project_read,
        "log": project_log,
    }
    fn = subs.get(sub)
    if fn:
        fn(agent, rest)
    else:
        print(f"  unknown: project {sub}")
        print("  subcommands: status, files, scripts, data, read, log")


def project_status(agent, args):
    """Overview of ~/Documents/two — file count, size, recent changes."""
    if not _project_check():
        return

    # Top-level dirs
    dirs = sorted([d.name for d in PROJECT_DIR.iterdir() if d.is_dir()])
    top_files = sorted([f.name for f in PROJECT_DIR.iterdir() if f.is_file()])

    # Count all files
    all_files = list(PROJECT_DIR.rglob("*"))
    files_only = [f for f in all_files if f.is_file()]
    total_size = sum(f.stat().st_size for f in files_only)

    # Recent files
    files_only.sort(key=lambda f: f.stat().st_mtime, reverse=True)

    print(f"  Project:  ~/Documents/two (BG666 work)")
    print(f"  Files:    {len(files_only)}")
    print(f"  Size:     {total_size / 1024 / 1024:.1f} MB")
    print(f"  Dirs:     {', '.join(dirs)}")
    print(f"\n  Recent changes:")
    for f in files_only[:8]:
        mtime = datetime.fromtimestamp(f.stat().st_mtime)
        try:
            rel = f.relative_to(PROJECT_DIR)
        except ValueError:
            rel = f.name
        print(f"    {mtime:%m-%d %H:%M}  {rel}")


def project_files(agent, args):
    """List top-level files in ~/Documents/two."""
    if not _project_check():
        return

    target = PROJECT_DIR
    if args:
        target = PROJECT_DIR / args[0]
        if not target.exists():
            print(f"  not found: {args[0]}")
            return

    items = sorted(target.iterdir(), key=lambda f: f.stat().st_mtime, reverse=True)
    for item in items:
        mtime = datetime.fromtimestamp(item.stat().st_mtime)
        kind = "d" if item.is_dir() else " "
        size = ""
        if item.is_file():
            size = f"{item.stat().st_size:>9,}"
        else:
            n = len(list(item.rglob("*")))
            size = f"({n} items)"
        print(f"  {kind} {mtime:%m-%d %H:%M}  {size:>12}  {item.name}")


def project_scripts(agent, args):
    """List analysis scripts in ~/Documents/two/scripts/."""
    if not _project_check():
        return

    scripts_dir = PROJECT_DIR / "scripts"
    if not scripts_dir.exists():
        print("  scripts/ not found")
        return

    scripts = sorted(scripts_dir.glob("*.py"))
    print(f"  ── scripts/ ({len(scripts)} .py files) ──")
    for s in scripts:
        # Read first docstring line if available
        desc = ""
        try:
            text = s.read_text()
            for line in text.splitlines()[1:10]:
                stripped = line.strip().strip('"').strip("'").strip()
                if stripped and not stripped.startswith("#") and not stripped.startswith("import"):
                    desc = stripped[:60]
                    break
        except Exception:
            pass
        print(f"    {s.name:<40s} {desc}")

    # Also show top-level .py files
    top_py = sorted(PROJECT_DIR.glob("*.py"))
    if top_py:
        print(f"\n  ── top-level ({len(top_py)} .py files) ──")
        for s in top_py:
            print(f"    {s.name}")


def project_data(agent, args):
    """List data subdirectories and their contents."""
    if not _project_check():
        return

    data_dir = PROJECT_DIR / "data"
    if not data_dir.exists():
        print("  data/ not found")
        return

    for d in sorted(data_dir.iterdir()):
        if d.is_dir():
            files = list(d.rglob("*"))
            file_count = len([f for f in files if f.is_file()])
            print(f"  {d.name:<25s} {file_count} files")
        elif d.is_file():
            print(f"  {d.name:<25s} {d.stat().st_size:,} bytes")


def project_read(agent, args):
    """Read a file from ~/Documents/two (relative path)."""
    if not args:
        print("  usage: wuji 66-desk project read <file>")
        return
    if not _project_check():
        return

    target = PROJECT_DIR / args[0]
    if not target.exists() and not target.suffix:
        for ext in [".md", ".py", ".sql", ".html"]:
            candidate = target.with_suffix(ext)
            if candidate.exists():
                target = candidate
                break

    if not target.exists():
        print(f"  not found: {args[0]}")
        stem = args[0].lower()
        matches = [f for f in PROJECT_DIR.rglob("*") if f.is_file() and stem in f.name.lower()]
        if matches:
            print("  did you mean:")
            for m in matches[:5]:
                print(f"    {m.relative_to(PROJECT_DIR)}")
        return

    print(target.read_text())


def project_log(agent, args):
    """Recent file changes in ~/Documents/two (by mtime)."""
    if not _project_check():
        return

    n = 15
    if args:
        try:
            n = int(args[0])
        except ValueError:
            pass

    files = [f for f in PROJECT_DIR.rglob("*") if f.is_file()
             and "node_modules" not in str(f) and "__pycache__" not in str(f)]
    files.sort(key=lambda f: f.stat().st_mtime, reverse=True)

    for f in files[:n]:
        mtime = datetime.fromtimestamp(f.stat().st_mtime)
        rel = f.relative_to(PROJECT_DIR)
        print(f"  {mtime:%Y-%m-%d %H:%M}  {rel}")


# ── report ──────────────────────────────────────────────────────────

def _run_script(script, args, cwd=None, label=None):
    """Run a Python script with args, printing header."""
    if not script.exists():
        print(f"  script not found: {script}")
        return False
    if label:
        print(f"  ── {label} ──")
    cmd = [sys.executable, str(script)] + list(args)
    result = subprocess.run(cmd, cwd=str(cwd or script.parent))
    return result.returncode == 0


def report_cmd(agent, args):
    """Generate reports (daily, hourly, weekly)."""
    if not args:
        print("  usage: wuji 66-desk report <daily|hourly|weekly> [options]")
        print()
        print("  daily                  Generate yesterday's daily report")
        print("  daily 2026-02-27       Generate for specific date")
        print("  daily --dry-run        Generate without sending to Telegram")
        print("  hourly                 Generate current hourly snapshot")
        print("  weekly                 Generate weekly PDF")
        return

    sub = args[0]
    rest = args[1:]

    if sub == "daily":
        _run_script(DAILY_REPORT, rest, label="Daily Report")
    elif sub == "hourly":
        _run_script(HOURLY_REPORT, rest, label="Hourly Report")
    elif sub == "weekly":
        _run_script(WEEKLY_REPORT, rest, label="Weekly Report")
    else:
        print(f"  unknown report type: {sub}")
        print("  available: daily, hourly, weekly")


# ── track ───────────────────────────────────────────────────────────

def track_cmd(agent, args):
    """Run campaign tracking (p0, p1, p2, red)."""
    if not args:
        print("  usage: wuji 66-desk track <p0|px|red> [options]")
        print()
        print("  p0                     P0 campaign tracking (大R, 首充, 充值失敗)")
        print("  px                     P1/P2 campaign tracking (8 groups)")
        print("  px --groups P1-1,P1-2  Track specific groups only")
        print("  red <ids_file>         Red member reports (4 reports)")
        return

    sub = args[0]
    rest = args[1:]

    if sub == "p0":
        _run_script(P0_TRACK, rest, label="P0 Tracking")
    elif sub in ("px", "p1", "p2"):
        _run_script(PX_TRACK, rest, label="P1/P2 Tracking")
    elif sub == "red":
        _run_script(RED_REPORTS, rest, label="Red Member Reports")
    else:
        print(f"  unknown track type: {sub}")
        print("  available: p0, px, red")


# ── generate ────────────────────────────────────────────────────────

def generate_cmd(agent, args):
    """Generate campaign lists (P0 player lists)."""
    if not args:
        print("  usage: wuji 66-desk generate p0 [options]")
        print()
        print("  p0 --date 2026-02-27                  Generate P0 lists for date")
        print("  p0 --date 2026-02-27 --output-dir DIR  Custom output directory")
        return

    sub = args[0]
    rest = args[1:]

    if sub == "p0":
        _run_script(P0_GENERATE, rest, label="Generate P0 Lists")
    else:
        print(f"  unknown: generate {sub}")
        print("  available: p0")


# ── health ──────────────────────────────────────────────────────────

def health_cmd(agent, args):
    """Run deployment health check (scores system readiness)."""
    if not HEALTH_CHECK.exists():
        print(f"  health check not found: {HEALTH_CHECK}")
        return
    subprocess.run(["bash", str(HEALTH_CHECK)], cwd=str(PROJECT_DIR))


# ── COMMANDS registry ───────────────────────────────────────────────

COMMANDS = {
    "sheets": sheets_cmd,
    "query": query_cmd,
    "project": project_cmd,
    "report": report_cmd,
    "track": track_cmd,
    "generate": generate_cmd,
    "health": health_cmd,
}
