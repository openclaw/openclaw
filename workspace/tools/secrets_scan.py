#!/usr/bin/env python3
"""secrets_scan.py

Lightweight secret scanner for this workspace.

Goal: catch obvious API keys/tokens before they leak into git history, logs,
or screenshots.

It intentionally:
- avoids heavy dependencies
- redacts matches in output
- is conservative (pattern-based; may produce false positives)

Usage:
  python3 tools/secrets_scan.py
  python3 tools/secrets_scan.py --root .
  python3 tools/secrets_scan.py --include memory
  python3 tools/secrets_scan.py --max 200

Exit codes:
  0: no findings
  1: findings found
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Finding:
    path: Path
    line_no: int
    rule: str
    snippet: str


DEFAULT_EXCLUDES = {
    ".git",
    "node_modules",
    "venv",
    ".venv",
    ".venv_docx",
    ".venv_xls",
    "__pycache__",
    "dist",
    "build",
    "output",
    "generated",
    "tmp",
    "voice_local",
    "voice_local_cuda",
    "comfyui",
    "projects",
}

# A small, opinionated set of patterns we actually care about in this repo.
# (Add more when needed.)
RULES: list[tuple[str, re.Pattern[str]]] = [
    (
        "google_api_key",
        re.compile(r"\bAIza[0-9A-Za-z\-_]{30,}\b"),
    ),
    (
        "gemini_or_google_token_like",
        re.compile(r"\bAQ\.[0-9A-Za-z\-_]{20,}\b"),
    ),
    (
        "openai_sk",
        re.compile(r"\bsk-[0-9A-Za-z]{20,}\b"),
    ),
    (
        "anthropic_sk",
        re.compile(r"\bsk-ant-[0-9A-Za-z\-_]{20,}\b"),
    ),
    (
        "aws_access_key_id",
        re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    ),
    (
        "slack_token",
        re.compile(r"\bxox[baprs]-[0-9A-Za-z-]{10,}\b"),
    ),
    (
        "generic_bearer",
        re.compile(r"\bBearer\s+[0-9A-Za-z\-_.=]{20,}\b"),
    ),
]


def redact(s: str) -> str:
    s = s.strip("\n")
    if len(s) <= 10:
        return "[REDACTED]"
    return f"{s[:4]}…{s[-4:]}"


def is_text_file(path: Path) -> bool:
    # Cheap heuristic: skip obviously-binary extensions.
    binary_exts = {
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".pdf",
        ".zip",
        ".gz",
        ".tar",
        ".mp4",
        ".mov",
        ".mkv",
        ".exe",
        ".bin",
    }
    if path.suffix.lower() in binary_exts:
        return False
    return True


def should_skip_file(p: Path) -> bool:
    if not is_text_file(p):
        return True
    # never scan local-secret files (they will contain secrets by design)
    if p.name in {"secrets.local.md", ".env", ".env.local"} or p.name.endswith(".local.md"):
        return True
    # keep the scan small: skip gigantic files
    try:
        if p.stat().st_size > 2_000_000:  # 2MB
            return True
    except FileNotFoundError:
        return True
    return False


def iter_files(root: Path, include_memory: bool) -> list[Path]:
    files: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        # mutate dirnames in-place to prune walk
        dirnames[:] = [
            d
            for d in dirnames
            if d not in DEFAULT_EXCLUDES and (include_memory or d != "memory")
        ]
        for fn in filenames:
            p = Path(dirpath) / fn
            if should_skip_file(p):
                continue
            files.append(p)
    return files


def scan_file(path: Path, max_findings: int) -> list[Finding]:
    findings: list[Finding] = []
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return findings

    for i, line in enumerate(text.splitlines(), start=1):
        for rule_name, pat in RULES:
            m = pat.search(line)
            if not m:
                continue
            token = m.group(0)
            redacted = redact(token)
            snippet = line.replace(token, redacted)
            findings.append(Finding(path=path, line_no=i, rule=rule_name, snippet=snippet.strip()))
            if len(findings) >= max_findings:
                return findings
    return findings


def staged_files(root: Path) -> list[Path]:
    """Return absolute Paths of staged files (added/copied/modified/renamed/typechanged).

    This is the preferred mode for pre-commit hooks: fast and focused.
    """
    import subprocess

    try:
        out = subprocess.check_output(
            [
                "git",
                "diff",
                "--cached",
                "--name-only",
                "--diff-filter=ACMRT",
            ],
            cwd=str(root),
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return []

    paths: list[Path] = []
    for line in out.splitlines():
        rel = line.strip()
        if not rel:
            continue
        p = (root / rel).resolve()
        if not p.exists() or not p.is_file():
            continue
        if should_skip_file(p):
            continue
        paths.append(p)
    return paths


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".", help="Root directory to scan (default: .)")
    ap.add_argument(
        "--include",
        default="",
        help="Comma-separated directories to include even if usually excluded (e.g. memory)",
    )
    ap.add_argument(
        "--staged",
        action="store_true",
        help="Scan only staged files (fast; recommended for pre-commit)",
    )
    ap.add_argument(
        "--paths",
        nargs="*",
        default=None,
        help="Optional explicit file paths to scan (relative to --root).",
    )
    ap.add_argument("--max", type=int, default=100, help="Max findings to print")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    include_set = {x.strip() for x in args.include.split(",") if x.strip()}
    include_memory = "memory" in include_set

    if args.paths is not None and len(args.paths) > 0:
        files = []
        for rel in args.paths:
            p = (root / rel).resolve()
            if not p.exists() or not p.is_file():
                continue
            if should_skip_file(p):
                continue
            files.append(p)
    elif args.staged:
        files = staged_files(root)
    else:
        files = iter_files(root, include_memory=include_memory)

    all_findings: list[Finding] = []
    for p in files:
        remaining = max(0, args.max - len(all_findings))
        if remaining == 0:
            break
        all_findings.extend(scan_file(p, max_findings=remaining))

    if not all_findings:
        print("No obvious secrets found.")
        return 0

    print(f"Potential secrets found: {len(all_findings)} (showing up to {args.max})")
    for f in all_findings:
        rel = f.path.relative_to(root) if f.path.is_relative_to(root) else f.path
        print(f"- {rel}:{f.line_no} [{f.rule}] {f.snippet}")

    print("\nTip: move secrets to tools/secrets.local.md (gitignored) or environment variables.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
