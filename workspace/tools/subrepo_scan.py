#!/usr/bin/env python3
"""subrepo_scan.py

Scan for nested git repositories (directories containing a `.git/` folder)
inside a workspace, and print recommended `.gitignore` entries.

Why:
- In a monorepo-like workspace, you may keep multiple standalone repos under
  `projects/`. Git will otherwise show them as untracked noise unless ignored.

Usage:
  python3 tools/subrepo_scan.py
  python3 tools/subrepo_scan.py --root projects
  python3 tools/subrepo_scan.py --root . --max-depth 4
  python3 tools/subrepo_scan.py --as-gitignore

Notes:
- This only detects *non-bare* repos (a `.git` directory).
- It intentionally ignores the top-level `.git/` for the current repo.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path


def is_git_repo_dir(p: Path) -> bool:
    return (p / ".git").is_dir()


def walk_dirs(root: Path, max_depth: int) -> list[Path]:
    root = root.resolve()
    found: list[Path] = []

    # Resolve the current repo root .git to avoid reporting itself.
    # (Assumes this script lives under the repo root at tools/.)
    this_repo_git = (Path(__file__).resolve().parents[1] / ".git").resolve()

    for dirpath, dirnames, _filenames in os.walk(root):
        d = Path(dirpath)
        rel = d.relative_to(root)
        depth = 0 if str(rel) == "." else len(rel.parts)
        if depth > max_depth:
            dirnames[:] = []
            continue

        # Speed: skip venv/node_modules-ish stuff early
        skip_names = {
            "node_modules",
            "venv",
            ".venv",
            "dist",
            "build",
            "output",
            "tmp",
            "generated",
            ".pytest_cache",
            ".mypy_cache",
            ".ruff_cache",
        }
        dirnames[:] = [n for n in dirnames if n not in skip_names]

        git_dir = (d / ".git")
        if git_dir.is_dir():
            try:
                if git_dir.resolve() == this_repo_git:
                    continue
            except Exception:
                # If resolve fails for any reason, just treat as normal.
                pass
            found.append(d)
            # Do not recurse into repos; treat them as boundaries.
            dirnames[:] = []

    return sorted(set(found))


def main() -> int:
    ap = argparse.ArgumentParser(description="Scan for nested git repos and suggest .gitignore entries")
    ap.add_argument(
        "--root",
        default="projects",
        help="Root directory to scan (default: projects)",
    )
    ap.add_argument(
        "--max-depth",
        type=int,
        default=6,
        help="Max directory depth to scan under --root (default: 6)",
    )
    ap.add_argument(
        "--as-gitignore",
        action="store_true",
        help="Print suggested .gitignore lines only",
    )
    args = ap.parse_args()

    repo_root = Path(__file__).resolve().parents[1]
    scan_root = (repo_root / args.root).resolve() if not Path(args.root).is_absolute() else Path(args.root).resolve()

    if not scan_root.exists() or not scan_root.is_dir():
        raise SystemExit(f"Root not found or not a directory: {scan_root}")

    repos = walk_dirs(scan_root, max_depth=args.max_depth)

    if args.as_gitignore:
        for p in repos:
            rel = p.relative_to(repo_root)
            print(f"{rel.as_posix()}/")
        return 0

    if not repos:
        print(f"No nested git repos found under: {scan_root}")
        return 0

    print(f"Found {len(repos)} nested git repo(s) under: {scan_root}")
    for p in repos:
        rel = p.relative_to(repo_root)
        print(f"- {rel.as_posix()}/")

    print("\nSuggested .gitignore entries:")
    for p in repos:
        rel = p.relative_to(repo_root)
        print(f"{rel.as_posix()}/")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
