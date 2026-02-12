#!/usr/bin/env python3
"""size_watch.py - Record and diff directory sizes.

Why: housekeeping reports are great for humans, but a tiny JSON baseline makes it
trivial to see growth over time ("what got bigger since last week?").

Usage:
  # record baseline
  python3 tools/size_watch.py record --out tmp/size-baseline-$(date +%F-%H%M).json

  # diff two baselines
  python3 tools/size_watch.py diff tmp/size-baseline-OLD.json tmp/size-baseline-NEW.json

Options:
  --paths P1,P2,...   extra paths to include (files or dirs)
  --max-depth N       for top-level scan (default 1)

This script is intentionally dependency-free.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_TOPLEVEL = [
    "memory",
    "tools",
    "tmp",
    "projects",
    "voice_local",
    "voice_local_cuda",
    "maple_sgedu",
    "comfyui",
    "contacts",
    "documents",
    "generated",
]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def bytes_of_path(p: Path) -> int:
    if not p.exists():
        return 0
    if p.is_file() and not p.is_symlink():
        try:
            return p.stat().st_size
        except OSError:
            return 0
    # directories or symlinks: walk if dir
    if p.is_dir() and not p.is_symlink():
        total = 0
        for root, dirs, files in os.walk(p, followlinks=False):
            # ignore hidden git internals by default
            if "/.git/" in str(Path(root).as_posix()) or str(Path(root).as_posix()).endswith("/.git"):
                dirs[:] = []
                continue
            for name in files:
                fp = Path(root) / name
                try:
                    if fp.is_symlink():
                        continue
                    total += fp.stat().st_size
                except OSError:
                    pass
        return total
    # symlink (file or dir): count link itself
    try:
        return p.lstat().st_size
    except OSError:
        return 0


def human(n: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    f = float(n)
    for u in units:
        if f < 1024 or u == units[-1]:
            if u == "B":
                return f"{int(f)} {u}"
            return f"{f:.2f} {u}"
        f /= 1024
    return f"{n} B"


def record(repo_root: Path, out_path: Path, extra_paths: list[str]) -> None:
    items: dict[str, int] = {}

    for name in DEFAULT_TOPLEVEL:
        p = repo_root / name
        items[str(p)] = bytes_of_path(p)

    for raw in extra_paths:
        if not raw:
            continue
        p = (repo_root / raw).resolve() if not os.path.isabs(raw) else Path(raw)
        items[str(p)] = bytes_of_path(p)

    payload = {
        "createdAt": now_iso(),
        "repoRoot": str(repo_root.resolve()),
        "items": items,
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    # friendly stdout
    pairs = sorted(items.items(), key=lambda kv: kv[1], reverse=True)
    print(f"Wrote: {out_path}")
    for path, b in pairs:
        rel = path
        try:
            rel = str(Path(path).resolve().relative_to(repo_root.resolve()))
        except Exception:
            pass
        print(f"- {rel}: {human(b)}")


def diff(path_a: Path, path_b: Path) -> None:
    a = json.loads(path_a.read_text(encoding="utf-8"))
    b = json.loads(path_b.read_text(encoding="utf-8"))

    items_a: dict[str, int] = a.get("items", {})
    items_b: dict[str, int] = b.get("items", {})

    keys = sorted(set(items_a) | set(items_b))
    rows = []
    for k in keys:
        va = int(items_a.get(k, 0))
        vb = int(items_b.get(k, 0))
        delta = vb - va
        rows.append((abs(delta), delta, k, va, vb))

    rows.sort(reverse=True)

    print(f"A: {path_a} ({a.get('createdAt')})")
    print(f"B: {path_b} ({b.get('createdAt')})")
    print("\nBiggest changes:")
    for _, delta, k, va, vb in rows[:50]:
        if delta == 0:
            continue
        sign = "+" if delta > 0 else ""
        print(f"- {k}: {human(va)} -> {human(vb)} ({sign}{human(delta)})")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_rec = sub.add_parser("record", help="record a JSON size baseline")
    p_rec.add_argument("--out", required=True, help="output json path")
    p_rec.add_argument("--paths", default="", help="comma-separated extra paths")

    p_diff = sub.add_parser("diff", help="diff two baselines")
    p_diff.add_argument("a")
    p_diff.add_argument("b")

    args = parser.parse_args(argv)
    repo_root = Path.cwd()

    if args.cmd == "record":
        extra = [s.strip() for s in (args.paths or "").split(",") if s.strip()]
        record(repo_root=repo_root, out_path=Path(args.out), extra_paths=extra)
        return 0
    if args.cmd == "diff":
        diff(Path(args.a), Path(args.b))
        return 0

    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
