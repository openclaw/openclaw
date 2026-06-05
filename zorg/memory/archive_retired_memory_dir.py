#!/usr/bin/env python3
"""Archive a retired OpenClaw workspace memory/ directory into PostgreSQL and remove it.

This script is structural only: it ships no private data. Run locally during migration from
flat-file memory to DB-only durable memory.
"""
import hashlib
import json
import os
import shutil
import argparse
from pathlib import Path

import psycopg2
from psycopg2.extras import Json

BASE = Path(os.environ.get('OPENCLAW_WORKSPACE', Path.cwd())).resolve()
MAP = Path(os.environ.get('SQL_MEMORY_MAP', BASE / 'sql_memory_map.json')).resolve()
MEMORY_DIR = BASE / 'memory'


def rel(p: Path) -> str:
    return str(p.relative_to(BASE)).replace('\\', '/')


def main():
    parser = argparse.ArgumentParser(description='Archive retired OpenClaw memory files into Zorg MemoryDB.')
    parser.add_argument('--direct-file', help='Import one runtime-created memory file directly, then remove it after DB import.')
    parser.add_argument('--source-path', help='Logical source path to store for --direct-file.')
    parser.add_argument('--category', default='legacy_memory_file_line')
    parser.add_argument('--priority', default='medium')
    parser.add_argument('--memory-key-prefix', default='migrated-memory-file')
    args = parser.parse_args()

    cfg = json.loads(MAP.read_text())['postgres']
    conn = psycopg2.connect(
        host=cfg['host'],
        port=cfg['port'],
        dbname=cfg['database'],
        user=cfg['user'],
        password=cfg.get('password', ''),
    )
    if args.direct_file:
        files = [Path(args.direct_file).expanduser().resolve()]
    else:
        files = sorted([p for p in MEMORY_DIR.rglob('*') if p.is_file()]) if MEMORY_DIR.exists() else []
    archived = 0
    lines_inserted = 0
    with conn:
        with conn.cursor() as cur:
            cur.execute(Path(__file__).resolve().parents[1].joinpath('db/memory_file_archive_schema.sql').read_text())
            for path in files:
                data = path.read_bytes()
                text = data.decode('utf-8', errors='replace')
                source_path = args.source_path if args.direct_file and args.source_path else rel(path)
                sha = hashlib.sha256(data).hexdigest()
                content_json = None
                if path.suffix.lower() in {'.json'}:
                    try:
                        content_json = json.loads(text)
                    except Exception:
                        content_json = None
                cur.execute(
                    """
                    insert into public.zorg_memory_file_archive
                      (source_path, content_sha256, byte_size, line_count, content, content_json, notes)
                    values (%s, %s, %s, %s, %s, %s, %s)
                    on conflict (source_path, content_sha256) do update
                      set content=excluded.content,
                          byte_size=excluded.byte_size,
                          line_count=excluded.line_count,
                          content_json=excluded.content_json,
                          notes=excluded.notes
                    returning id::text
                    """,
                    (source_path, sha, len(data), text.count('\n') + (1 if text else 0), text, Json(content_json) if content_json is not None else None, 'retired memory/ archive'),
                )
                cur.fetchone()
                archived += 1
                for i, line in enumerate(text.splitlines(), 1):
                    stripped = line.strip()
                    if not stripped:
                        continue
                    key = f'{args.memory_key_prefix}::{source_path}::{i}'
                    category = args.category
                    priority = args.priority
                    cur.execute(
                        """
                        update public.zorg_memory
                        set memory_value=%s,
                            memory_category=%s,
                            memory_priority=%s,
                            memory_active=true
                        where memory_key=%s
                        """,
                        (stripped, category, priority, key),
                    )
                    if cur.rowcount == 0:
                        cur.execute(
                            """
                            insert into public.zorg_memory
                              (chat_session_log, memory_key, memory_value, memory_category, memory_priority, memory_active)
                            values (%s, %s, %s, %s, %s, true)
                            """,
                            (f'Migrated retired memory file {source_path}:{i}', key, stripped, category, priority),
                        )
                    lines_inserted += 1
            cur.execute("""
                update public.zorg_memory_file_archive
                set deleted_from_filesystem=true, deleted_at=now()
                where source_path like 'memory/%'
            """)
            refresh_allowed = not args.direct_file and os.environ.get('ZORG_SKIP_RECALL_REFRESH') != '1'
            if refresh_allowed:
                cur.execute("select to_regprocedure('public.refresh_zorg_memory_search_fast_mv()')")
                if cur.fetchone()[0]:
                    cur.execute('select public.refresh_zorg_memory_search_fast_mv()')
                cur.execute("select to_regprocedure('public.refresh_zorg_master_context()')")
                if cur.fetchone()[0]:
                    cur.execute('select public.refresh_zorg_master_context()')
    if args.direct_file and files and files[0].exists():
        files[0].unlink()
    elif MEMORY_DIR.exists():
        shutil.rmtree(MEMORY_DIR)
    print(json.dumps({'files_archived': archived, 'line_rows_upserted': lines_inserted, 'memory_dir_removed': not MEMORY_DIR.exists()}, sort_keys=True))


if __name__ == '__main__':
    main()
