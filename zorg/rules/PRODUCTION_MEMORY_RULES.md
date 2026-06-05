# Zorg MemoryDB Production Memory Rules

- Use backend database recall before acting.
- Store durable memory in PostgreSQL tables, not markdown memory files.
- If `memory/*.md` exists on a target install, import it into the database and retire it from active recall.
- Preserve original/source memory data. Do not prune or compact it away for performance.
- Improve recall with additive structures: indexes, source chunks, entities, associations, recall hints, query observations, vectors, and materialized views.
- Keep rule tables, markdown import tables, and neural/association structures during migrations.
- Keep LAN command chat available as local fallback communication.
- Publish only public-safe structure, scripts, schema, and documentation to this repository.
- Active operating rules belong in `zorg_logic_rules`; older compatibility rule tables must not remain active recall sources after canonical migration.
- Before production DB structural, indexing, vector, weighted-memory, or schema changes, create and verify a temporary local PostgreSQL backup only.
- Do not commit, mirror, or push live DB dumps, rows, contacts, transcripts, credentials, or private memory to GitHub from the public MemoryDB update path.
- Runtime memory writers must not create retired markdown memory files. Generated durable memory belongs in PostgreSQL-backed ingestion; any accidental file is imported then removed.
- Visible operational replies include the operator request timestamp, actual response timestamp, and elapsed duration based on those two times.
