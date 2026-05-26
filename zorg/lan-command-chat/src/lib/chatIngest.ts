import { createHash } from "node:crypto";

import { getDbPool } from "@/lib/db";

type ChatRole = "user" | "assistant" | "system";

type ProjectMatch = {
  projectKey: string;
  projectName: string;
  alias: string;
};

function makeMessageKey(input: { sessionKey: string; source: string; role: string; message: string; messageId?: string | null; timestamp?: number | null }) {
  const stable = input.messageId || `${input.role}:${input.timestamp ?? "na"}:${input.message}`;
  const digest = createHash("sha1").update(stable).digest("hex");
  return `chat:${input.sessionKey}:${input.source}:${input.role}:${digest}`;
}

function normalizeText(value: string) {
  return value.toLowerCase();
}

async function inferProjects(message: string): Promise<ProjectMatch[]> {
  const pool = getDbPool();
  if (!pool) return [];

  const normalizedMessage = normalizeText(message);
  const { rows } = await pool.query<{
    project_key: string;
    name: string;
    alias: string;
  }>(`
    SELECT p.project_key, p.name, a.alias
    FROM memory_project_aliases a
    JOIN memory_projects p ON p.project_key = a.project_key
    WHERE p.active = TRUE
    ORDER BY length(a.alias) DESC, a.alias ASC
  `);

  const matches: ProjectMatch[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const alias = (row.alias || "").trim();
    if (!alias) continue;
    if (!normalizedMessage.includes(alias.toLowerCase())) continue;
    if (seen.has(row.project_key)) continue;
    seen.add(row.project_key);
    matches.push({
      projectKey: row.project_key,
      projectName: row.name,
      alias,
    });
  }
  return matches.slice(0, 5);
}

function deriveCategory(role: ChatRole, projectMatches: ProjectMatch[]) {
  if (projectMatches.length > 0) {
    return `chat_project_${role}`;
  }
  return `chat_ingest_${role}`;
}

async function ensureCounterTables() {
  const pool = getDbPool();
  if (!pool) return false;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_write_counters (
      counter_key TEXT PRIMARY KEY,
      counter_value BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_write_events (
      id BIGSERIAL PRIMARY KEY,
      event_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_app_write_events_created_at
    ON app_write_events (created_at DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_activity_events (
      id BIGSERIAL PRIMARY KEY,
      activity_key TEXT NOT NULL,
      activity_type TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_app_activity_events_created_at
    ON app_activity_events (created_at DESC)
  `);

  return true;
}

export async function logChatToDb(input: {
  sessionKey: string;
  source: string;
  role: ChatRole;
  message: string;
  compiledPrompt?: string | null;
  attachmentSummary?: string | null;
  messageId?: string | null;
  timestamp?: number | null;
  projectHints?: ProjectMatch[] | null;
}) {
  const pool = getDbPool();
  if (!pool) {
    return {
      category: deriveCategory(input.role, []),
      projectMatches: [],
      inserted: false,
      degraded: true,
    };
  }

  const ready = await ensureCounterTables();
  if (!ready) {
    return {
      category: deriveCategory(input.role, []),
      projectMatches: [],
      inserted: false,
      degraded: true,
    };
  }

  const memoryKey = makeMessageKey(input);
  const projectMatches = input.projectHints ?? (await inferProjects(input.message));
  const category = deriveCategory(input.role, projectMatches);

  const result = await pool.query<{ inserted: number }>(
    `
    WITH inserted AS (
      INSERT INTO zorg_memory (
        chat_session_log,
        logged_at,
        system_prompt,
        memory_key,
        memory_value,
        memory_effective_date,
        memory_category,
        memory_priority,
        memory_active
      )
      SELECT
        $1,
        NOW(),
        $2,
        $3,
        $4,
        CURRENT_DATE,
        $5,
        $6,
        TRUE
      WHERE NOT EXISTS (
        SELECT 1 FROM zorg_memory WHERE memory_key = $3
      )
      RETURNING 1 AS inserted
    ),
    counter_upsert AS (
      INSERT INTO app_write_counters (counter_key, counter_value, updated_at)
      SELECT 'memory_table_writes', COUNT(*), NOW()
      FROM inserted
      WHERE EXISTS (SELECT 1 FROM inserted)
      ON CONFLICT (counter_key)
      DO UPDATE SET
        counter_value = app_write_counters.counter_value + EXCLUDED.counter_value,
        updated_at = NOW()
      RETURNING 1
    ),
    event_insert AS (
      INSERT INTO app_write_events (event_key)
      SELECT $3
      FROM inserted
      RETURNING 1
    )
    SELECT COUNT(*)::int AS inserted FROM inserted
  `,
    [
      input.message,
      input.compiledPrompt ?? null,
      memoryKey,
      JSON.stringify({
        sessionKey: input.sessionKey,
        source: input.source,
        role: input.role,
        message: input.message,
        compiledPrompt: input.compiledPrompt ?? null,
        attachmentSummary: input.attachmentSummary ?? null,
        messageId: input.messageId ?? null,
        timestamp: input.timestamp ?? null,
        recordedAt: new Date().toISOString(),
        projects: projectMatches,
        projectKeys: projectMatches.map((item) => item.projectKey),
        category,
      }),
      category,
      "high",
    ],
  );

  const inserted = (result.rows[0]?.inserted ?? 0) > 0;

  return {
    category,
    projectMatches,
    inserted,
  };
}

export async function logInboundChatToDb(input: {
  sessionKey: string;
  source: string;
  message: string;
  compiledPrompt?: string | null;
  attachmentSummary?: string | null;
}) {
  return logChatToDb({
    sessionKey: input.sessionKey,
    source: input.source,
    role: "user",
    message: input.message,
    compiledPrompt: input.compiledPrompt ?? null,
    attachmentSummary: input.attachmentSummary ?? null,
  });
}

export async function logAppActivity(input: {
  activityKey: string;
  activityType: "chat_send" | "chat_history" | "assistant_message";
}) {
  const pool = getDbPool();
  if (!pool) return { inserted: false, degraded: true };

  const ready = await ensureCounterTables();
  if (!ready) return { inserted: false, degraded: true };

  await pool.query(`INSERT INTO app_activity_events (activity_key, activity_type) VALUES ($1, $2)`, [input.activityKey, input.activityType]);
  return { inserted: true };
}
