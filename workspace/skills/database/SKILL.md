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

**THE RULE: Always inspect first, then read, then write (with dry_run)**

JSON in, JSON out. No SQL. The tool is smart, you just describe what you want.

## How It Works

1. **Write** a JSON file with your query using the `Write` tool
2. **Run** `python scripts/db_tool.py --file <path>` using `exec`

That's it. No shell escaping, no quoting headaches. Native JSON.

**File location:** Write query files to a temp path (e.g. `q.json` in the working directory). Delete after use.

---

## 1. INSPECT — Discover What's Available

Inspect commands are simple enough to run directly (no JSON needed):

```bash
# List all tables
python scripts/db_tool.py inspect

# Get table structure
python scripts/db_tool.py inspect <table_name>

# Full details with descriptions & enum values
python scripts/db_tool.py inspect <table_name> --detailed
```

Or via JSON file:
```json
{"command": "inspect"}
{"command": "inspect", "table": "<table_name>"}
{"command": "inspect", "table": "<table_name>", "detailed": true}
```

### Synchronize schema cache
```json
{"command": "sync-schema"}
{"command": "sync-schema", "compare_only": true}
```

---

## 2. READ — Query Data

### Simple read
```json
{"command": "read", "table": "<table>", "limit": 5}
```

### Filter by exact values
```json
{"command": "read", "table": "<table>", "filters": {"<column>": "<value>"}}
```

### Multiple conditions (AND)
```json
{"command": "read", "table": "<table>", "filters": {"<col1>": "<val1>", "<col2>": true}}
```

### List matching (IN)
```json
{"command": "read", "table": "<table>", "filters": {"<column>": ["<val1>", "<val2>"]}}
```

### Filter with operators
```json
{"command": "read", "table": "<table>", "filters": {"<numeric_col>": {"gt": 100, "lte": 500}}}
```

**All filter operators:** `gt`, `gte`, `lt`, `lte`, `eq`, `neq`, `in`

### Fuzzy search (ILIKE)
```json
{"command": "read", "table": "<table>", "search": {"<column>": "%<term>%"}}
```

### OR search (matches any)
```json
{"command": "read", "table": "<table>", "search": {"<column>": ["%<term1>%", "%<term2>%"]}}
```

### AND search (matches all)
```json
{"command": "read", "table": "<table>", "search": {"<column>": {"all": ["%<term1>%", "%<term2>%"]}}}
```

### Combine filters + search + columns + order
```json
{
  "command": "read",
  "table": "<table>",
  "filters": {"<col>": "<value>", "<col2>": true},
  "search": {"<col>": "%<term>%"},
  "columns": "<col1>,<col2>,<col3>",
  "order": "<col1>.desc,<col2>.asc",
  "limit": 10
}
```

### Related data (joins)
```json
{"command": "read", "table": "<table>", "relations": "<related>(<col1>,<col2>)", "columns": "<col1>,<col2>", "limit": 3}
```

### FK disambiguation (multiple FKs to same table)
```json
{"command": "read", "table": "<table>", "relations": "<target>!<fk1>(<cols>),<target>!<fk2>(<cols>)", "limit": 3}
```

### Count only
```json
{"command": "read", "table": "<table>", "filters": {"<col>": "<value>"}, "count_only": true}
```

### Pagination
```json
{"command": "read", "table": "<table>", "limit": 20, "offset": 40}
```

---

## 3. AGGREGATE — Analytics

### Simple count
```json
{"command": "aggregate", "table": "<table>", "aggregates": {"total": "count(*)"}}
```

### Group by with metrics
```json
{
  "command": "aggregate",
  "table": "<table>",
  "aggregates": {"count": "count(*)", "avg_val": "avg(<numeric_col>)"},
  "group_by": "<column>"
}
```

### With filters and HAVING
```json
{
  "command": "aggregate",
  "table": "<table>",
  "aggregates": {"record_count": "count(*)"},
  "filters": {"<col>": true},
  "group_by": "<column>",
  "having": {"record_count": {"gt": 5}}
}
```

**Available functions:** `count(*)`, `count(<col>)`, `sum()`, `avg()`, `min()`, `max()`

---

## 4. WRITE — Atomic Operations

**ALWAYS set `dry_run: true` first!**

### Single record create
```json
{
  "command": "write",
  "dry_run": true,
  "intent": {
    "goal": "Create new <entity>",
    "reasoning": "Business justification",
    "operations": [
      {
        "action": "create",
        "table": "<table>",
        "data": {
          "<col1>": "<value>",
          "<col2>": "<value>",
          "<col3>": true
        }
      }
    ],
    "impact": {"creates": {"<table>": 1}}
  }
}
```

### Multi-table with dependencies
```json
{
  "command": "write",
  "dry_run": true,
  "intent": {
    "goal": "Create <parent> with <children>",
    "reasoning": "Business need",
    "operations": [
      {
        "action": "create",
        "table": "<parent_table>",
        "data": {"name": "<Name>", "<col>": "<value>"},
        "returns": "parent"
      },
      {
        "action": "create",
        "table": "<child_table>",
        "data": [
          {"parent_id": "@parent.id", "name": "<Child 1>", "<col>": 100},
          {"parent_id": "@parent.id", "name": "<Child 2>", "<col>": 200}
        ]
      }
    ],
    "impact": {"creates": {"<parent_table>": 1, "<child_table>": 2}}
  }
}
```

### Update records
```json
{
  "command": "write",
  "intent": {
    "goal": "Update <entity>",
    "reasoning": "Business reason",
    "operations": [
      {
        "action": "update",
        "table": "<table>",
        "filters": {"<col>": "<value>"},
        "updates": {"<col>": false, "<col2>": "<new_value>"}
      }
    ],
    "impact": {"updates": {"<table>": "1-5 records"}}
  }
}
```

### Upsert
```json
{
  "command": "write",
  "dry_run": true,
  "intent": {
    "goal": "Upsert <entity>",
    "reasoning": "Create or update",
    "operations": [
      {
        "action": "upsert",
        "table": "<table>",
        "data": {"<unique_col>": "<value>", "<col>": "<value>"},
        "conflict": ["<unique_col>"]
      }
    ],
    "impact": {"creates": {"<table>": 1}}
  }
}
```

**Actions:** `create`, `update`, `delete`, `upsert`

### Expression updates — NOT SUPPORTED
```
❌ "updates": {"price": "price * 1.1"} — doesn't work
✅ Read first → calculate → write literal values
```

---

## Key Features

1. **Auto-enrichment**: `id` UUIDs generated, `created_at`/`updated_at` set automatically
2. **Dependency detection**: `@parent.id` references resolved across operations
3. **Type coercion**: `"true"` → `true`, `"100"` → `100` based on column types
4. **Schema validation**: Invalid table/column names caught with suggestions
5. **Atomic transactions**: All operations succeed or fail together
6. **Excellent errors**: Every error tells you exactly how to fix it

---

## Workflow

```
1. inspect              → discover tables and columns
2. read                 → check existing data
3. write (dry_run)      → preview changes
4. write                → execute (remove dry_run)
```

---

## Error Recovery

| Error | Fix |
|---|---|
| `Unknown table: '<name>'` | Use `inspect` to list tables |
| `Unknown columns in '<table>': [...]` | Use `inspect <table>` for valid columns |
| `missing required fields: [...]` | Add listed fields to your data |
| `Unsupported operator: '<op>'` | Use: eq, gt, gte, lt, lte, neq, in |
| `'@alias' not found` | Check `returns` names in previous operations |

---

## Known Limitations

1. **Aggregate filters** — only exact match and IN, not operators. Workaround: `read` with operators, then aggregate client-side.
2. **Expression updates** — can't do `price * 1.1`. Read → calculate → write with literal values.

---

**Remember: Replace `<table>`, `<column>`, `<value>` with real values from `inspect`. All examples are JSON files — write with `Write` tool, run with `exec python scripts/db_tool.py --file <path>`.**
