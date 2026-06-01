#!/usr/bin/env python3
import argparse
import hashlib
from pathlib import Path
import psycopg2

def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()

def iter_markdown(workspace: Path, rules_dir: Path):
    candidates = []
    if rules_dir.exists():
        candidates.extend(rules_dir.glob("*.md"))
    core_markdown = [
        "AGENTS.md",
        "SOUL.md",
        "USER.md",
        "TOOLS.md",
        "IDENTITY.md",
        "HEARTBEAT.md",
        "RESURRECTION.md",
        "ZORG_MEMORYDB_MASTER_RULES.md",
    ]
    for name in core_markdown:
        path = workspace / name
        if path.exists():
            candidates.append(path)
    retired_memory = workspace / "memory"
    if retired_memory.exists():
        candidates.extend(retired_memory.rglob("*.md"))
    for p in sorted(set(candidates)):
        if p.is_file():
            yield p

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--rules-dir", required=True)
    ap.add_argument("--database-url", required=True)
    args = ap.parse_args()
    workspace = Path(args.workspace)
    rules_dir = Path(args.rules_dir)
    with psycopg2.connect(args.database_url) as conn:
        with conn.cursor() as cur:
            for path in iter_markdown(workspace, rules_dir):
                text = path.read_text(encoding="utf-8", errors="replace")
                digest = sha(text)
                cur.execute("""
                    insert into zorg_markdown_imports (source_path, source_hash, import_reason)
                    values (%s, %s, %s)
                    on conflict (source_path, source_hash) do update set imported_at = now()
                    returning id
                """, (str(path), digest, "packaged_rules_or_retired_memory_markdown"))
                import_id = cur.fetchone()[0]
                lines = text.splitlines()
                for start in range(0, len(lines), 80):
                    chunk = "\n".join(lines[start:start+80]).strip()
                    if not chunk:
                        continue
                    cur.execute("""
                        insert into memory_source_chunks (import_id, source_path, line_start, line_end, content, content_hash, priority)
                        values (%s, %s, %s, %s, %s, %s, %s)
                        on conflict (source_path, content_hash) do nothing
                    """, (import_id, str(path), start + 1, min(start + 80, len(lines)), chunk, sha(chunk), "high"))
        conn.commit()

if __name__ == "__main__":
    main()
