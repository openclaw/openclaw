-- Public-safe Zorg MemoryDB baseline schema.
-- Structure only: no private rows, transcripts, credentials, uploads, or live operator state.

create extension if not exists pgcrypto;

create table if not exists zorg_logic_rules (
  id uuid primary key default gen_random_uuid(),
  rule_key text unique not null,
  rule_title text not null,
  rule_type text not null default 'operating_rule',
  priority text not null default 'normal',
  privacy text not null default 'public_safe',
  source_path text,
  rule_text text not null,
  applies_to text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists zorg_markdown_imports (
  id uuid primary key default gen_random_uuid(),
  source_path text not null,
  source_hash text not null,
  imported_at timestamptz not null default now(),
  imported_by text not null default 'zorg-memorydb-bootstrap',
  import_reason text not null default 'markdown_to_db_memory',
  is_active boolean not null default true,
  unique (source_path, source_hash)
);

create table if not exists memory_source_chunks (
  id uuid primary key default gen_random_uuid(),
  import_id uuid references zorg_markdown_imports(id) on delete set null,
  source_path text not null,
  line_start integer,
  line_end integer,
  content text not null,
  content_hash text not null,
  priority text not null default 'normal',
  created_at timestamptz not null default now(),
  unique (source_path, content_hash)
);

create table if not exists zorg_memory (
  id uuid primary key default gen_random_uuid(),
  memory_key text,
  memory_category text not null default 'general',
  memory_priority text not null default 'normal',
  memory_value text,
  chat_session_log text,
  system_prompt text,
  ai_response text,
  source_path text,
  logged_at timestamptz not null default now()
);

create table if not exists lan_chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_key text not null default 'agent:main:lan-chat',
  role text not null check (role in ('user','assistant','system','tool')),
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists memory_entities (
  id uuid primary key default gen_random_uuid(),
  entity_key text unique not null,
  entity_type text not null default 'concept',
  display_name text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists memory_associations (
  id uuid primary key default gen_random_uuid(),
  source_entity_key text not null,
  target_entity_key text not null,
  relation_type text not null default 'related',
  weight numeric not null default 1.0,
  evidence_source text,
  created_at timestamptz not null default now(),
  unique (source_entity_key, target_entity_key, relation_type)
);

create table if not exists memory_recall_hints (
  id uuid primary key default gen_random_uuid(),
  query_pattern text not null,
  target_table text not null,
  target_key text,
  weight numeric not null default 1.0,
  hint_text text not null,
  created_at timestamptz not null default now()
);

create table if not exists query_observations (
  id uuid primary key default gen_random_uuid(),
  query_text text not null,
  matched_source text,
  elapsed_ms integer,
  result_count integer,
  observed_at timestamptz not null default now()
);

create index if not exists idx_zorg_logic_rules_priority on zorg_logic_rules(priority);
create index if not exists idx_zorg_memory_logged_at on zorg_memory(logged_at desc);
create index if not exists idx_lan_chat_session_time on lan_chat_messages(session_key, created_at desc);
create index if not exists idx_memory_associations_source on memory_associations(source_entity_key, weight desc);
