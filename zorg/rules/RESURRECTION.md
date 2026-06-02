# RESURRECTION.md - Database Memory Resurrection Runbook

This file is the filesystem-first recovery contract for a damaged or empty
Zorg/OpenClaw memory database. It exists so a clean install, upgrade, or new
agent can restore memory even when PostgreSQL recall is broken and the database
cannot remind the agent how to recover.

Read this file before trusting any database-backed memory result during a
memory outage.

## Recovery Goal

Restore the PostgreSQL-backed memory database, verify recall, then return to
normal DB-first operation. Do not recreate retired durable markdown memory as a
fallback.

## Critical Paths

- Workspace: `/home/openclaw/.openclaw/workspace`
- DB config: `/home/openclaw/.openclaw/workspace/sql_memory_map.json`
- Recovery pointer: `/home/openclaw/.openclaw/workspace/ZORG_MEMORYDB_MASTER_RULES.md`
- Local temporary backup directory: `/home/openclaw/.openclaw/backups/postgres/tmp`
- Separately approved private/off-host mirrors may exist in local operator
  documentation, but live DB dumps must not be committed, mirrored, or pushed to
  GitHub from the public MemoryDB update path.
- Backup script: `/home/openclaw/.openclaw/workspace/scripts/postgres_memory_backup.sh`
- Restore/drill script: `/home/openclaw/.openclaw/workspace/scripts/postgres_memory_recovery.sh`
- Recall CLI: `/home/openclaw/.openclaw/workspace/memory_sql_tool.py`
- Speed test: `/home/openclaw/.openclaw/workspace/memory_speed_test.py`

## Find The Latest Backup

```bash
cd /home/openclaw/.openclaw/backups/postgres/tmp
ls -1t zorgdb-*.sql.gz | head
ls -1t zorgdb-schema-*.sql.gz | head
sha256sum -c zorgdb-*.sql.gz.sha256 2>/dev/null || true
```

If the local full dump is missing, search only separately approved private or
encrypted recovery locations documented by the operator. Do not infer a GitHub
backup path and do not publish live database dumps while recovering.

## Restore PostgreSQL Memory

This backup format is plain SQL compressed with gzip. Restore into an empty or
throwaway `zorgdb` first whenever possible.

Use the scripted drill first:

```bash
cd /home/openclaw/.openclaw/workspace
bash scripts/postgres_memory_recovery.sh list
bash scripts/postgres_memory_recovery.sh drill /path/to/zorgdb-YYYY-MM-DD_HHMMSS.sql.gz
```

Only after a drill passes and the operator has approved replacing active state:

```bash
CONFIRM_RESTORE_ACTIVE=YES \
  bash scripts/postgres_memory_recovery.sh restore-active /path/to/zorgdb-YYYY-MM-DD_HHMMSS.sql.gz
```

Manual fallback:

```bash
cd /home/openclaw/.openclaw/workspace

# Confirm the database container/service.
docker ps --filter name=local-postgres
docker exec local-postgres psql -U zorg -d postgres -Atqc "select now();"

# Create a clean recovery target. Drop only the throwaway restore DB.
docker exec local-postgres psql -U zorg -d postgres -c "drop database if exists zorgdb_restore;"
docker exec local-postgres psql -U zorg -d postgres -c "create database zorgdb_restore;"

# Load the latest local full dump.
zcat /home/openclaw/.openclaw/backups/postgres/tmp/zorgdb-YYYY-MM-DD_HHMMSS.sql.gz \
  | docker exec -i local-postgres psql -U zorg -d zorgdb_restore
```

If `zorgdb` itself must be replaced after a verified test restore:

```bash
docker exec local-postgres psql -U zorg -d postgres -c \
  "select pg_terminate_backend(pid) from pg_stat_activity where datname='zorgdb';"
docker exec local-postgres psql -U zorg -d postgres -c "drop database if exists zorgdb;"
docker exec local-postgres psql -U zorg -d postgres -c "alter database zorgdb_restore rename to zorgdb;"
```

## Verify Recall After Restore

```bash
cd /home/openclaw/.openclaw/workspace
/home/openclaw/.openclaw/workspace/memory_sql_tool.py tables
/home/openclaw/.openclaw/workspace/memory_sql_tool.py search "database before work rules before work" --table all --limit 10
/home/openclaw/.openclaw/workspace/memory_sql_tool.py search "resurrection restore backup memory database" --table all --limit 10
/home/openclaw/.openclaw/workspace/memory_speed_test.py
```

Expected result: table listing succeeds, recall returns DB-backed rules, and the
speed test completes. If search returns only stale or unrelated rows, repair
materialized/search views before claiming recovery.

## Rebuild Recall Surfaces

After a restore, refresh derived recall/search structures:

```bash
cd /home/openclaw/.openclaw/workspace
/home/openclaw/.openclaw/workspace/.venv-sqlmem/bin/python \
  /home/openclaw/.openclaw/workspace/scripts/sync_core_rules_to_logic_rules.py

OPENCLAW_WORKSPACE=/home/openclaw/.openclaw/workspace \
  /home/openclaw/.openclaw/workspace/.venv-sqlmem/bin/python \
  /home/openclaw/.openclaw/workspace/Zorg_MemoryDB/scripts/import_markdown_memory.py
```

Then run the verification commands again.

## If Docker Is Unavailable

Read `sql_memory_map.json` and connect to the configured host/port with `psql`.
Use the same SQL restore stream:

```bash
zcat /path/to/zorgdb.sql.gz | psql "postgresql://USER:PASSWORD@HOST:PORT/zorgdb_restore"
```

## Resurrection Rule

Backups are not considered meaningful unless this file, the master recovery
pointer, and the bootstrap markdown files tell a new agent where the backups are
and how to restore them. Keep this runbook small, concrete, and filesystem
discoverable.
