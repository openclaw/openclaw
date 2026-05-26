#!/usr/bin/env python3
import argparse, json, os
from pathlib import Path
import psycopg2
from psycopg2.extras import RealDictCursor

BASE = Path(os.environ.get("OPENCLAW_WORKSPACE", Path.home() / ".openclaw" / "workspace"))
SQL_CFG = Path(os.environ.get("ZORG_SQL_MEMORY_MAP", BASE / "sql_memory_map.json"))

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
                cur.execute("select 'rule' as source_type, id::text as source_id, source_path as path, null::integer as line_start, null::integer as line_end, priority, rule_text as content from zorg_logic_rules where rule_text ilike %s or rule_title ilike %s limit %s", (f"%{args.query}%", f"%{args.query}%", args.limit))
                rows = cur.fetchall()
        print(json.dumps({"mode": "database-direct-structured", "requested_limit": args.limit, "structured": rows}, indent=2, default=str))
    except Exception as e:
        print(json.dumps({"mode": "database-unavailable", "error": str(e), "structured": []}, indent=2))

if __name__ == "__main__":
    main()
