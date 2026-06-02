-- Public-safe canonical rule update for Zorg MemoryDB installs.
--
-- Purpose:
-- 1. Keep active rule enforcement on public.zorg_logic_rules.
-- 2. Disable older compatibility rule tables if they exist.
-- 3. Seed/update sanitized public-safe rules only.
-- 4. Raise existing operator-visible chat timing rule weights without creating
--    replacement timing rules.
--
-- This file contains structure and sanitized operating rules only. It does not
-- include private memory rows, contacts, transcripts, credentials, live DB
-- dumps, account data, or operator-private context.

create extension if not exists pgcrypto;

create table if not exists public.zorg_logic_rule_dynamic_weights (
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

create or replace view public.zorg_logic_rule_dynamic_ranking_v as
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
from public.zorg_logic_rules r
left join public.zorg_logic_rule_dynamic_weights w on w.rule_key = r.rule_key;

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
  'canonical-logic-rules-active-surface',
  'Canonical logic rules active surface',
  'memory_rule',
  'critical',
  'public_safe',
  'zorg/db/public_canonical_rules_update_2026_06_02.sql',
  'Active operating rules belong in zorg_logic_rules. Older compatibility rule surfaces such as zorg_rules and zorg_rule_catalog may remain for upgrade compatibility, but they must not remain active rule-recall sources after canonical migration.',
  array['memory','rules','recall','upgrade']
),
(
  'temporary-local-db-backup-only',
  'Temporary local DB backup only',
  'recovery_rule',
  'critical',
  'public_safe',
  'zorg/db/public_canonical_rules_update_2026_06_02.sql',
  'Before production database structural, indexing, materialized-view, recall-routing, vector, weighted-memory, or schema changes, create and verify a temporary local PostgreSQL backup only. Do not commit, mirror, or push live database dumps to GitHub.',
  array['database','backup','recovery','github','publication']
),
(
  'chat-timing-rule-weight-update',
  'Chat timing rule weight update',
  'communication_rule',
  'critical',
  'public_safe',
  'zorg/db/public_canonical_rules_update_2026_06_02.sql',
  'When an install carries operator-visible chat timing rules, raise their existing dynamic weights in zorg_logic_rule_dynamic_weights instead of creating replacement timing rules.',
  array['chat','timing','dynamic-weight','rules']
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

do $$
begin
  if to_regclass('public.zorg_rules') is not null
     and exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'zorg_rules' and column_name = 'enabled'
     ) then
    update public.zorg_rules set enabled = false where enabled = true;
  end if;

  if to_regclass('public.zorg_rules') is not null
     and exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'zorg_rules' and column_name = 'active'
     ) then
    update public.zorg_rules set active = false where active = true;
  end if;

  if to_regclass('public.zorg_rule_catalog') is not null
     and exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'zorg_rule_catalog' and column_name = 'enabled'
     ) then
    update public.zorg_rule_catalog set enabled = false where enabled = true;
  end if;

  if to_regclass('public.zorg_rule_catalog') is not null
     and exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'zorg_rule_catalog' and column_name = 'active'
     ) then
    update public.zorg_rule_catalog set active = false where active = true;
  end if;
end $$;

insert into public.zorg_logic_rule_dynamic_weights (
  rule_key,
  seed_weight,
  dynamic_weight,
  use_count,
  positive_feedback_count,
  negative_feedback_count,
  last_feedback_at,
  feedback_basis,
  metadata,
  created_at,
  updated_at
)
values
(
  'operator-visible-db-scan-timestamp-duration-hard-rule-2026-05-23',
  100,
  30,
  0,
  1,
  0,
  now(),
  'public_update_chat_timing_bottom_response_weight',
  '{"operator_visible_timing":"bottom_time_summary_required","changed_surface":"dynamic weights only","no_new_rule":true}'::jsonb,
  now(),
  now()
),
(
  'chat-verified-backend-memory-checked-line-2026-05-24',
  100,
  30,
  0,
  1,
  0,
  now(),
  'public_update_chat_timing_bottom_response_weight',
  '{"operator_visible_timing":"verified_backend_memory_checked_line_required","changed_surface":"dynamic weights only","no_new_rule":true}'::jsonb,
  now(),
  now()
),
(
  'visible-chat-response-secret-query-timing-2026-06-01',
  100,
  30,
  0,
  1,
  0,
  now(),
  'public_update_chat_timing_bottom_response_weight',
  '{"operator_visible_timing":"bottom_time_summary_required","changed_surface":"dynamic weights only","no_new_rule":true}'::jsonb,
  now(),
  now()
),
(
  'operator-visible-reply-rule-audit-vector-neural-repair-2026-06-01',
  100,
  30,
  0,
  1,
  0,
  now(),
  'public_update_chat_timing_bottom_response_weight',
  '{"operator_visible_timing":"reply_format_rules_must_rank_first","changed_surface":"dynamic weights only","no_new_rule":true}'::jsonb,
  now(),
  now()
)
on conflict (rule_key) do update
set seed_weight = greatest(public.zorg_logic_rule_dynamic_weights.seed_weight, excluded.seed_weight),
    dynamic_weight = greatest(public.zorg_logic_rule_dynamic_weights.dynamic_weight, excluded.dynamic_weight),
    positive_feedback_count = public.zorg_logic_rule_dynamic_weights.positive_feedback_count + 1,
    last_feedback_at = now(),
    feedback_basis = excluded.feedback_basis,
    metadata = coalesce(public.zorg_logic_rule_dynamic_weights.metadata, '{}'::jsonb) || excluded.metadata,
    updated_at = now();
