#!/usr/bin/env python3
"""BG666 Report Generator — YAML-driven data pipeline → HTML report.

Usage:
    # Generate report for the last 7 days (default)
    python3 workspace/bg666/analytics/report_gen.py

    # Custom date range
    python3 workspace/bg666/analytics/report_gen.py --end 2026-03-06 --days 7

    # Skip Matomo queries (if server is down)
    python3 workspace/bg666/analytics/report_gen.py --skip-matomo

    # Output to specific path
    python3 workspace/bg666/analytics/report_gen.py -o /tmp/report.html
"""

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path

import yaml
from jinja2 import Template

# ── Paths ──
BASE = Path(__file__).resolve().parent
REPORT_YAML = BASE / "report.yaml"
TEMPLATE_HTML = BASE / "report_template.html"
LOCAL_DB = Path.home() / "clawd" / "workspace" / "bg666" / "bg666.db"

# pymysql for remote DB
PYMYSQL_PATH = os.path.expanduser("~/Documents/two/scripts/pymysql")
sys.path.insert(0, PYMYSQL_PATH)

REMOTE_BG666 = {
    "host": "bg666-market-readonly.czsks2mguhd5.ap-south-1.rds.amazonaws.com",
    "port": 3306,
    "user": "market",
    "password": "hBVoVVm&)aZtW0t6",
    "database": "ry-cloud",
    "charset": "utf8mb4",
}

MATOMO_DB = {
    "host": "10.188.4.51",
    "port": 3306,
    "user": "matomo",
    "password": "Matomo@BG666!2026",
    "database": "matomo",
    "charset": "utf8mb4",
}

MATOMO_TUNNEL = {
    "ssh_host": "13.205.188.209",
    "ssh_user": "ubuntu",
    "ssh_key": os.path.expanduser("~/.ssh/matomo.pem"),
    "remote_host": "10.188.4.51",
    "remote_port": 3306,
}


def query_local(sql: str) -> list[dict]:
    """Query local SQLite, return list of dicts."""
    conn = sqlite3.connect(str(LOCAL_DB))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(sql).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def query_remote(sql: str) -> list[dict]:
    """Query remote BG666 MySQL."""
    import pymysql
    conn = pymysql.connect(**REMOTE_BG666)
    try:
        cur = conn.cursor(pymysql.cursors.DictCursor)
        cur.execute(sql)
        rows = cur.fetchall()
        return [_coerce_row(r) for r in rows]
    finally:
        conn.close()


def query_matomo(sql: str) -> list[dict]:
    """Query Matomo via subprocess SSH tunnel (avoids paramiko version issues)."""
    import pymysql
    import subprocess
    import socket
    import time

    # Find a free local port
    with socket.socket() as s:
        s.bind(("", 0))
        local_port = s.getsockname()[1]

    # Start SSH tunnel as subprocess
    tunnel_proc = subprocess.Popen(
        ["ssh", "-i", MATOMO_TUNNEL["ssh_key"],
         "-o", "StrictHostKeyChecking=no",
         "-N", "-L", f"{local_port}:{MATOMO_TUNNEL['remote_host']}:{MATOMO_TUNNEL['remote_port']}",
         f"{MATOMO_TUNNEL['ssh_user']}@{MATOMO_TUNNEL['ssh_host']}"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(2)  # wait for tunnel to establish

    try:
        conn = pymysql.connect(
            host="127.0.0.1",
            port=local_port,
            user=MATOMO_DB["user"],
            password=MATOMO_DB["password"],
            database=MATOMO_DB["database"],
            charset=MATOMO_DB["charset"],
            connect_timeout=10,
        )
        cur = conn.cursor(pymysql.cursors.DictCursor)
        # Handle multi-statement SQL (SET ... ; SELECT ...)
        statements = [s.strip() for s in sql.split(';') if s.strip()]
        for stmt in statements[:-1]:
            cur.execute(stmt)
        cur.execute(statements[-1])
        rows = cur.fetchall()
        conn.close()
        return [_coerce_row(r) for r in rows]
    finally:
        tunnel_proc.terminate()
        tunnel_proc.wait(timeout=5)


def _coerce_row(row: dict) -> dict:
    from decimal import Decimal
    out = {}
    for k, v in row.items():
        if isinstance(v, Decimal):
            out[k] = float(v)
        elif isinstance(v, bytes):
            out[k] = v.decode("utf-8", errors="replace")
        elif isinstance(v, (datetime,)):
            out[k] = v.isoformat()
        elif hasattr(v, "isoformat"):
            out[k] = v.isoformat()
        else:
            out[k] = v
    return out


def run_queries(config: dict, date_start: str, date_end: str,
                skip_matomo: bool = False) -> dict:
    """Run all queries from config, return {name: [rows]}."""
    queries = config.get("queries", {})
    results = {}

    for name, qdef in queries.items():
        db = qdef.get("db", "local")
        sql = qdef["sql"].replace("{date_start}", date_start).replace("{date_end}", date_end)

        if db == "matomo" and skip_matomo:
            print(f"  SKIP  {name} (--skip-matomo)")
            results[name] = []
            continue

        print(f"  {'...':<6} {name}", end="", flush=True)
        try:
            if db == "local":
                rows = query_local(sql)
            elif db == "remote":
                rows = query_remote(sql)
            elif db == "matomo":
                rows = query_matomo(sql)
            else:
                rows = []
            results[name] = rows
            print(f"\r  {'OK':<6} {name} ({len(rows)} rows)")
        except Exception as e:
            print(f"\r  {'FAIL':<6} {name}: {e}")
            results[name] = []

    return results


def compute_summary(data: dict) -> dict:
    """Compute derived summary metrics from raw query results."""
    overview = data.get("daily_overview", [])
    if not overview:
        return {}

    total_recharge = sum(float(r.get("recharge", 0) or 0) for r in overview)
    total_withdraw = sum(float(r.get("withdraw", 0) or 0) for r in overview)
    total_bet = sum(float(r.get("bet", 0) or 0) for r in overview)
    avg_active = sum(int(r.get("active_players", 0) or 0) for r in overview) / max(len(overview), 1)
    avg_recharge = total_recharge / max(len(overview), 1)

    retention = data.get("retention_d1", [])
    # exclude last day (no next-day data)
    valid_ret = [r for r in retention if float(r.get("retention_pct", 0) or 0) > 0]
    avg_retention = sum(float(r["retention_pct"]) for r in valid_ret) / max(len(valid_ret), 1) if valid_ret else 0

    bet_recharge_ratio = total_bet / total_recharge if total_recharge else 0

    # Player segments
    segments = data.get("player_segments", [])
    top_players = sum(r["players"] for r in segments if "VIP" in r.get("segment", "") or "High" in r.get("segment", ""))
    total_players = sum(r["players"] for r in segments if r.get("segment") != "Inactive")
    top_bet = sum(r["total_bet"] for r in segments if "VIP" in r.get("segment", "") or "High" in r.get("segment", ""))
    top_pct = top_players / total_players * 100 if total_players else 0
    top_bet_pct = top_bet / total_bet * 100 if total_bet else 0

    # Game categories
    categories = data.get("game_categories", [])
    total_game_bet = sum(float(r.get("total_bet", 0)) for r in categories)

    # Cross category
    cross = data.get("cross_category", [])
    single_cat_players = sum(r["players"] for r in cross if r.get("games_played") == 1)
    all_cat_players = sum(r["players"] for r in cross)
    single_pct = single_cat_players / all_cat_players * 100 if all_cat_players else 0

    return {
        "days": len(overview),
        "date_start": overview[0]["dt"] if overview else "",
        "date_end": overview[-1]["dt"] if overview else "",
        "avg_daily_recharge": avg_recharge,
        "avg_daily_active": avg_active,
        "avg_retention_d1": avg_retention,
        "bet_recharge_ratio": bet_recharge_ratio,
        "total_recharge": total_recharge,
        "total_withdraw": total_withdraw,
        "total_bet": total_bet,
        "net_revenue": total_recharge - total_withdraw,
        "top_player_pct": top_pct,
        "top_bet_pct": top_bet_pct,
        "top_players": top_players,
        "total_players": total_players,
        "total_game_bet": total_game_bet,
        "single_cat_pct": single_pct,
    }


def compute_device_summary(data: dict) -> dict:
    daily = data.get("matomo_device_daily", [])
    if not daily:
        return {}

    total_visits = sum(int(r.get("total", 0) or 0) for r in daily)
    total_desktop = sum(int(r.get("desktop", 0) or 0) for r in daily)
    total_smartphone = sum(int(r.get("smartphone", 0) or 0) for r in daily)
    total_tablet = sum(int(r.get("tablet", 0) or 0) for r in daily)
    total_ios = sum(int(r.get("ios", 0) or 0) for r in daily)
    total_android = sum(int(r.get("android", 0) or 0) for r in daily)

    days = len(daily)
    mobile_total = total_ios + total_android + total_tablet

    os_rows = data.get("matomo_device_os", [])
    ios_row = next((r for r in os_rows if r.get("os_code") == "IOS"), {})
    android_row = next((r for r in os_rows if r.get("os_code") == "AND"), {})

    # Compute OS pct in Python instead of SQL window function
    for r in os_rows:
        r["pct"] = round(int(r.get("visits", 0) or 0) / total_visits * 100, 1) if total_visits else 0
        r["bounce_rate"] = round(
            int(r.get("bounces", 0) or 0) / max(int(r.get("visits", 0) or 0), 1) * 100, 1
        )

    first_half = daily[:days // 2] if days > 1 else daily
    second_half = daily[days // 2:]
    first_mobile = sum(int(r.get("smartphone", 0) or 0) + int(r.get("tablet", 0) or 0) for r in first_half)
    second_mobile = sum(int(r.get("smartphone", 0) or 0) + int(r.get("tablet", 0) or 0) for r in second_half)
    first_desktop = sum(int(r.get("desktop", 0) or 0) for r in first_half)
    second_desktop = sum(int(r.get("desktop", 0) or 0) for r in second_half)

    mobile_trend = "up" if second_mobile > first_mobile * 1.05 else "down" if second_mobile < first_mobile * 0.95 else "stable"
    desktop_trend = "up" if second_desktop > first_desktop * 1.05 else "down" if second_desktop < first_desktop * 0.95 else "stable"

    return {
        "total_visits": total_visits,
        "days": days,
        "desktop": total_desktop,
        "desktop_pct": round(total_desktop / total_visits * 100, 1) if total_visits else 0,
        "smartphone": total_smartphone,
        "smartphone_pct": round(total_smartphone / total_visits * 100, 1) if total_visits else 0,
        "tablet": total_tablet,
        "tablet_pct": round(total_tablet / total_visits * 100, 1) if total_visits else 0,
        "mobile_pct": round(mobile_total / total_visits * 100, 1) if total_visits else 0,
        "ios": total_ios,
        "ios_pct": round(total_ios / total_visits * 100, 1) if total_visits else 0,
        "android": total_android,
        "android_pct": round(total_android / total_visits * 100, 1) if total_visits else 0,
        "top_os": os_rows[0] if os_rows else {},
        "ios_engagement": ios_row,
        "android_engagement": android_row,
        "mobile_trend": mobile_trend,
        "desktop_trend": desktop_trend,
    }


def render_report(config: dict, data: dict, summary: dict,
                  date_start: str, date_end: str) -> str:
    """Render HTML report from Jinja2 template."""
    with open(TEMPLATE_HTML) as f:
        tmpl = Template(f.read())

    cat_names = config.get("game_category_names", {})
    bonus_names = config.get("bonus_type_names", {})

    # Enrich game categories with names
    for row in data.get("game_categories", []):
        cat_id = row.get("game_category")
        row["cat_name"] = cat_names.get(int(cat_id), f"Cat {cat_id}") if cat_id else "Unknown"
        row["profit_rate"] = row["total_profit"] / row["total_bet"] * 100 if row.get("total_bet") else 0

    # Enrich top games
    for row in data.get("top_games", []):
        cat_id = row.get("game_category")
        row["cat_name"] = cat_names.get(int(cat_id), f"Cat {cat_id}") if cat_id else "Unknown"

    # Enrich bonus
    for row in data.get("bonus_breakdown", []):
        ct = row.get("change_type")
        row["type_name"] = bonus_names.get(int(ct), f"Type {ct}") if ct else "Unknown"

    # Matomo session summary
    matomo = data.get("matomo_sessions", [])
    matomo_summary = matomo[0] if matomo else {}

    return tmpl.render(
        title=config["report"]["title"],
        subtitle=config["report"]["subtitle"],
        date_start=date_start,
        date_end=date_end,
        generated_at=datetime.now().strftime("%Y-%m-%d %H:%M"),
        data=data,
        summary=summary,
        device_summary=compute_device_summary(data),
        cat_names=cat_names,
        bonus_names=bonus_names,
        matomo=matomo_summary,
    )


def main():
    parser = argparse.ArgumentParser(description="BG666 Report Generator")
    parser.add_argument("--end", help="End date (YYYY-MM-DD, default: today)")
    parser.add_argument("--days", type=int, default=7, help="Range in days (default: 7)")
    parser.add_argument("--skip-matomo", action="store_true", help="Skip Matomo queries")
    parser.add_argument("-o", "--output", help="Output HTML path")
    args = parser.parse_args()

    if args.end:
        date_end = args.end
    else:
        date_end = datetime.now().strftime("%Y-%m-%d")

    end_dt = datetime.strptime(date_end, "%Y-%m-%d")
    start_dt = end_dt - timedelta(days=args.days)
    date_start = start_dt.strftime("%Y-%m-%d")

    with open(REPORT_YAML) as f:
        config = yaml.safe_load(f)

    print(f"BG666 Report Generator")
    print(f"Range: {date_start} ~ {date_end} ({args.days} days)")
    print(f"{'=' * 50}")

    # 1. Run queries
    data = run_queries(config, date_start, date_end, skip_matomo=args.skip_matomo)

    # 2. Compute summary
    summary = compute_summary(data)

    # 3. Render HTML
    html = render_report(config, data, summary, date_start, date_end)

    # 4. Write output
    if args.output:
        out_path = Path(args.output).expanduser()
    else:
        out_dir = Path(config["defaults"]["output_dir"]).expanduser()
        out_path = out_dir / f"BG666深度分析_{date_start}_{date_end}.html"

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"\n{'=' * 50}")
    print(f"Report: {out_path}")
    print(f"Queries: {sum(1 for v in data.values() if v)} OK / {sum(1 for v in data.values() if not v)} empty")


if __name__ == "__main__":
    main()
