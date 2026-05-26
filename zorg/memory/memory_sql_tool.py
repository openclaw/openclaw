#!/usr/bin/env python3
import argparse, json, os, sys
from pathlib import Path

BASE = Path(os.environ.get("OPENCLAW_WORKSPACE", Path.home() / ".openclaw" / "workspace"))
SQL_CFG = Path(os.environ.get("ZORG_SQL_MEMORY_MAP", BASE / "sql_memory_map.json"))

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
except ModuleNotFoundError as e:
    if e.name != "psycopg2":
        raise
    venv_python = BASE / ".venv-sqlmem" / "bin" / "python"
    if venv_python.exists() and Path(sys.executable) != venv_python:
        os.execv(str(venv_python), [str(venv_python), __file__, *sys.argv[1:]])
    raise SystemExit(
        "psycopg2 is missing. Run: "
        f"{venv_python} -m pip install -r {BASE / 'zorg-memorydb' / 'requirements.txt'}"
    )

def load_cfg():
    return json.loads(SQL_CFG.read_text(encoding="utf-8"))

def connect():
    p = load_cfg()["postgres"]
    return psycopg2.connect(host=p["host"], port=p["port"], dbname=p["database"], user=p["user"], password=p["password"])

def search(query, limit):
    with connect() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""
            select 'rule' as source_type, id::text as source_id, source_path as path,
                   null::integer as line_start, null::integer as line_end,
                   priority, rule_text as content
              from zorg_logic_rules
             where rule_text ilike %s or rule_title ilike %s
            union all
            select 'markdown' as source_type, id::text as source_id, source_path as path,
                   line_start, line_end, priority, content
              from memory_source_chunks
             where content ilike %s or source_path ilike %s
             limit %s
        """, (f"%{query}%", f"%{query}%", f"%{query}%", f"%{query}%", limit))
        return cur.fetchall()

def main():
    ap = argparse.ArgumentParser(description="Zorg MemoryDB SQL recall tool")
    ap.add_argument("query")
    ap.add_argument("--limit", type=int, default=10)
    args = ap.parse_args()
    print(json.dumps(search(args.query, args.limit), indent=2, default=str))

if __name__ == "__main__":
    main()
