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

**THE RULE: Always inspect first, then read, then write (with --dry-run)**

This is your database superpower. JSON in, JSON out. No SQL. The tool is smart, you just describe what you want.

## Setup

```bash
pip install supabase
# Env vars auto-loaded from workspace root .env file
# Or set manually: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
```

---

## 1. INSPECT — Discover What's Available

### List all tables
```bash
python scripts/db_tool.py inspect
```
**Output:** Complete table list with count

### Get table structure
```bash
python scripts/db_tool.py inspect <table_name>
```
**Output:** All columns with types, required fields, PKs, FKs - everything you need to build queries

### Get full details (with descriptions & enum values)
```bash  
python scripts/db_tool.py inspect <table_name> --detailed
```
**Output:** Complete schema including business rules, valid enum values, relationships

### Synchronize schema cache with live database
```bash
# Compare current schema.json with live database 
python scripts/db_tool.py sync-schema --compare-only

# Update schema.json from live database (creates backup)
python scripts/db_tool.py sync-schema
```
**Use this when:** Schema.json gets out of sync with database changes, or `inspect` shows wrong column info

**Generic example output:**
```json
{
  "success": true,
  "table": "T1",
  "columns": [
    {"name": "id", "type": "uuid", "required": true, "pk": true},
    {"name": "code", "type": "varchar", "required": true},
    {"name": "name", "type": "varchar", "required": true}, 
    {"name": "category", "type": "varchar", "required": true},
    {"name": "is_active", "type": "boolean", "required": true},
    {"name": "value", "type": "integer", "required": true}
  ]
}
```

---

## 2. READ — Query Data (The Smart Way)

### Simple read
```bash
python scripts/db_tool.py read <table_name> --limit 5
```

### Filter by exact values
```bash
# Get records matching specific category
python scripts/db_tool.py read <table_name> --filters '{"category": "<value>"}'

# Multiple conditions (AND logic)
python scripts/db_tool.py read <table_name> --filters '{"category": "<value>", "is_active": true}'

# List matching (IN operator)
python scripts/db_tool.py read <table_name> --filters '{"category": ["<value1>", "<value2>"]}'
```

### Filter with operators
```bash
# Greater than
python scripts/db_tool.py read <table_name> --filters '{"value": {"gt": 100}}'

# Multiple operators
python scripts/db_tool.py read <table_name> --filters '{"price": {"gt": 100, "lte": 500}}'
```

**All filter operators:** `gt`, `gte`, `lt`, `lte`, `eq`, `neq`, `in`

### Search with fuzzy matching (ILIKE)
```bash
# Find records containing specific text  
python scripts/db_tool.py read <table_name> --search '{"name": "%<search_term>%"}'

# Multiple search patterns (OR logic)
python scripts/db_tool.py read <table_name> --search '{"name": ["%<term1>%", "%<term2>%"]}'
```

### Combine filters + search + columns
```bash
# Complex real-world query
python scripts/db_tool.py read <table_name> \
  --filters '{"status": "<active>", "is_active": true}' \
  --search '{"name": "%<search>%"}' \
  --columns '<col1>,<col2>,<col3>' \
  --limit 10
```

### Get related data (joins)
```bash
# Records with their related data
python scripts/db_tool.py read <main_table> \
  --columns '<col1>,<col2>,<col3>' \
  --relations '<related_table>(<col1>,<col2>)' \
  --limit 3
```

### Multiple foreign keys to same table (disambiguation)
```bash
# When a table has multiple FKs pointing to same target table
# Use table!foreign_key_column(fields) syntax to disambiguate
python scripts/db_tool.py read <table_with_multiple_fks> \
  --relations '<target_table>!<fk1_column>(<col1>,<col2>),<target_table>!<fk2_column>(<col1>,<col2>)' \
  --limit 3

# Real example: bom_lines has component_id AND substitute_component_id both pointing to products
python scripts/db_tool.py read bom_lines \
  --relations 'products!component_id(name),products!substitute_component_id(name)' \
  --limit 3
```

**Generic output example:**
```json
{
  "data": [
    {
      "code": "C1",
      "name": "Item Name",
      "related_table": {"name": "Related Item", "code": "RC1"}
    }
  ]
}
```

### Pagination & counting
```bash
# Just get the count
python scripts/db_tool.py read <table_name> --filters '{"status": "<active>"}' --count-only

# Paginate through results  
python scripts/db_tool.py read <table_name> --limit 20 --offset 40
```

---

## 3. AGGREGATE — Analytics

Works on most tables (some may have access restrictions).

### Simple counts
```bash
python scripts/db_tool.py aggregate <table_name> --aggregates '{"total": "count(*)"}'
```

### Group by with multiple metrics
```bash
# Count and average by category
python scripts/db_tool.py aggregate <table_name> \
  --aggregates '{"count": "count(*)", "avg_value": "avg(<numeric_column>)"}' \
  --group-by '<category_column>'
```

### With filters and having
```bash
# Categories with more than N records
python scripts/db_tool.py aggregate <table_name> \
  --aggregates '{"record_count": "count(*)"}' \
  --filters '{"is_active": true}' \
  --group-by '<category_column>' \
  --having '{"record_count": {"gt": 5}}'
```

**Available functions:** `count(*)`, `count(column)`, `sum()`, `avg()`, `min()`, `max()`

---

## 4. WRITE — Atomic Operations

**ALWAYS use --dry-run first!**

### Single record create
```bash
python scripts/db_tool.py write --dry-run --intent '{
  "goal": "Create new <entity_type>", 
  "reasoning": "Business justification for this operation",
  "operations": [
    {
      "action": "create",
      "table": "<table_name>", 
      "data": {
        "code": "<CODE>",
        "name": "<Name>", 
        "category": "<CATEGORY>",
        "is_active": true,
        "value": 100
      }
    }
  ],
  "impact": {"creates": {"<table_name>": 1}}
}'
```

### Multi-table with dependencies  
```bash  
python scripts/db_tool.py write --dry-run --intent '{
  "goal": "Create <parent> with <child> records",
  "reasoning": "Business need description",
  "operations": [
    {
      "action": "create",
      "table": "<parent_table>",
      "data": {
        "name": "<Parent Name>", 
        "code": "<PRT>",
        "base_value": 100.00
      },
      "returns": "parent"
    },
    {
      "action": "create", 
      "table": "<child_table>",
      "data": [
        {
          "parent_id": "@parent.id", 
          "code": "<CHILD1>",
          "name": "<Child 1>",
          "value": 150.00
        },
        {
          "parent_id": "@parent.id",
          "code": "<CHILD2>", 
          "name": "<Child 2>",
          "value": 200.00
        }
      ]
    }
  ],
  "impact": {"creates": {"<parent_table>": 1, "<child_table>": 2}}
}'
```

### Update records
```bash
python scripts/db_tool.py write --intent '{
  "goal": "Update <entity> status",
  "reasoning": "Business reason for update", 
  "operations": [
    {
      "action": "update",
      "table": "<table_name>",
      "filters": {"code": "<specific_code>"},
      "updates": {"is_active": false, "status": "<INACTIVE>"}
    }
  ],
  "impact": {"updates": {"<table_name>": "1-5 records"}}
}'
```

### Expression-based updates (LIMITATION)

**❌ NOT SUPPORTED:** Mathematical expressions in updates
```bash  
# This DOESN'T WORK - expressions not supported
"updates": {"price": "price * 1.1", "quantity": "quantity - 1"}
```

**✅ WORKAROUND:** Read first, calculate, then write
```bash
# Step 1: Read current values
python scripts/db_tool.py read <table> --filters '{"id": "<record_id>"}' --columns '<numeric_column>'

# Step 2: Calculate new values in your script/tool
# new_price = current_price * 1.1

# Step 3: Update with literal values  
python scripts/db_tool.py write --intent '{
  "goal": "Update calculated values",
  "operations": [{
    "action": "update",
    "table": "<table>", 
    "filters": {"id": "<record_id>"},
    "updates": {"<numeric_column>": <calculated_value>}
  }]
}'
```

**Actions:** `create`, `update`, `delete`, `upsert`

---

## Key Features That Make This Tool Amazing

1. **Auto-enrichment**: `id` UUIDs generated, `created_at`/`updated_at` set automatically
2. **Dependency detection**: `@parent.id` references automatically resolved
3. **Type coercion**: "true" → true, "100" → 100 based on column types  
4. **Schema validation**: Invalid table/column names caught with helpful suggestions
5. **Atomic transactions**: All operations succeed or fail together
6. **Excellent errors**: Every error tells you exactly how to fix it

---

## Error Recovery

### Table not found
```
Error: "Unknown table: '<typo_table>'"
Fix: Use 'inspect' to see available tables
```

### Column not found  
```
Error: "Unknown columns in '<table>': ['<typo_column>']"
Fix: Use 'inspect <table>' to see valid columns
```

### Access denied on aggregates
```
Error: "Access denied to table: <table>"  
Fix: Some tables have restricted aggregate access - try different tables
```

---

## Workflow: The Right Way to Use This

```bash
# 1. Discover what exists
python scripts/db_tool.py inspect                    # List tables
python scripts/db_tool.py inspect <table>           # Table structure

# 2. Check existing data (avoid duplicates)
python scripts/db_tool.py read <table> --search '{"code": "<pattern>%"}' --count-only

# 3. Preview your changes
python scripts/db_tool.py write --dry-run --intent '...'

# 4. Execute (remove --dry-run)
python scripts/db_tool.py write --intent '...'
```

---

## Environment Variables

Auto-loaded from `workspace/.env`. Or set manually:

```powershell
$env:SUPABASE_URL='<your-supabase-url>'
$env:SUPABASE_SERVICE_ROLE_KEY='<your-service-role-key>'
```

## ⚠️ PowerShell JSON Escaping

PowerShell handles quotes differently than bash. Escape inner double quotes:

```powershell
# ✅ Correct (PowerShell)
--filters '{\"status\": \"ACTIVE\"}'

# ❌ Wrong (bash-style — fails in PowerShell)
--filters '{"status": "ACTIVE"}'
```

All examples in this doc use bash-style for readability. **In PowerShell, escape all inner `"` as `\"`.**

---

## Template Patterns

### Common Filter Patterns
```bash
# Exact match
--filters '{"<column>": "<value>"}'

# Multiple conditions  
--filters '{"<col1>": "<val1>", "<col2>": true}'

# Operators
--filters '{"<numeric_col>": {"gt": 100, "lte": 500}}'

# Lists (IN operator)
--filters '{"<column>": ["<val1>", "<val2>", "<val3>"]}'
```

### Common Search Patterns
```bash
# Starts with
--search '{"<column>": "<prefix>%"}'

# Contains
--search '{"<column>": "%<term>%"}'

# Multiple terms (OR)
--search '{"<column>": ["%<term1>%", "%<term2>%"]}'
```

### Common WriteIntent Structure
```json
{
  "goal": "<what you want to accomplish>",
  "reasoning": "<why this is needed>", 
  "operations": [
    {
      "action": "<create|update|delete|upsert>",
      "table": "<table_name>",
      "data": {"<column>": "<value>"},
      "returns": "<alias>"
    }
  ],
  "impact": {"<creates|updates|deletes>": {"<table>": "<count>"}}
}
```

---

## Schema Sync

Keep `schema.json` in sync with the live database:

```bash
# Compare only (show drift)
python scripts/sync_schema.py --compare-only

# Sync (updates schema.json, backs up old one)
python scripts/sync_schema.py
```

Run this whenever tables/columns change in Supabase. Uses the PostgREST OpenAPI spec — no manual work.

---

## Known Limitations

1. **Aggregate filters** — only support exact match and lists (IN), not operators like `{"gt": 100}`. Workaround: use `read` with operators first, then aggregate client-side.
2. **Expression updates** — can't do `price * 1.1`. Read → calculate → write with literal values.
3. **Some tables restrict aggregates** — RLS policies may block `dynamic_aggregate` on certain tables.

---

## References

- `references/schema.json` — Complete database schema (sync with `sync_schema.py`)
- `references/query_patterns.md` — More read/aggregate examples  
- `references/write_patterns.md` — More WriteIntent examples

**Remember: Replace placeholders like `<table_name>`, `<column>`, `<value>` with actual values from your schema. Use 'inspect' to discover what's available!**