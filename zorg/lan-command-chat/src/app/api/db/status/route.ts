import { NextResponse } from "next/server";
import fs from "node:fs";
import { getDbPool } from "@/lib/db";

export const runtime = "nodejs";

type SampleRow = {
  stats_reset: Date | string | null;
  xact_commit: string | number | null;
  xact_rollback: string | number | null;
  tup_inserted: string | number | null;
  tup_updated: string | number | null;
  tup_deleted: string | number | null;
  blks_hit: string | number | null;
  blks_read: string | number | null;
  temp_files: string | number | null;
  temp_bytes: string | number | null;
  blk_read_time: string | number | null;
  blk_write_time: string | number | null;
  size_bytes: string | number | null;
  blocked_queries: string | number | null;
  slow_queries: string | number | null;
  longest_query_seconds: string | number | null;
  total_queries: string | number | null;
};

type PreviousSample = {
  sampledAtMs: number;
  xactTotal: number;
  writeTotal: number;
  blksHit: number;
  blksRead: number;
  totalQueries: number;
};

let previousSample: PreviousSample | null = null;

type CpuTimes = {
  total: number;
  idle: number;
};

let previousCpuTimes: CpuTimes | null = null;

function toNumber(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function readCpuTimes(): CpuTimes | null {
  try {
    const line = fs.readFileSync("/proc/stat", "utf8").split("\n").find((entry) => entry.startsWith("cpu "));
    if (!line) return null;
    const values = line.trim().split(/\s+/).slice(1).map((value) => Number(value));
    if (!values.length || values.some((value) => !Number.isFinite(value))) return null;
    const idle = (values[3] || 0) + (values[4] || 0);
    const total = values.reduce((sum, value) => sum + value, 0);
    return { total, idle };
  } catch {
    return null;
  }
}

function getCpuBaseGHz() {
  try {
    const cpuInfo = fs.readFileSync("/proc/cpuinfo", "utf8");
    const modelMhz = [...cpuInfo.matchAll(/@\s*([0-9.]+)GHz/gim)]
      .map((match) => Number(match[1]))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (modelMhz.length) return modelMhz[0];
    const currentMhz = [...cpuInfo.matchAll(/^cpu MHz\s*:\s*([0-9.]+)/gim)]
      .map((match) => Number(match[1]))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (currentMhz.length) return currentMhz.reduce((sum, value) => sum + value, 0) / currentMhz.length / 1000;
  } catch {
    // fall through
  }
  return 0;
}

function getCpuMetric() {
  const current = readCpuTimes();
  const baseGHz = getCpuBaseGHz();
  const cores = Math.max(1, (fs.readFileSync("/proc/cpuinfo", "utf8").match(/^processor\s*:/gim) || []).length || 1);
  const capacityGHz = baseGHz > 0 ? baseGHz * cores : 0;
  let usageRatio = 0;

  if (current && previousCpuTimes) {
    const totalDelta = current.total - previousCpuTimes.total;
    const idleDelta = current.idle - previousCpuTimes.idle;
    if (totalDelta > 0) usageRatio = clamp((totalDelta - idleDelta) / totalDelta, 0, 1);
  }

  if (current) previousCpuTimes = current;

  return {
    usagePercent: Math.round(usageRatio * 1000) / 10,
    usedGHz: Math.round(capacityGHz * usageRatio * 100) / 100,
    baseGHz: Math.round(baseGHz * 100) / 100,
    capacityGHz: Math.round(capacityGHz * 100) / 100,
    cores,
  };
}

function getStorageMetric() {
  const path = process.env.PROMPT_DB_STORAGE_PATH?.trim() || process.env.DB_STORAGE_PATH?.trim() || "/";
  try {
    const stats = fs.statfsSync(path);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const usedPercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
    const freePercent = 100 - usedPercent;
    return {
      path,
      totalBytes,
      freeBytes,
      usedBytes,
      usedPercent: Math.round(usedPercent * 10) / 10,
      freePercent: Math.round(freePercent * 10) / 10,
      status: usedPercent >= 95 ? "hot" : usedPercent >= 90 ? "warn" : usedPercent >= 80 ? "busy" : usedPercent >= 70 ? "ok" : "great",
    };
  } catch {
    return {
      path,
      totalBytes: 0,
      freeBytes: 0,
      usedBytes: 0,
      usedPercent: 0,
      freePercent: 0,
      status: "warn",
    };
  }
}

function getMemoryMetric() {
  try {
    const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
    const values = Object.fromEntries(
      meminfo
        .split("\n")
        .map((line) => line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB$/))
        .filter((match): match is RegExpMatchArray => Boolean(match))
        .map((match) => [match[1], Number(match[2]) * 1024]),
    );
    const totalBytes = values.MemTotal || 0;
    const availableBytes = values.MemAvailable || values.MemFree || 0;
    const usedBytes = Math.max(0, totalBytes - availableBytes);
    const usedPercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
    return {
      totalBytes,
      availableBytes,
      usedBytes,
      usedPercent: Math.round(usedPercent * 10) / 10,
      status: usedPercent >= 95 ? "hot" : usedPercent >= 85 ? "warn" : usedPercent >= 75 ? "busy" : usedPercent >= 60 ? "ok" : "great",
    };
  } catch {
    return { totalBytes: 0, availableBytes: 0, usedBytes: 0, usedPercent: 0, status: "warn" };
  }
}

export async function GET() {
  try {
    const storageMetric = getStorageMetric();
    const memoryMetric = getMemoryMetric();
    const cpuMetric = getCpuMetric();
    const pool = getDbPool();
    if (!pool) {
      return NextResponse.json({
        sampledAt: new Date().toISOString(),
        statsResetAt: null,
        metrics: {
          queriesPerSecond: { value: 0, min: 0, max: 5, unit: "qps", status: "steady" },
          cacheHitRatio: { value: 0, min: 0, max: 100, unit: "%", status: "warn" },
          writesPerSecond: { value: 0, min: 0, max: 5, unit: "writes/s", status: "steady" },
          dbSize: { value: storageMetric.usedPercent, min: 0, max: 100, unit: "% full", status: storageMetric.status },
        },
        details: {
          blockedQueries: 0,
          slowQueries: 0,
          longestQuerySeconds: 0,
          tempBytes: 0,
          tempFiles: 0,
          readTimeMs: 0,
          writeTimeMs: 0,
          commits: 0,
          rollbacks: 0,
          storagePath: storageMetric.path,
          storageFreeBytes: storageMetric.freeBytes,
          storageTotalBytes: storageMetric.totalBytes,
          storageUsedBytes: storageMetric.usedBytes,
          storageFreePercent: storageMetric.freePercent,
          cpuGHz: cpuMetric.usedGHz,
          cpuUsagePercent: cpuMetric.usagePercent,
          cpuBaseGHz: cpuMetric.baseGHz,
          cpuCapacityGHz: cpuMetric.capacityGHz,
          cpuCores: cpuMetric.cores,
          memoryTotalBytes: memoryMetric.totalBytes,
          memoryAvailableBytes: memoryMetric.availableBytes,
          memoryUsedBytes: memoryMetric.usedBytes,
          memoryUsedPercent: memoryMetric.usedPercent,
          memoryStatus: memoryMetric.status,
        },
        healthScore: 0,
        degraded: true,
      });
    }
    const hasPgStatStatements = await pool
      .query<{ exists: boolean }>("select exists (select 1 from pg_extension where extname = 'pg_stat_statements') as exists")
      .then((result) => Boolean(result.rows[0]?.exists))
      .catch(() => false);

    const sql = hasPgStatStatements
      ? `
      with db as (
        select *
        from pg_stat_database
        where datname = current_database()
      ),
      activity as (
        select
          count(*) filter (where wait_event_type is not null and state = 'active')::bigint as blocked_queries,
          count(*) filter (where state = 'active' and now() - query_start > interval '2 seconds')::bigint as slow_queries,
          coalesce(max(extract(epoch from (now() - query_start))) filter (where state = 'active'), 0)::numeric as longest_query_seconds
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
      ),
      statements as (
        select coalesce(sum(calls), 0)::bigint as total_queries
        from pg_stat_statements
        where dbid = (select oid from pg_database where datname = current_database())
          and query not ilike '%pg_stat%'
      )
      select
        db.stats_reset,
        db.xact_commit,
        db.xact_rollback,
        db.tup_inserted,
        db.tup_updated,
        db.tup_deleted,
        db.blks_hit,
        db.blks_read,
        db.temp_files,
        db.temp_bytes,
        db.blk_read_time,
        db.blk_write_time,
        pg_database_size(current_database())::bigint as size_bytes,
        activity.blocked_queries,
        activity.slow_queries,
        activity.longest_query_seconds,
        statements.total_queries
      from db, activity, statements
      limit 1
    `
      : `
      with db as (
        select *
        from pg_stat_database
        where datname = current_database()
      ),
      activity as (
        select
          count(*) filter (where wait_event_type is not null and state = 'active')::bigint as blocked_queries,
          count(*) filter (where state = 'active' and now() - query_start > interval '2 seconds')::bigint as slow_queries,
          coalesce(max(extract(epoch from (now() - query_start))) filter (where state = 'active'), 0)::numeric as longest_query_seconds
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
      )
      select
        db.stats_reset,
        db.xact_commit,
        db.xact_rollback,
        db.tup_inserted,
        db.tup_updated,
        db.tup_deleted,
        db.blks_hit,
        db.blks_read,
        db.temp_files,
        db.temp_bytes,
        db.blk_read_time,
        db.blk_write_time,
        pg_database_size(current_database())::bigint as size_bytes,
        activity.blocked_queries,
        activity.slow_queries,
        activity.longest_query_seconds,
        (db.xact_commit + db.xact_rollback)::bigint as total_queries
      from db, activity
      limit 1
    `;
    const { rows } = await pool.query<SampleRow>(sql);
    const row = rows[0];
    if (!row) return NextResponse.json({ error: "No database stats returned" }, { status: 500 });

    const sampledAtMs = Date.now();
    const blksHit = toNumber(row.blks_hit);
    const blksRead = toNumber(row.blks_read);
    const xactTotal = toNumber(row.xact_commit) + toNumber(row.xact_rollback);
    const writeTotal = toNumber(row.tup_inserted) + toNumber(row.tup_updated) + toNumber(row.tup_deleted);
    const totalQueries = toNumber(row.total_queries);

    let qps = 0;
    let writesPerSecond = 0;
    let cacheHitRatio = (() => {
      const totalBlocks = blksHit + blksRead;
      return totalBlocks > 0 ? (blksHit / totalBlocks) * 100 : 100;
    })();

    if (previousSample) {
      const elapsedMs = sampledAtMs - previousSample.sampledAtMs;
      if (elapsedMs > 0) {
        const deltaSeconds = elapsedMs / 1000;
        const deltaQueries = Math.max(0, totalQueries - previousSample.totalQueries);
        const deltaWrites = Math.max(0, writeTotal - previousSample.writeTotal);
        const deltaHit = Math.max(0, blksHit - previousSample.blksHit);
        const deltaRead = Math.max(0, blksRead - previousSample.blksRead);
        const deltaTotalBlocks = deltaHit + deltaRead;
        qps = deltaSeconds > 0 ? deltaQueries / deltaSeconds : 0;
        writesPerSecond = deltaSeconds > 0 ? deltaWrites / deltaSeconds : 0;
        if (deltaTotalBlocks > 0) cacheHitRatio = (deltaHit / deltaTotalBlocks) * 100;
      }
    }

    previousSample = { sampledAtMs, xactTotal, writeTotal, blksHit, blksRead, totalQueries };

    const blockedQueries = toNumber(row.blocked_queries);
    const slowQueries = toNumber(row.slow_queries);
    const longestQuerySeconds = toNumber(row.longest_query_seconds);
    const dbSizeBytes = toNumber(row.size_bytes);
    const tempBytes = toNumber(row.temp_bytes);
    const tempFiles = toNumber(row.temp_files);
    const readTimeMs = toNumber(row.blk_read_time);
    const writeTimeMs = toNumber(row.blk_write_time);

    return NextResponse.json({
      sampledAt: new Date().toISOString(),
      statsResetAt: row.stats_reset ? new Date(row.stats_reset).toISOString() : null,
      metrics: {
        queriesPerSecond: {
          value: Math.round(qps * 100) / 100,
          min: 0,
          max: Math.max(5, Math.ceil(qps / 5) * 5 || 5),
          unit: "qps",
          status: qps > 20 ? "hot" : qps > 5 ? "busy" : "steady",
        },
        cacheHitRatio: {
          value: Math.round(cacheHitRatio * 10) / 10,
          min: 0,
          max: 100,
          unit: "%",
          status: cacheHitRatio < 90 ? "warn" : cacheHitRatio < 97 ? "ok" : "great",
        },
        writesPerSecond: {
          value: Math.round(writesPerSecond * 100) / 100,
          min: 0,
          max: Math.max(5, Math.ceil(writesPerSecond / 5) * 5 || 5),
          unit: "writes/s",
          status: writesPerSecond > 20 ? "hot" : writesPerSecond > 5 ? "busy" : "steady",
        },
        dbSize: {
          value: storageMetric.usedPercent,
          min: 0,
          max: 100,
          unit: "% full",
          status: storageMetric.status,
        },
      },
      details: {
        blockedQueries,
        slowQueries,
        longestQuerySeconds: Math.round(longestQuerySeconds * 10) / 10,
        tempBytes,
        tempFiles,
        readTimeMs: Math.round(readTimeMs),
        writeTimeMs: Math.round(writeTimeMs),
        commits: toNumber(row.xact_commit),
        rollbacks: toNumber(row.xact_rollback),
        dbSizeBytes,
        storagePath: storageMetric.path,
        storageFreeBytes: storageMetric.freeBytes,
        storageTotalBytes: storageMetric.totalBytes,
        storageUsedBytes: storageMetric.usedBytes,
        storageFreePercent: storageMetric.freePercent,
        cpuGHz: cpuMetric.usedGHz,
        cpuUsagePercent: cpuMetric.usagePercent,
        cpuBaseGHz: cpuMetric.baseGHz,
        cpuCapacityGHz: cpuMetric.capacityGHz,
        cpuCores: cpuMetric.cores,
        memoryTotalBytes: memoryMetric.totalBytes,
        memoryAvailableBytes: memoryMetric.availableBytes,
        memoryUsedBytes: memoryMetric.usedBytes,
        memoryUsedPercent: memoryMetric.usedPercent,
        memoryStatus: memoryMetric.status,
      },
      healthScore: clamp(
        Math.round(100 - blockedQueries * 18 - slowQueries * 10 - Math.min(longestQuerySeconds * 4, 35) - Math.max(0, 95 - cacheHitRatio) * 1.2),
        0,
        100,
      ),
    });
  } catch (error) {
    console.error("db status failed", error);
    const storageMetric = getStorageMetric();
    const memoryMetric = getMemoryMetric();
    const cpuMetric = getCpuMetric();
    return NextResponse.json({
      sampledAt: new Date().toISOString(),
      statsResetAt: null,
      metrics: {
        queriesPerSecond: { value: 0, min: 0, max: 5, unit: "qps", status: "steady" },
        cacheHitRatio: { value: 0, min: 0, max: 100, unit: "%", status: "warn" },
        writesPerSecond: { value: 0, min: 0, max: 5, unit: "writes/s", status: "steady" },
        dbSize: { value: storageMetric.usedPercent, min: 0, max: 100, unit: "% full", status: storageMetric.status },
      },
      details: {
        blockedQueries: 0,
        slowQueries: 0,
        longestQuerySeconds: 0,
        tempBytes: 0,
        tempFiles: 0,
        readTimeMs: 0,
        writeTimeMs: 0,
        commits: 0,
        rollbacks: 0,
        storagePath: storageMetric.path,
        storageFreeBytes: storageMetric.freeBytes,
        storageTotalBytes: storageMetric.totalBytes,
        storageUsedBytes: storageMetric.usedBytes,
        storageFreePercent: storageMetric.freePercent,
        cpuGHz: cpuMetric.usedGHz,
        cpuUsagePercent: cpuMetric.usagePercent,
        cpuBaseGHz: cpuMetric.baseGHz,
        cpuCapacityGHz: cpuMetric.capacityGHz,
        cpuCores: cpuMetric.cores,
        memoryTotalBytes: memoryMetric.totalBytes,
        memoryAvailableBytes: memoryMetric.availableBytes,
        memoryUsedBytes: memoryMetric.usedBytes,
        memoryUsedPercent: memoryMetric.usedPercent,
        memoryStatus: memoryMetric.status,
      },
      healthScore: 0,
      degraded: true,
    });
  }
}
