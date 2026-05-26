-- Prepare a public-safe baseline from a staging database.
-- Use only when building a distributable package seed, never against a live user DB.
truncate table zorg_memory restart identity cascade;
truncate table lan_chat_messages restart identity cascade;
truncate table query_observations restart identity cascade;
-- Preserve rule tables, markdown import tables, source chunks, recall hints, entities, and associations.
