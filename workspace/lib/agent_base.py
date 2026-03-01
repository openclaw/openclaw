"""
agent_base.py — 5 generic commands available to all agents.

Commands: status, files, read, log, config
"""

import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

OPENCLAW_CONFIG = os.path.expanduser("~/.openclaw/openclaw.json")
WORKSPACE_ROOT = Path(__file__).resolve().parent.parent  # workspace/


def _load_openclaw():
    with open(OPENCLAW_CONFIG) as f:
        return json.load(f)


def _find_agent(agent_id):
    """Return agent dict from openclaw.json, or synthesize one from filesystem."""
    cfg = _load_openclaw()
    for a in cfg.get("agents", {}).get("list", []):
        if a["id"] == agent_id:
            return a

    # Not in config — try filesystem discovery
    candidates = [
        WORKSPACE_ROOT / "agents" / agent_id,
        WORKSPACE_ROOT / agent_id,
    ]
    for p in candidates:
        if p.is_dir():
            return {"id": agent_id, "workspace": str(p)}
    return None


def _workspace_path(agent):
    ws = agent.get("workspace")
    if ws:
        return Path(ws)
    return WORKSPACE_ROOT / "agents" / agent["id"]


def _bindings_for(agent_id):
    cfg = _load_openclaw()
    return [b for b in cfg.get("bindings", []) if b.get("agentId") == agent_id]


# ── status ──────────────────────────────────────────────────────────

def cmd_status(agent, args):
    """Workspace overview: file count, size, last modified, model, routing."""
    ws = _workspace_path(agent)
    if not ws.exists():
        print(f"  workspace not found: {ws}")
        return

    all_files = list(ws.rglob("*"))
    files_only = [f for f in all_files if f.is_file()]
    total_size = sum(f.stat().st_size for f in files_only)

    newest = None
    if files_only:
        newest = max(files_only, key=lambda f: f.stat().st_mtime)

    bindings = _bindings_for(agent["id"])
    groups = [b["match"]["peer"]["id"] for b in bindings if "peer" in b.get("match", {})]

    model = agent.get("model", {}).get("primary", "default")

    print(f"  Agent:    {agent['id']}")
    print(f"  Model:    {model}")
    print(f"  Workspace: {ws}")
    print(f"  Files:    {len(files_only)}")
    print(f"  Size:     {total_size / 1024:.0f} KB")
    if newest:
        mtime = datetime.fromtimestamp(newest.stat().st_mtime)
        print(f"  Modified: {mtime:%Y-%m-%d %H:%M}  ({newest.name})")
    if groups:
        print(f"  Groups:   {len(groups)}  {', '.join(groups[:3])}{'...' if len(groups) > 3 else ''}")


# ── files ───────────────────────────────────────────────────────────

def cmd_files(agent, args):
    """List workspace files sorted by modification time."""
    ws = _workspace_path(agent)
    if not ws.exists():
        print(f"  workspace not found: {ws}")
        return

    files = [f for f in ws.rglob("*") if f.is_file()]
    files.sort(key=lambda f: f.stat().st_mtime, reverse=True)

    limit = 30
    if args:
        try:
            limit = int(args[0])
        except ValueError:
            pass

    for f in files[:limit]:
        mtime = datetime.fromtimestamp(f.stat().st_mtime)
        rel = f.relative_to(ws)
        size = f.stat().st_size
        print(f"  {mtime:%m-%d %H:%M}  {size:>7,}  {rel}")

    if len(files) > limit:
        print(f"  ... and {len(files) - limit} more (use: wuji {agent['id']} files {limit + 30})")


# ── read ────────────────────────────────────────────────────────────

def cmd_read(agent, args):
    """Read a file from the workspace (relative path)."""
    if not args:
        print("  usage: wuji <agent> read <file>")
        return

    ws = _workspace_path(agent)
    target = ws / args[0]

    # Also try with .md extension
    if not target.exists() and not target.suffix:
        target_md = target.with_suffix(".md")
        if target_md.exists():
            target = target_md

    if not target.exists():
        print(f"  not found: {target.relative_to(ws)}")
        # Suggest similar files
        stem = args[0].lower()
        matches = [f for f in ws.rglob("*") if f.is_file() and stem in f.name.lower()]
        if matches:
            print("  did you mean:")
            for m in matches[:5]:
                print(f"    {m.relative_to(ws)}")
        return

    print(target.read_text())


# ── log ─────────────────────────────────────────────────────────────

def cmd_log(agent, args):
    """Recent file changes in workspace (by mtime)."""
    ws = _workspace_path(agent)
    if not ws.exists():
        print(f"  workspace not found: {ws}")
        return

    n = 10
    if args:
        try:
            n = int(args[0])
        except ValueError:
            pass

    files = [f for f in ws.rglob("*") if f.is_file()]
    files.sort(key=lambda f: f.stat().st_mtime, reverse=True)

    for f in files[:n]:
        mtime = datetime.fromtimestamp(f.stat().st_mtime)
        rel = f.relative_to(ws)
        print(f"  {mtime:%Y-%m-%d %H:%M:%S}  {rel}")


# ── config ──────────────────────────────────────────────────────────

def cmd_config(agent, args):
    """Show AGENTS.md summary and routing config."""
    ws = _workspace_path(agent)
    agents_md = ws / "AGENTS.md"

    # Show model + bindings
    model = agent.get("model", {}).get("primary", "default")
    bindings = _bindings_for(agent["id"])
    print(f"  Model:    {model}")
    print(f"  Bindings: {len(bindings)}")
    for b in bindings:
        ch = b.get("match", {}).get("channel", "?")
        peer = b.get("match", {}).get("peer", {})
        print(f"    {ch} → {peer.get('kind', '?')} {peer.get('id', '?')}")

    if not agents_md.exists():
        print(f"\n  (no AGENTS.md in {ws})")
        return

    # Parse AGENTS.md — show first 30 lines as summary
    print(f"\n  ── AGENTS.md ──")
    lines = agents_md.read_text().splitlines()
    for line in lines[:30]:
        print(f"  {line}")
    if len(lines) > 30:
        print(f"  ... ({len(lines)} lines total)")


# ── registry ────────────────────────────────────────────────────────

GENERIC_COMMANDS = {
    "status": cmd_status,
    "files": cmd_files,
    "read": cmd_read,
    "log": cmd_log,
    "config": cmd_config,
}


def run_generic(agent, command, args):
    """Run a generic command. Returns True if handled."""
    fn = GENERIC_COMMANDS.get(command)
    if fn:
        fn(agent, args)
        return True
    return False


def print_agent_help(agent, extra_commands=None):
    """Print help for an agent."""
    print(f"\n  wuji {agent['id']} <command>\n")
    print("  Generic commands:")
    for name, fn in GENERIC_COMMANDS.items():
        doc = (fn.__doc__ or "").strip().split("\n")[0]
        print(f"    {name:12s} {doc}")
    if extra_commands:
        print("\n  Agent-specific commands:")
        _print_command_tree(extra_commands, indent=4)
    print()


def _print_command_tree(commands, indent=4, prefix=""):
    """Recursively print command tree."""
    pad = " " * indent
    for name, val in commands.items():
        if isinstance(val, dict):
            print(f"{pad}{prefix}{name}")
            _print_command_tree(val, indent + 2, prefix="")
        elif callable(val):
            doc = (val.__doc__ or "").strip().split("\n")[0]
            print(f"{pad}{prefix}{name:12s} {doc}")
