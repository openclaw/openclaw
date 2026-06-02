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

def main():
    ap = argparse.ArgumentParser(description="DB-only structured recall router")
    ap.add_argument("query")
    ap.add_argument("--limit", type=int, default=10)
    args = ap.parse_args()
    try:
        cfg = json.loads(SQL_CFG.read_text(encoding="utf-8"))
        p = cfg["postgres"]
        with psycopg2.connect(host=p["host"], port=p["port"], dbname=p["database"], user=p["user"], password=p["password"]) as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("""
                    with matches as (
                        select 'rule' as source_type, r.id::text as source_id, r.source_path as path,
                               null::integer as line_start, null::integer as line_end,
                               r.priority, r.rule_text as content,
                               coalesce(w.seed_weight, 1) * coalesce(w.dynamic_weight, 1) as rank_weight
                          from zorg_logic_rules r
                          left join zorg_logic_rule_dynamic_weights w on w.rule_key = r.rule_key
                         where r.rule_text ilike %s or r.rule_title ilike %s
                        union all
                        select 'markdown' as source_type, id::text as source_id, source_path as path,
                               line_start, line_end, priority, content, 1::numeric as rank_weight
                          from memory_source_chunks
                         where content ilike %s or source_path ilike %s
                    )
                    select source_type, source_id, path, line_start, line_end, priority, content
                      from matches
                     order by rank_weight desc, priority desc
                     limit %s
                """, (f"%{args.query}%", f"%{args.query}%", f"%{args.query}%", f"%{args.query}%", args.limit))
                rows = cur.fetchall()
        print(json.dumps({"mode": "database-direct-structured", "requested_limit": args.limit, "structured": rows}, indent=2, default=str))
    except Exception as e:
        print(json.dumps({"mode": "database-unavailable", "error": str(e), "structured": []}, indent=2))

if __name__ == "__main__":
    main()
