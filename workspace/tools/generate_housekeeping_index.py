#!/usr/bin/env python3
"""Generate memory/housekeeping_index.md by scanning memory/ and memory/archive/.

This keeps git noise low while preserving discoverability of housekeeping reports.

Design goals:
- Deterministic output (stable sort)
- Include both root and archived reports
- Group by YYYY-MM-DD extracted from filename
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from typing import Iterable

YMD_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")


def extract_ymd(name: str) -> str | None:
    m = YMD_RE.search(name)
    return m.group(1) if m else None


def iter_candidates(memory_dir: Path, include_legacy: bool) -> Iterable[Path]:
    pats = ["housekeeping-*.md"]
    if include_legacy:
        pats += ["*housekeeping*.md"]

    for pat in pats:
        yield from memory_dir.glob(pat)

    archive = memory_dir / "archive"
    if archive.exists():
        # Scan nested archive folders too
        for pat in pats:
            yield from archive.rglob(pat)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--memory", default="memory", help="memory directory (default: memory)")
    ap.add_argument(
        "--include-legacy-names",
        action="store_true",
        help="also include *housekeeping*.md variants",
    )
    ap.add_argument(
        "--out",
        default=None,
        help="output file (default: <memory>/housekeeping_index.md)",
    )
    args = ap.parse_args()

    memory_dir = Path(args.memory).resolve()
    out = Path(args.out).resolve() if args.out else memory_dir / "housekeeping_index.md"

    items: list[tuple[str, str]] = []  # (ymd, relpath)
    for p in iter_candidates(memory_dir, args.include_legacy_names):
        if p.name == "housekeeping_index.md":
            continue
        if not p.is_file():
            continue
        ymd = extract_ymd(p.name)
        if not ymd:
            continue
        rel = p.resolve().relative_to(memory_dir.parent.resolve())
        items.append((ymd, str(rel)))

    # Dedup, stable sort
    items = sorted(set(items), key=lambda t: (t[0], t[1]), reverse=True)

    by_day: dict[str, list[str]] = {}
    for ymd, rel in items:
        by_day.setdefault(ymd, []).append(rel)

    # Write
    out.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    lines.append("# housekeeping reports index")
    lines.append("")
    lines.append("## Naming convention (suggested)")
    lines.append("- Prefer: `housekeeping-YYYY-MM-DD.md` (one per day)")
    lines.append("- If multiple exist for a day (underscores/dashes), keep all unless explicitly asked to consolidate.")
    lines.append("")

    for ymd in sorted(by_day.keys(), reverse=True):
        lines.append(f"## {ymd}")
        for rel in sorted(by_day[ymd]):
            lines.append(f"- `{rel}`")
        lines.append("")

    out.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
