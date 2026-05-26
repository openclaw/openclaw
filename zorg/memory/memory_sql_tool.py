#!/usr/bin/env python3
import argparse, json, os
from pathlib import Path
import psycopg2
from psycopg2.extras import RealDictCursor

BASE = Path(os.environ.get("OPENCLAW_WORKSPACE", Path.home() / ".openclaw" / "workspace"))
SQL_CFG = Path(os.environ.get("ZORG_SQL_MEMORY_MAP", BASE / "sql_memory_map.json"))

def load_cfg():
    return json.loads(SQL_CFG.read_text(encoding="utf-8"))

def connect():
    p = load_cfg()["postgres"]
    return psycopg2.connect(host=p["host"], port=p["port"], dbname=p["database"], user=p["user"], password=p["password"])

def search(query, limit):
    with connect() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("select * from zorg_logic_rules where rule_text ilike %s or rule_title ilike %s limit %s", (f"%{query}%", f"%{query}%", limit))
        return cur.fetchall()

def main():
    ap = argparse.ArgumentParser(description="Zorg MemoryDB SQL recall tool")
    ap.add_argument("query")
    ap.add_argument("--limit", type=int, default=10)
    args = ap.parse_args()
    print(json.dumps(search(args.query, args.limit), indent=2, default=str))

if __name__ == "__main__":
    main()
