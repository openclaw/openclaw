import fs from "node:fs";
import { Pool, type PoolConfig } from "pg";

let pool: Pool | null = null;
let dbDisabledReason: string | null = null;

function loadMappedDbConfig(): PoolConfig | null {
  try {
    const raw = fs.readFileSync(`${process.env.HOME}/.openclaw/workspace/sql_memory_map.json`, "utf8");
    const postgres = JSON.parse(raw)?.postgres;
    if (!postgres?.host || !postgres?.database || !postgres?.user) return null;
    return {
      host: String(postgres.host),
      port: Number(postgres.port || 5432),
      database: String(postgres.database),
      user: String(postgres.user),
      password: typeof postgres.password === "string" ? postgres.password : undefined,
    };
  } catch {
    return null;
  }
}

function hasDbConfig() {
  return Boolean(
    process.env.PROMPT_DB_HOST?.trim() ||
      process.env.PROMPT_DB_NAME?.trim() ||
      process.env.PROMPT_DB_USER?.trim() ||
      process.env.PROMPT_DB_PASSWORD?.trim() ||
      loadMappedDbConfig(),
  );
}

export function getDbPool() {
  if (pool) return pool;

  if (!hasDbConfig()) {
    dbDisabledReason = "PROMPT_DB env not configured";
    return null;
  }

  const mappedConfig = loadMappedDbConfig();
  const config: PoolConfig = {
    ...(mappedConfig ?? {}),
    max: 2,
    idleTimeoutMillis: 8000,
    connectionTimeoutMillis: 3000,
  };

  if (process.env.PROMPT_DB_HOST?.trim()) config.host = process.env.PROMPT_DB_HOST.trim();
  if (process.env.PROMPT_DB_PORT?.trim()) config.port = Number(process.env.PROMPT_DB_PORT);
  if (process.env.PROMPT_DB_NAME?.trim()) config.database = process.env.PROMPT_DB_NAME.trim();
  if (process.env.PROMPT_DB_USER?.trim()) config.user = process.env.PROMPT_DB_USER.trim();
  if (process.env.PROMPT_DB_PASSWORD?.trim()) config.password = process.env.PROMPT_DB_PASSWORD;

  pool = new Pool(config);
  pool.on("error", (error) => {
    console.error("lan-chat db pool error", error);
  });

  return pool;
}

export function getDbDisabledReason() {
  return dbDisabledReason;
}
