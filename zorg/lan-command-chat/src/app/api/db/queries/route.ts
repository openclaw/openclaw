import { NextResponse } from "next/server";
import { getDbPool } from "@/lib/db";

export const runtime = "nodejs";

type QueryRow = {
  pid: number | null;
  state: string | null;
  wait_event_type: string | null;
  query_age_seconds: string | number | null;
  query_start_at: Date | string | null;
  backend_type: string | null;
  query_text: string | null;
};

function toNumber(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function compactText(text: string | null, max = 260) {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

export async function GET() {
  try {
    const pool = getDbPool();
    if (!pool) {
      return NextResponse.json({ sampledAt: new Date().toISOString(), entries: [], degraded: true });
    }

    const { rows } = await pool.query<QueryRow>(`
      SELECT
        pid,
        state,
        wait_event_type,
        query_start AS query_start_at,
        backend_type,
        COALESCE(EXTRACT(EPOCH FROM (now() - query_start)), 0)::numeric AS query_age_seconds,
        query AS query_text
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND query IS NOT NULL
        AND btrim(query) <> ''
        AND state IS DISTINCT FROM 'idle'
      ORDER BY query_start ASC NULLS LAST
      LIMIT 40
    `);

    return NextResponse.json({
      sampledAt: new Date().toISOString(),
      entries: rows.map((row, index) => ({
        id: `pid-${row.pid ?? index}`,
        kind: "query",
        title: `pid ${row.pid ?? "n/a"} · ${row.backend_type ?? "backend"}`,
        query: compactText(row.query_text, 260),
        result: `${row.state ?? "unknown"} · ${Math.round(toNumber(row.query_age_seconds) * 10) / 10}s${row.wait_event_type ? ` · ${row.wait_event_type}` : ""}${row.query_start_at ? ` · started ${new Date(row.query_start_at).toLocaleTimeString()}` : ""}`,
      })),
    });
  } catch (error) {
    console.error("db queries failed", error);
    return NextResponse.json({ error: "Failed to load live queries" }, { status: 500 });
  }
}
