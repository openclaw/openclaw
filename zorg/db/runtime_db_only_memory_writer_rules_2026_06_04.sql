-- Public-safe runtime DB-only memory writer and visible timing rules.
-- This publishes rule structure only. It contains no private memory rows,
-- credentials, contacts, transcripts, or live database dumps.

insert into public.zorg_logic_rules (
  rule_key,
  rule_title,
  rule_type,
  priority,
  privacy,
  source_path,
  rule_text,
  applies_to
)
values
(
  'db-memory-before-visible-response',
  'DB Memory Before Visible Response',
  'memory_rule',
  'critical',
  'public_safe',
  'zorg/db/runtime_db_only_memory_writer_rules_2026_06_04.sql',
  'Before any user-visible response, status update, question, blocker report, completion claim, tool-changing action, or file/config/database mutation, route through PostgreSQL-backed Zorg MemoryDB first. If DB recall is unavailable, repair or restore the DB path before normal response generation.',
  array['memory','recall','visible_reply','status_update','tool_use']
),
(
  'runtime-db-only-memory-writer-hard-stop',
  'Runtime DB-Only Memory Writer Hard Stop',
  'memory_rule',
  'critical',
  'public_safe',
  'zorg/db/runtime_db_only_memory_writer_rules_2026_06_04.sql',
  'DB-only installs must not allow OpenClaw runtime hooks to create retired markdown memory files such as memory/YYYY-MM-DD.md or memory/YYYY-MM-DD-HHMM.md. Patch or disable file-backed session-memory and pre-compaction memoryFlush writers. If a retired memory file still appears, import it into PostgreSQL and remove the filesystem copy after successful import.',
  array['memory','runtime','session-memory','memoryFlush','autoheal']
),
(
  'user-visible-timestamp-duration-rule',
  'User-Visible Timestamp / Duration Rule',
  'operating_rule',
  'critical',
  'public_safe',
  'zorg/db/runtime_db_only_memory_writer_rules_2026_06_04.sql',
  'Operational progress updates, blocker reports, completion claims, and final source-channel replies must include concrete timestamps when timing is relevant or after timing behavior has been challenged. Use the inbound message timestamp as request time, the actual send time as response time, and compute duration from those two real values only after the response time is known.',
  array['visible_reply','timing','duration','status_update']
)
on conflict (rule_key) do update
set rule_title = excluded.rule_title,
    rule_type = excluded.rule_type,
    priority = excluded.priority,
    privacy = excluded.privacy,
    source_path = excluded.source_path,
    rule_text = excluded.rule_text,
    applies_to = excluded.applies_to,
    updated_at = now();
