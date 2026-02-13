---
name: database
description: >
  Query and write to the Supabase database. Supports schema inspection,
  filtered reads with relations, aggregate analytics (GROUP BY/HAVING),
  and atomic multi-table writes via WriteIntent. All operations are
  schema-validated with type coercion and actionable error messages.
  JSON in, JSON out. No raw SQL.
---

# Database Skill

**Rule: inspect → read → write --dry-run → write**

Tool: `python scripts/db_tool.py <command>` (from skill dir)
Env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (load from `.env`)

---

## 1. INSPECT — Schema Discovery

```bash
# List all tables
db_tool.py inspect

# Table structure (columns, types, PKs, FKs, required)
db_tool.py inspect <table>

# Full details (descriptions, enums, relationships)
db_tool.py inspect <table> --detailed
```

---

## 2. READ — Query Data

```bash
db_tool.py read <table> [options]
```

| Option | Format | Example |
|--------|--------|---------|
| `--filters` | JSON `{col: val}` | `'{"status": "ACTIVE"}'` |
| `--search` | JSON `{col: "%pattern%"}` | `'{"name": "%keyword%"}'` |
| `--columns` | comma-sep | `'id,name,price'` |
| `--relations` | PostgREST | `'parent_table(col1,col2)'` |
| `--limit` | int | `10` |
| `--offset` | int | `20` |
| `--count-only` | flag | (returns count, no data) |

### Filters

```bash
# Exact match
--filters '{"col": "value"}'

# Multiple conditions (AND)
--filters '{"col1": "A", "col2": true}'

# Operators: gt, gte, lt, lte, eq, neq, in
--filters '{"price": {"gt": 100, "lte": 500}}'

# IN list
--filters '{"category": ["A", "B", "C"]}'
```

### Search (ILIKE — fuzzy)

```bash
# Single pattern
--search '{"name": "%keyword%"}'

# Multiple patterns (OR)
--search '{"name": ["%word1%", "%word2%"]}'
```

### Combine everything

```bash
db_tool.py read <table> \
  --filters '{"status": "ACTIVE"}' \
  --search '{"name": "%keyword%"}' \
  --columns 'id,name,price' \
  --relations 'parent_table(name)' \
  --limit 10
```

---

## 3. AGGREGATE — Analytics

```bash
db_tool.py aggregate <table> --aggregates '<JSON>' [options]
```

| Option | Format |
|--------|--------|
| `--aggregates` | `'{"label": "func(col)"}'` |
| `--group-by` | `'col1,col2'` |
| `--having` | `'{"label": {"gt": N}}'` |
| `--filters` | same as read |

**Functions:** `count(*)`, `count(col)`, `sum(col)`, `avg(col)`, `min(col)`, `max(col)`

```bash
# Total count
--aggregates '{"total": "count(*)"}'

# Group by with metrics
--aggregates '{"count": "count(*)", "avg_price": "avg(price)"}' --group-by 'status'

# With HAVING filter
--aggregates '{"n": "count(*)"}' --group-by 'category_id' --having '{"n": {"gt": 5}}'
```

> Note: Some tables may restrict aggregate access (RLS). If blocked, try a different table.

---

## 4. WRITE — Atomic Operations

**Always `--dry-run` first.**

```bash
db_tool.py write --dry-run --intent '<JSON>'
db_tool.py write --intent '<JSON>'
```

### WriteIntent Structure

```json
{
  "goal": "What you're doing (human-readable)",
  "reasoning": "Why (checked for duplicates, business justification)",
  "operations": [ ... ],
  "impact": {"creates": {"<table>": N}, "updates": {"<table>": N}}
}
```

### Operations

**Create:**
```json
{
  "action": "create",
  "table": "<table>",
  "data": {"col1": "val1", "col2": 123},
  "returns": "<ref_name>"
}
```

**Create multiple rows:**
```json
{
  "action": "create",
  "table": "<table>",
  "data": [
    {"col1": "A", "parent_id": "@parent_ref.id"},
    {"col1": "B", "parent_id": "@parent_ref.id"}
  ]
}
```

**Update:**
```json
{
  "action": "update",
  "table": "<table>",
  "filters": {"id": "<uuid>"},
  "updates": {"col1": "new_value"}
}
```

**Actions:** `create`, `update`, `delete`, `upsert`

### Cross-table Dependencies

Use `"returns": "<name>"` on the parent op, then `@name.field` in child ops:

```json
{
  "operations": [
    {"action": "create", "table": "parents", "data": {"name": "X"}, "returns": "p"},
    {"action": "create", "table": "children", "data": {"parent_id": "@p.id", "name": "Y"}}
  ]
}
```

The tool auto-resolves `@p.id` to the created parent's UUID.

### Auto-magic

- `id` → auto-generated UUID
- `created_at` / `updated_at` → auto-set
- Type coercion → `"true"` → `true`, `"100"` → `100`
- Schema validation → rejects bad tables/columns with hints

---

## Error Recovery

| Error | Fix |
|-------|-----|
| `Unknown table: 'X'` | Run `inspect` to list tables |
| `Unknown columns in 'T': ['X']` | Run `inspect T` — error shows valid columns |
| `Access denied to table: T` | Table has RLS restrictions — try another table |
| `Missing required fields: [X]` | Add the listed fields to your data |

Every error is actionable — it tells you what went wrong AND how to fix it.

---

## Workflow

```
1. inspect              → what tables exist?
2. inspect <table>      → what columns, types, relations?
3. read <table>         → what data exists? (check for duplicates)
4. write --dry-run      → preview your changes
5. write                → execute
```
