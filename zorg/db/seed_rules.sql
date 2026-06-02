-- Public-safe starter rules for Zorg MemoryDB installs.
insert into zorg_logic_rules (rule_key, rule_title, rule_type, priority, privacy, source_path, rule_text, applies_to)
values
('db-only-memory', 'DB-only durable memory', 'memory_rule', 'critical', 'public_safe', 'zorg/rules/PRODUCTION_MEMORY_RULES.md',
 'Durable memory belongs in PostgreSQL-backed Zorg MemoryDB tables. MEMORY.md and memory/ markdown files are not active memory surfaces. If memory markdown files are discovered, import them into the database and retire them from active recall rather than using them as fallback memory.',
 array['memory','recall','markdown-import']),
('preserve-source-history', 'Preserve original memory source history', 'memory_rule', 'critical', 'public_safe', 'zorg/rules/PRODUCTION_MEMORY_RULES.md',
 'Never prune, delete, truncate, age out, or compact away original/source memory data for performance. Improve recall only with additive indexes, associations, entities, summaries, vectors, materialized views, and query observations.',
 array['database','performance','recall']),
('lan-command-chat-continuity', 'LAN command chat continuity', 'communication_rule', 'high', 'public_safe', 'zorg/rules/PRODUCTION_MEMORY_RULES.md',
 'LAN command chat is fallback communication infrastructure. The clean install should provision it with the database and keep it available on the configured LAN chat port.',
 array['lan-chat','install','communication']),
('approval-before-mutation', 'Approval before mutation', 'operating_rule', 'critical', 'public_safe', 'zorg/rules/PRODUCTION_MEMORY_RULES.md',
 'Before changing files, services, configuration, database schema, documentation, or external state, summarize the exact intended change and wait for explicit approval unless the operator has already authorized that exact corrective action.',
 array['operations','change-control']),
('public-safe-package-only', 'Public-safe package only', 'publication_rule', 'critical', 'public_safe', 'zorg/rules/PRODUCTION_MEMORY_RULES.md',
 'The public Zorg_MemoryDB repository may publish structure, schema, scripts, templates, and documentation only. Do not publish private memory rows, credentials, transcripts, contact data, live uploads, or operator-only context.',
 array['github','publication']),
('canonical-logic-rules-active-surface', 'Canonical logic rules active surface', 'memory_rule', 'critical', 'public_safe', 'zorg/rules/PRODUCTION_MEMORY_RULES.md',
 'Active operating rules belong in zorg_logic_rules. Older compatibility rule surfaces such as zorg_rules and zorg_rule_catalog may remain for upgrade compatibility, but they must not remain active rule-recall sources after canonical migration.',
 array['memory','rules','recall','upgrade']),
('temporary-local-db-backup-only', 'Temporary local DB backup only', 'recovery_rule', 'critical', 'public_safe', 'zorg/rules/PRODUCTION_MEMORY_RULES.md',
 'Before production database structural, indexing, materialized-view, recall-routing, vector, weighted-memory, or schema changes, create and verify a temporary local PostgreSQL backup only. Do not commit, mirror, or push live database dumps to GitHub.',
 array['database','backup','recovery','github','publication']),
('chat-timing-rule-weight-update', 'Chat timing rule weight update', 'communication_rule', 'critical', 'public_safe', 'zorg/rules/PRODUCTION_MEMORY_RULES.md',
 'When an install carries operator-visible chat timing rules, raise their existing dynamic weights in zorg_logic_rule_dynamic_weights instead of creating replacement timing rules.',
 array['chat','timing','dynamic-weight','rules'])
on conflict (rule_key) do update
set rule_title = excluded.rule_title, rule_type = excluded.rule_type, priority = excluded.priority,
    privacy = excluded.privacy, source_path = excluded.source_path, rule_text = excluded.rule_text,
    applies_to = excluded.applies_to, updated_at = now();
