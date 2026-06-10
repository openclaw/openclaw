-- Public-safe Zorg MemoryDB baseline schema.
-- Structure only: no private rows, transcripts, credentials, uploads, or live operator state.

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
create extension if not exists vector;

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
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists zorg_logic_rules
  add column if not exists active boolean not null default true;

create table if not exists zorg_logic_rule_dynamic_weights (
  rule_key text primary key,
  seed_weight numeric(12,5) not null default 1,
  dynamic_weight numeric(12,5) not null default 1,
  use_count integer not null default 0,
  positive_feedback_count integer not null default 0,
  negative_feedback_count integer not null default 0,
  last_recalled_at timestamptz,
  last_feedback_at timestamptz,
  feedback_basis text,
  metadata jsonb not null default '{}'::jsonb,
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

create table if not exists memory_semantic_edges (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null,
  subject_key text not null,
  relation text not null,
  object_type text not null,
  object_key text not null,
  weight numeric(8,5) not null default 1.0,
  weight_basis text,
  llm_reason text,
  source_model text,
  evidence_source text,
  evidence_hash text,
  metadata jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists memory_ann_model_embeddings (
  id uuid primary key default gen_random_uuid(),
  source_type text not null,
  source_key text not null,
  embedding_provider text not null default 'local',
  embedding_model text not null default 'embeddinggemma-300m-qat-q8_0',
  embedding_dim integer not null default 768,
  embedding vector(768) not null,
  content_hash text not null,
  content_text text not null,
  priority text,
  event_ts timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_type, source_key, embedding_provider, embedding_model, content_hash)
);

create table if not exists memory_query_embedding_cache (
  id uuid primary key default gen_random_uuid(),
  query_hash text not null,
  query_text text not null,
  embedding_provider text not null default 'local',
  embedding_model text not null default 'embeddinggemma-300m-qat-q8_0',
  embedding_dim integer not null default 768,
  embedding vector(768) not null,
  metadata jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (query_hash, embedding_provider, embedding_model)
);

create table if not exists memory_llm_scheduled_jobs (
  job_key text primary key,
  external_job_id text unique,
  source_scheduler text not null default 'openclaw-cron',
  name text not null,
  agent_id text not null default 'main',
  schedule jsonb not null,
  cron_expr text,
  timezone text not null default 'America/Los_Angeles',
  enabled boolean not null default true,
  session_target text not null default 'isolated',
  wake_mode text not null default 'now',
  payload jsonb not null,
  delivery jsonb not null default '{}'::jsonb,
  failure_alert jsonb,
  external_state jsonb not null default '{}'::jsonb,
  next_due_at timestamptz,
  last_enqueued_at timestamptz,
  enqueue_count bigint not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists memory_llm_job_queue (
  queue_id uuid primary key default gen_random_uuid(),
  job_key text not null references memory_llm_scheduled_jobs(job_key),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'cancelled')),
  due_at timestamptz not null default now(),
  payload_snapshot jsonb not null,
  delivery_snapshot jsonb not null default '{}'::jsonb,
  leased_by text,
  leased_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  attempts integer not null default 0,
  max_attempts integer not null default 2,
  result_summary text,
  stdout_text text,
  stderr_text text,
  error_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists memory_llm_scheduler_notes (
  note_id uuid primary key default gen_random_uuid(),
  note_kind text not null,
  note_text text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_zorg_logic_rules_priority on zorg_logic_rules(priority);
create index if not exists idx_zorg_memory_logged_at on zorg_memory(logged_at desc);
create index if not exists idx_lan_chat_session_time on lan_chat_messages(session_key, created_at desc);
create index if not exists idx_memory_associations_source on memory_associations(source_entity_key, weight desc);
create index if not exists idx_memory_semantic_edges_subject on memory_semantic_edges(subject_type, subject_key, relation) where active;
create index if not exists idx_memory_semantic_edges_object on memory_semantic_edges(object_type, object_key, relation) where active;
create index if not exists idx_memory_ann_model_embeddings_hnsw_cosine on memory_ann_model_embeddings using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
create index if not exists idx_memory_ann_model_embeddings_hnsw_active_local_cosine on memory_ann_model_embeddings using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64) where active and embedding_provider = 'local' and embedding_model = 'embeddinggemma-300m-qat-q8_0';
create index if not exists idx_memory_ann_model_embeddings_identity on memory_ann_model_embeddings(source_type, source_key, embedding_provider, embedding_model, content_hash);
create index if not exists idx_memory_ann_model_embeddings_priority on memory_ann_model_embeddings(priority, event_ts desc) where active;
create index if not exists idx_memory_ann_model_embeddings_source on memory_ann_model_embeddings(source_type, source_key) where active;
create index if not exists idx_memory_ann_model_embeddings_text_trgm on memory_ann_model_embeddings using gin (content_text gin_trgm_ops) where active;
create index if not exists idx_memory_llm_job_queue_claim on memory_llm_job_queue(status, due_at, created_at) where status = 'queued';
create index if not exists idx_memory_llm_job_queue_job_time on memory_llm_job_queue(job_key, created_at desc);
create index if not exists idx_memory_llm_scheduled_jobs_enabled on memory_llm_scheduled_jobs(enabled, next_due_at) where enabled;

create or replace view zorg_logic_rule_dynamic_ranking_v as
select
  r.rule_key,
  r.rule_title,
  r.priority,
  r.privacy,
  r.rule_type,
  coalesce(w.seed_weight, 1) as seed_weight,
  coalesce(w.dynamic_weight, 1) as dynamic_weight,
  coalesce(w.seed_weight, 1) * coalesce(w.dynamic_weight, 1) as effective_weight,
  coalesce(w.use_count, 0) as use_count,
  coalesce(w.positive_feedback_count, 0) as positive_feedback_count,
  coalesce(w.negative_feedback_count, 0) as negative_feedback_count,
  w.last_recalled_at,
  w.last_feedback_at,
  r.updated_at as rule_updated_at
from zorg_logic_rules r
left join zorg_logic_rule_dynamic_weights w on w.rule_key = r.rule_key;

create or replace function memory_provider_ann_recall(
  p_query text,
  p_limit integer default 20,
  p_provider text default 'local',
  p_model text default 'embeddinggemma-300m-qat-q8_0'
)
returns table(
  source_type text,
  source_id text,
  path text,
  line_start integer,
  line_end integer,
  priority text,
  content text,
  vector_distance double precision,
  vector_score numeric
)
language sql
stable
as $$
  with q as (
    select embedding
    from memory_query_embedding_cache
    where active
      and query_hash = md5(lower(btrim(coalesce(p_query, ''))))
      and embedding_provider = coalesce(p_provider, 'local')
      and embedding_model = coalesce(p_model, 'embeddinggemma-300m-qat-q8_0')
    order by updated_at desc
    limit 1
  )
  select
    e.source_type,
    e.source_key as source_id,
    null::text as path,
    null::integer as line_start,
    null::integer as line_end,
    coalesce(e.priority, 'medium') as priority,
    e.content_text as content,
    (e.embedding <=> q.embedding)::double precision as vector_distance,
    greatest(0, (1 - (e.embedding <=> q.embedding)))::numeric * 60 as vector_score
  from memory_ann_model_embeddings e, q
  where e.active
    and e.embedding_provider = coalesce(p_provider, 'local')
    and e.embedding_model = coalesce(p_model, 'embeddinggemma-300m-qat-q8_0')
    and (
      e.source_type <> 'logic_rule'
      or exists (
        select 1
        from zorg_logic_rules r
        where r.id::text = e.source_key
          and r.active
      )
    )
  order by e.embedding <=> q.embedding
  limit greatest(coalesce(p_limit, 20), 1);
$$;

create or replace function memory_ann_recall(p_query text, p_limit integer default 20)
returns table(
  source_type text,
  source_id text,
  path text,
  line_start integer,
  line_end integer,
  priority text,
  content text,
  vector_distance double precision,
  vector_score numeric
)
language sql
stable
as $$
  select *
  from memory_provider_ann_recall(
    p_query,
    greatest(coalesce(p_limit, 20), 1),
    'local',
    'embeddinggemma-300m-qat-q8_0'
  );
$$;

create or replace function memory_backfill_ann_embeddings(p_limit integer default 1000)
returns integer
language plpgsql
as $$
begin
  raise notice 'local-hash-v1-384 ANN backfill is retired; use scripts/backfill_model_ann_embeddings.mjs for real local model vectors';
  return 0;
end;
$$;

create or replace function memory_backfill_ann_embeddings_all(
  p_batch_size integer default 1000,
  p_max_batches integer default 100
)
returns integer
language plpgsql
as $$
begin
  raise notice 'local-hash-v1-384 ANN backfill is retired; use scripts/backfill_model_ann_embeddings.mjs for real local model vectors';
  return 0;
end;
$$;

create or replace function memory_strengthen_ann_neighbor_edges(p_limit integer default 200)
returns integer
language plpgsql
as $$
declare
  v_count integer := 0;
begin
  with seeds as (
    select source_type, source_key, embedding
    from memory_ann_model_embeddings
    where active
      and embedding_provider = 'local'
      and embedding_model = 'embeddinggemma-300m-qat-q8_0'
    order by updated_at desc, event_ts desc nulls last
    limit greatest(coalesce(p_limit, 200), 1)
  ), pairs as (
    select
      s.source_type as left_type,
      s.source_key as left_key,
      n.source_type as right_type,
      n.source_key as right_key,
      (s.embedding <=> n.embedding)::double precision as distance
    from seeds s
    cross join lateral (
      select source_type, source_key, embedding
      from memory_ann_model_embeddings n
      where n.active
        and n.embedding_provider = 'local'
        and n.embedding_model = 'embeddinggemma-300m-qat-q8_0'
        and not (n.source_type = s.source_type and n.source_key = s.source_key)
      order by n.embedding <=> s.embedding
      limit 3
    ) n
    where (s.embedding <=> n.embedding) < 0.42
  ), ins as (
    insert into memory_semantic_edges(
      subject_type,
      subject_key,
      relation,
      object_type,
      object_key,
      weight,
      weight_basis,
      llm_reason,
      source_model,
      evidence_source,
      evidence_hash,
      metadata
    )
    select
      left_type,
      left_key,
      'ann_nearest_neighbor',
      right_type,
      right_key,
      greatest(0.5, round(((1.0 - distance) * 6.0)::numeric, 4)),
      'pgvector nearest-neighbor maintenance distance=' || round(distance::numeric, 4),
      'Derived ANN/vector neighbor edge: these recall records are close in the local model pgvector space.',
      'memory-neural-maintenance-v2',
      'memory_strengthen_ann_neighbor_edges',
      md5(left_type || ':' || left_key || '->' || right_type || ':' || right_key || ':' || round(distance::numeric, 4)::text),
      jsonb_build_object('distance', distance, 'source', 'local-embeddinggemma-768')
    from pairs
    where not exists (
      select 1
      from memory_semantic_edges e
      where e.active
        and e.subject_type = pairs.left_type
        and e.subject_key = pairs.left_key
        and e.relation = 'ann_nearest_neighbor'
        and e.object_type = pairs.right_type
        and e.object_key = pairs.right_key
    )
    on conflict do nothing
    returning 1
  )
  select count(*) into v_count from ins;

  return v_count;
end;
$$;

create or replace function memory_llm_enqueue_job(p_job_key text)
returns uuid
language plpgsql
as $$
declare
  v_job memory_llm_scheduled_jobs%rowtype;
  v_queue_id uuid;
begin
  select * into v_job
  from memory_llm_scheduled_jobs
  where job_key = p_job_key
  for update;

  if not found or not v_job.enabled then
    return null;
  end if;

  insert into memory_llm_job_queue(job_key, payload_snapshot, delivery_snapshot, due_at)
  values (
    v_job.job_key,
    jsonb_build_object(
      'job_key', v_job.job_key,
      'name', v_job.name,
      'agent_id', v_job.agent_id,
      'session_target', v_job.session_target,
      'wake_mode', v_job.wake_mode,
      'payload', v_job.payload,
      'schedule', v_job.schedule,
      'metadata', v_job.metadata
    ),
    v_job.delivery,
    now()
  )
  returning queue_id into v_queue_id;

  update memory_llm_scheduled_jobs
  set last_enqueued_at = now(),
      enqueue_count = enqueue_count + 1
  where job_key = p_job_key;

  perform pg_notify(
    'memory_llm_job_queue',
    jsonb_build_object('queue_id', v_queue_id, 'job_key', p_job_key)::text
  );

  return v_queue_id;
end;
$$;

create or replace function memory_llm_claim_job(p_worker text)
returns table(queue_id uuid, job_key text, payload_snapshot jsonb, delivery_snapshot jsonb)
language plpgsql
as $$
begin
  return query
  with picked as (
    select q.queue_id
    from memory_llm_job_queue q
    join memory_llm_scheduled_jobs j on j.job_key = q.job_key
    where q.status = 'queued'
      and q.due_at <= now()
      and q.attempts < q.max_attempts
      and j.enabled
    order by q.due_at, q.created_at
    for update skip locked
    limit 1
  )
  update memory_llm_job_queue q
  set status = 'running',
      leased_by = p_worker,
      leased_at = now(),
      started_at = now(),
      attempts = attempts + 1
  from picked
  where q.queue_id = picked.queue_id
  returning q.queue_id, q.job_key, q.payload_snapshot, q.delivery_snapshot;
end;
$$;

create or replace function memory_llm_finish_job(
  p_queue_id uuid,
  p_status text,
  p_result_summary text default null,
  p_stdout_text text default null,
  p_stderr_text text default null,
  p_error_text text default null
)
returns void
language plpgsql
as $$
begin
  update memory_llm_job_queue
  set status = case when p_status in ('done', 'failed', 'cancelled') then p_status else 'failed' end,
      finished_at = now(),
      result_summary = left(p_result_summary, 8000),
      stdout_text = left(p_stdout_text, 12000),
      stderr_text = left(p_stderr_text, 12000),
      error_text = left(p_error_text, 8000)
  where queue_id = p_queue_id;
end;
$$;
