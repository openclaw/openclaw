"""
agent_base.py — generic commands + dashboard panels + cross-agent intelligence helpers.

Commands: status, files, read, log, config, exp, dashboard
Cross-agent: cross_agent_recent(), parse_tasks_md()
"""

import importlib.util
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

OPENCLAW_CONFIG = os.path.expanduser("~/.openclaw/openclaw.json")
SENTINEL_CONFIG = Path(__file__).resolve().parent.parent.parent / "sentinel" / "config.json"
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


# ── cross-agent intelligence ────────────────────────────────────────


def cross_agent_recent(agents, hours=24):
    """Scan all agent workspaces for recently modified files.

    Returns list of (datetime, agent_id, relative_path) sorted newest first.
    """
    cutoff = datetime.now() - timedelta(hours=hours)
    results = []

    for aid, agent in agents.items():
        ws = _workspace_path(agent)
        if not ws.exists():
            continue
        try:
            for f in ws.rglob("*"):
                if not f.is_file():
                    continue
                # Skip hidden dirs, __pycache__, .git
                parts = f.relative_to(ws).parts
                if any(p.startswith(".") or p == "__pycache__" for p in parts):
                    continue
                try:
                    mtime = datetime.fromtimestamp(f.stat().st_mtime)
                except OSError:
                    continue
                if mtime >= cutoff:
                    results.append((mtime, aid, str(f.relative_to(ws))))
        except Exception:
            continue

    results.sort(key=lambda x: x[0], reverse=True)
    return results


def parse_tasks_md(path=None):
    """Parse workspace/TASKS.md into structured data.

    Returns dict with keys: 'pending', 'in_progress', 'completed', 'waiting'.
    Each value is a list of dicts: {priority, text, assignee, extra}.
    """
    if path is None:
        path = WORKSPACE_ROOT / "TASKS.md"
    if not path.exists():
        return {"pending": [], "in_progress": [], "completed": [], "waiting": []}

    text = path.read_text()
    result = {"pending": [], "in_progress": [], "completed": [], "waiting": []}

    section = None
    section_map = {
        "待辦": "pending",
        "進行中": "in_progress",
        "完成": "completed",
    }

    # Priority pattern: [P0], [P1], [P2], [P3]
    prio_re = re.compile(r"\[P(\d)\]")

    for line in text.splitlines():
        line_stripped = line.strip()

        # Detect section headers
        if line_stripped.startswith("## "):
            heading = line_stripped[3:].strip()
            section = section_map.get(heading)
            continue

        if section is None:
            continue

        # Parse task lines: - [ ] or - [-] or - [x]
        task_match = re.match(r"^-\s*\[([ x\-])\]\s*(.*)", line_stripped)
        if not task_match:
            continue

        marker = task_match.group(1)
        body = task_match.group(2)

        prio_match = prio_re.search(body)
        priority = int(prio_match.group(1)) if prio_match else 9

        # Extract assignee
        assignee = ""
        assignee_match = re.search(r"指派：([^\s—]+)", body)
        if assignee_match:
            assignee = assignee_match.group(1)

        task = {
            "priority": priority,
            "text": body,
            "assignee": assignee,
            "marker": marker,
        }

        if marker == "x":
            result["completed"].append(task)
        elif marker == "-":
            result["in_progress"].append(task)
        elif "blocked" in body.lower() or "待" in body and "期限" not in body:
            result["waiting"].append(task)
        else:
            result["pending"].append(task)

    return result


# ── exp (experience memory) ────────────────────────────────────────

def cmd_exp(agent, args):
    """Search experience memory for an agent context."""
    query = " ".join(args) if args else ""
    if not query:
        print("  usage: wuji <agent> exp <query>")
        return

    bridge = WORKSPACE_ROOT / "scripts" / "exp-bridge.py"
    if not bridge.exists():
        print("  exp-bridge.py not found")
        return

    try:
        result = subprocess.run(
            [sys.executable, str(bridge), "search", query],
            capture_output=True, text=True, timeout=15
        )
        print(result.stdout)
        if result.stderr.strip():
            print(result.stderr, file=sys.stderr)
    except Exception as e:
        print(f"  error: {e}")


# ── inject (context sync) ─────────────────────────────────────────

def cmd_inject(agent, args):
    """Inject context into agent memory (for actions done on agent's behalf)."""
    if not args:
        print("  usage: wuji <agent> inject <message>")
        print("         wuji <agent> inject --file <path>")
        print("         wuji <agent> inject --live <message>  (also notify gateway)")
        return

    live = False
    file_mode = False
    message_parts = []

    i = 0
    while i < len(args):
        if args[i] == "--live":
            live = True
        elif args[i] == "--file":
            file_mode = True
            i += 1
            if i < len(args):
                fpath = Path(args[i])
                if fpath.exists():
                    message_parts.append(fpath.read_text().strip())
                else:
                    print(f"  file not found: {fpath}")
                    return
        else:
            message_parts.append(args[i])
        i += 1

    message = " ".join(message_parts) if not file_mode else "\n".join(message_parts)
    if not message:
        print("  empty message, nothing to inject")
        return

    # ── Step 1: Write to agent's daily memory file ──
    ws = _workspace_path(agent)
    memory_dir = ws / "memory"
    memory_dir.mkdir(exist_ok=True)

    today = datetime.now().strftime("%Y-%m-%d")
    memory_file = memory_dir / f"{today}.md"
    ts = datetime.now().strftime("%H:%M")

    entry = f"\n\n## 系統注入 ({ts})\n{message}\n"

    if memory_file.exists():
        with open(memory_file, "a") as f:
            f.write(entry)
    else:
        with open(memory_file, "w") as f:
            f.write(f"# {today} 記憶記錄\n{entry}")

    print(f"  written to {memory_file.relative_to(ws)}")

    # ── Step 2: If --live, notify gateway via webhook ──
    if live:
        _inject_via_gateway(agent, message)


def _inject_via_gateway(agent, message):
    """POST to /hooks/agent to inject context into live session."""
    import urllib.request
    import urllib.error

    try:
        cfg = _load_openclaw()
    except Exception:
        print("  gateway: cannot read openclaw.json")
        return

    # Get gateway token
    hooks_cfg = cfg.get("hooks", {})
    token = hooks_cfg.get("token", "")
    if not token:
        # Try gateway token
        token = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "")
    if not token:
        gw_cfg = cfg.get("gateway", {})
        token = gw_cfg.get("token", "")

    if not token:
        print("  gateway: no hooks/gateway token found, skipping live inject")
        return

    # Build webhook payload
    payload = json.dumps({
        "agentId": agent["id"],
        "message": f"[系統上下文注入] 以下是你先前代為執行的操作記錄，請記住這個上下文：\n\n{message}",
    }).encode()

    url = "http://127.0.0.1:18789/hooks/agent"
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read())
            if result.get("ok") or resp.status < 300:
                print(f"  gateway: injected into live session")
            else:
                print(f"  gateway: {result}")
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:200]
        print(f"  gateway: {e.code} {body}")
    except Exception as e:
        print(f"  gateway: {e}")


# ── dashboard panels ───────────────────────────────────────────────


def _panel_workspace(agent, args):
    """Workspace overview: files, size, recent changes, model, groups."""
    ws = _workspace_path(agent)
    if not ws.exists():
        return [f"workspace not found: {ws}"]

    all_files = [f for f in ws.rglob("*") if f.is_file()
                 and not any(p.startswith(".") or p == "__pycache__"
                             for p in f.relative_to(ws).parts)]
    total_size = sum(f.stat().st_size for f in all_files)

    lines = [
        f"Files: {len(all_files)}   Size: {total_size / 1024:.0f} KB",
    ]

    model = agent.get("model", {}).get("primary", "default")
    lines.append(f"Model: {model}")

    bindings = _bindings_for(agent["id"])
    groups = [b["match"]["peer"]["id"] for b in bindings if "peer" in b.get("match", {})]
    if groups:
        lines.append(f"Groups: {len(groups)}")

    # Recent 5 files
    if all_files:
        all_files.sort(key=lambda f: f.stat().st_mtime, reverse=True)
        lines.append("")
        lines.append("Recent:")
        for f in all_files[:5]:
            mtime = datetime.fromtimestamp(f.stat().st_mtime)
            rel = f.relative_to(ws)
            lines.append(f"  {mtime:%m-%d %H:%M}  {rel}")

    return lines


def _panel_groups(agent, args):
    """Telegram groups bound to this agent."""
    lines = []
    try:
        with open(SENTINEL_CONFIG) as f:
            sentinel_cfg = json.load(f)
        groups = sentinel_cfg.get("groups", {})
    except Exception:
        groups = {}

    agent_groups = {gid: g for gid, g in groups.items()
                    if g.get("agent_id") == agent["id"]}

    if not agent_groups:
        return ["(no groups bound)"]

    for gid, g in sorted(agent_groups.items(), key=lambda x: x[1].get("priority", "z")):
        prio = g.get("priority", "-")
        name = g.get("name", gid)
        lines.append(f"  {prio:<6}  {name}  ({gid})")

    return lines


def _panel_memory(agent, args):
    """Memory directory stats."""
    ws = _workspace_path(agent)
    mem_dir = ws / "memory"
    if not mem_dir.exists():
        return ["(no memory/ directory)"]

    files = [f for f in mem_dir.rglob("*") if f.is_file()]
    total_size = sum(f.stat().st_size for f in files)

    lines = [f"Files: {len(files)}   Size: {total_size / 1024:.0f} KB"]

    if files:
        files.sort(key=lambda f: f.stat().st_mtime, reverse=True)
        lines.append("")
        lines.append("Recent:")
        for f in files[:3]:
            mtime = datetime.fromtimestamp(f.stat().st_mtime)
            rel = f.relative_to(mem_dir)
            lines.append(f"  {mtime:%m-%d %H:%M}  {rel}")

    return lines


GENERIC_PANELS = {
    "workspace": _panel_workspace,
    "groups": _panel_groups,
    "memory": _panel_memory,
}


def load_agent_dashboard(agent):
    """Load agent-specific dashboard.py if it exists. Returns PANELS dict or None."""
    aid = agent["id"]
    candidates = [
        WORKSPACE_ROOT / aid / "dashboard.py",
        WORKSPACE_ROOT / "agents" / aid / "dashboard.py",
    ]
    ws = _workspace_path(agent)
    ws_dash = ws / "dashboard.py"
    if ws_dash not in candidates:
        candidates.append(ws_dash)

    dash_path = None
    for c in candidates:
        if c.exists():
            dash_path = c
            break

    if dash_path is None:
        return None

    spec = importlib.util.spec_from_file_location(f"agent_dash_{aid}", dash_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return getattr(mod, "PANELS", None)


def cmd_dashboard(agent, args):
    """Agent dashboard — show all panels or a specific one."""
    # Merge generic + agent panels (agent can override)
    panels = dict(GENERIC_PANELS)
    agent_panels = load_agent_dashboard(agent)
    if agent_panels:
        panels.update(agent_panels)

    # Specific panel requested?
    if args:
        name = args[0]
        panel_args = args[1:]
        fn = panels.get(name)
        if fn is None:
            print(f"  Unknown panel: {name}")
            print(f"  Available: {', '.join(panels.keys())}")
            return
        lines = fn(agent, panel_args)
        _render_panel(name, lines, fn)
        return

    # Run all panels
    for name, fn in panels.items():
        try:
            lines = fn(agent, [])
        except Exception as e:
            lines = [f"error: {e}"]
        _render_panel(name, lines, fn)


def _render_panel(name, lines, fn):
    """Print a panel with header."""
    doc = (fn.__doc__ or "").strip().split("\n")[0]
    header = f"  ── {name}"
    if doc:
        header += f" ({doc})"
    header += f" {'─' * max(1, 60 - len(header))}"
    print(header)
    for line in (lines or []):
        print(f"  {line}")
    print()


# ── registry ────────────────────────────────────────────────────────

GENERIC_COMMANDS = {
    "status": cmd_status,
    "files": cmd_files,
    "read": cmd_read,
    "log": cmd_log,
    "config": cmd_config,
    "exp": cmd_exp,
    "inject": cmd_inject,
    "dashboard": cmd_dashboard,
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
