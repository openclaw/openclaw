# Zorg MemoryDB Production Memory Rules

- Use backend database recall before acting.
- Store durable memory in PostgreSQL tables, not markdown memory files.
- If `memory/*.md` exists on a target install, import it into the database and retire it from active recall.
- Preserve original/source memory data. Do not prune or compact it away for performance.
- Improve recall with additive structures: indexes, source chunks, entities, associations, recall hints, query observations, vectors, and materialized views.
- Keep rule tables, markdown import tables, and neural/association structures during migrations.
- Keep LAN command chat available as local fallback communication.
- Publish only public-safe structure, scripts, schema, and documentation to this repository.
