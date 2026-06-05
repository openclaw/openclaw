# Zorg MemoryDB Public Install Rules

These are public-safe production rules for the Zorg MemoryDB package.

## DB-Only Durable Memory

Zorg MemoryDB uses PostgreSQL-backed memory as the durable memory surface. `MEMORY.md` and `memory/` markdown files are not active memory. If retired memory markdown files are discovered, import them into the database with the markdown import tool and stop using the files for active recall.

## Runtime DB-Only Writer Hard Stop

Runtime hooks must not create retired `memory/YYYY-MM-DD.md` or `memory/YYYY-MM-DD-HHMM.md` files. Session-memory, memoryFlush, compaction, heartbeat, and generated-note paths must write durable memory through PostgreSQL-backed ingestion. If a retired markdown memory file is found anyway, import it into `zorg_memory_file_archive` and searchable memory rows, then remove the file after successful import.

## User-Visible Timestamp And Duration Rule

Operational replies must include the operator request timestamp, the actual response/send timestamp, and elapsed duration computed from those two timestamps. Do not pre-calculate duration from work-start time or omit timestamps when reporting memory, repair, publication, or system changes.

## Preserve Structure And Rule Data

Active rules belong in `zorg_logic_rules`. Older compatibility surfaces such as
`zorg_rules` and `zorg_rule_catalog` may remain for upgrade compatibility, but
they must not remain active rule-recall sources after canonical migration.

Rules, markdown-import records, source chunks, recall hints, entity tables,
dynamic rule weights, and association tables are structural memory. Preserve
them during clean installs, upgrades, and migrations.

## Public Baseline

The public package must not contain private live memory rows, transcripts, credentials, contact data, uploads, or operator-only context. The distributable baseline keeps schema and public-safe rules only. Ordinary private/user tables start empty on a clean install.

## Backup Boundary

Before production DB structural, indexing, materialized-view, recall-routing,
vector, weighted-memory, or schema changes, create and verify a temporary local
PostgreSQL backup only. Do not commit, mirror, or push live database dumps,
rows, contacts, transcripts, credentials, or private memory to GitHub from the
public MemoryDB update path.

## LAN Command Chat

LAN command chat is packaged as fallback local communication infrastructure. The default service listens on port 3001 unless `LAN_CHAT_PORT` overrides it.
