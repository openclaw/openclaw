-- Archive retired workspace memory/ files into PostgreSQL before removing them from the filesystem.
-- This stores source file contents as DB history without publishing private rows.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS public.zorg_memory_file_archive (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  source_path text NOT NULL,
  content_sha256 text NOT NULL,
  byte_size integer NOT NULL,
  line_count integer NOT NULL,
  content text NOT NULL,
  content_json jsonb,
  migrated_at timestamptz DEFAULT now() NOT NULL,
  deleted_from_filesystem boolean DEFAULT false NOT NULL,
  deleted_at timestamptz,
  notes text
);

ALTER TABLE public.zorg_memory
  ADD COLUMN IF NOT EXISTS memory_active boolean NOT NULL DEFAULT true;

CREATE UNIQUE INDEX IF NOT EXISTS idx_zorg_memory_file_archive_source_sha
  ON public.zorg_memory_file_archive(source_path, content_sha256);
CREATE INDEX IF NOT EXISTS idx_zorg_memory_file_archive_source_path
  ON public.zorg_memory_file_archive(source_path);
CREATE INDEX IF NOT EXISTS idx_zorg_memory_file_archive_deleted
  ON public.zorg_memory_file_archive(deleted_from_filesystem);
CREATE INDEX IF NOT EXISTS idx_zorg_memory_file_archive_content_trgm
  ON public.zorg_memory_file_archive USING gin (content gin_trgm_ops);
CREATE UNIQUE INDEX IF NOT EXISTS idx_zorg_memory_migrated_file_line_key
  ON public.zorg_memory(memory_key)
  WHERE memory_key LIKE 'migrated-memory-file::%';

CREATE UNIQUE INDEX IF NOT EXISTS idx_zorg_memory_core_markdown_key ON public.zorg_memory USING btree (memory_key) WHERE (memory_key ~~ 'core-markdown::%'::text);
