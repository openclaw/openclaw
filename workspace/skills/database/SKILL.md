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
# Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY)
```

---

## 1. INSPECT — Discover What's Available

### List all tables (34 available)
```bash
python scripts/db_tool.py inspect
```
**Output:** Complete table list with count

### Get table structure
```bash
python scripts/db_tool.py inspect products
```
**Output:** All columns with types, required fields, PKs, FKs - everything you need to build queries

### Get full details (with descriptions & enum values)
```bash  
python scripts/db_tool.py inspect uom --detailed
```
**Output:** Complete schema including business rules, valid enum values, relationships

**Real example from our DB:**
```json
{
  "success": true,
  "table": "uom",
  "columns": [
    {"name": "code", "type": "varchar", "required": true},
    {"name": "name", "type": "varchar", "required": true}, 
    {"name": "uom_category", "type": "varchar", "required": true},
    {"name": "is_base_unit", "type": "boolean", "required": true},
    {"name": "decimal_places", "type": "integer", "required": true}
  ]
}
```

---

## 2. READ — Query Data (The Smart Way)

### Simple read
```bash
python scripts/db_tool.py read uom --limit 5
```

### Filter by exact values
```bash
# Get WEIGHT category units only
python scripts/db_tool.py read uom --filters '{"uom_category": "WEIGHT"}'

# Multiple conditions (AND logic)
python scripts/db_tool.py read uom --filters '{"uom_category": "WEIGHT", "is_base_unit": true}'

# List matching (IN operator)
python scripts/db_tool.py read uom --filters '{"uom_category": ["WEIGHT", "COUNT"]}'
```

### Filter with operators
```bash
# Greater than
python scripts/db_tool.py read uom --filters '{"decimal_places": {"gt": 0}}'

# Multiple operators
python scripts/db_tool.py read products --filters '{"price": {"gt": 100, "lte": 500}}'
```

**All filter operators:** `gt`, `gte`, `lt`, `lte`, `eq`, `neq`, `in`

### Search with fuzzy matching (ILIKE)
```bash
# Find units containing "meter"  
python scripts/db_tool.py read uom --search '{"name": "%meter%"}'

# Multiple search patterns (OR logic)
python scripts/db_tool.py read products --search '{"name": ["%bottle%", "%jar%"]}'
```

### Combine filters + search + columns
```bash
# Complex real-world query
python scripts/db_tool.py read products \
  --filters '{"status": "ACTIVE", "is_active": true}' \
  --search '{"name": "%bottle%"}' \
  --columns 'sku,name,price' \
  --limit 10
```

### Get related data (joins)
```bash
# Products with their families
python scripts/db_tool.py read products \
  --columns 'id,sku,name' \
  --relations 'product_families(name,sku_prefix)' \
  --limit 3
```

**Real output:**
```json
{
  "data": [
    {
      "sku": "PAV-BTL-500ML-28PCO-AMB",
      "name": "500ml PET Bottle - Amber - 28mm PCO",
      "product_families": {"name": "PET Bottles", "sku_prefix": "PET"}
    }
  ]
}
```

### Pagination & counting
```bash
# Just get the count
python scripts/db_tool.py read products --filters '{"status": "ACTIVE"}' --count-only

# Paginate through results  
python scripts/db_tool.py read products --limit 20 --offset 40
```

---

## 3. AGGREGATE — Analytics

Works on most tables (some have access restrictions).

### Simple counts
```bash
python scripts/db_tool.py aggregate products --aggregates '{"total": "count(*)"}'
```

### Group by with multiple metrics
```bash
# Count and average price by status
python scripts/db_tool.py aggregate products \
  --aggregates '{"count": "count(*)", "avg_price": "avg(price)"}' \
  --group-by 'status'
```

### With filters and having
```bash
# Product families with more than 5 products
python scripts/db_tool.py aggregate products \
  --aggregates '{"product_count": "count(*)"}' \
  --filters '{"is_active": true}' \
  --group-by 'product_family_id' \
  --having '{"product_count": {"gt": 5}}'
```

**Available functions:** `count(*)`, `count(column)`, `sum()`, `avg()`, `min()`, `max()`

---

## 4. WRITE — Atomic Operations

**ALWAYS use --dry-run first!**

### Single record create
```bash
python scripts/db_tool.py write --dry-run --intent '{
  "goal": "Add new weight unit: Ton", 
  "reasoning": "Standard weight unit missing from catalog",
  "operations": [
    {
      "action": "create",
      "table": "uom", 
      "data": {
        "code": "TON",
        "name": "Ton", 
        "uom_category": "WEIGHT",
        "is_base_unit": false,
        "decimal_places": 3
      }
    }
  ],
  "impact": {"creates": {"uom": 1}}
}'
```

### Multi-table with dependencies  
```bash  
python scripts/db_tool.py write --dry-run --intent '{
  "goal": "Create Glass Bottles family with 2 products",
  "reasoning": "New product line approved. No existing glass products found.",
  "operations": [
    {
      "action": "create",
      "table": "product_families",
      "data": {
        "name": "Glass Bottles", 
        "sku_prefix": "GLS",
        "base_price": 45.00
      },
      "returns": "family"
    },
    {
      "action": "create", 
      "table": "products",
      "data": [
        {
          "product_family_id": "@family.id", 
          "sku": "GLS-250ML",
          "name": "Glass Bottle 250ml",
          "price": 35.00
        },
        {
          "product_family_id": "@family.id",
          "sku": "GLS-500ML", 
          "name": "Glass Bottle 500ml",
          "price": 55.00
        }
      ]
    }
  ],
  "impact": {"creates": {"product_families": 1, "products": 2}}
}'
```

### Update records
```bash
python scripts/db_tool.py write --intent '{
  "goal": "Mark test products as inactive",
  "reasoning": "Cleanup old test data", 
  "operations": [
    {
      "action": "update",
      "table": "products",
      "filters": {"sku": {"search": "TEST-%"}},
      "updates": {"is_active": false, "status": "DISCONTINUED"}
    }
  ],
  "impact": {"updates": {"products": "estimated 5-10"}}
}'
```

**Actions:** `create`, `update`, `delete`, `upsert`

---

## Key Features That Make This Tool Amazing

1. **Auto-enrichment**: `id` UUIDs generated, `created_at`/`updated_at` set automatically
2. **Dependency detection**: `@family.id` references automatically resolved
3. **Type coercion**: "true" → true, "100" → 100 based on column types  
4. **Schema validation**: Invalid table/column names caught with helpful suggestions
5. **Atomic transactions**: All operations succeed or fail together
6. **Excellent errors**: Every error tells you exactly how to fix it

---

## Error Recovery

### Table not found
```
Error: "Unknown table: 'prodcts'"
Fix: Use 'inspect' to see available tables
```

### Column not found  
```
Error: "Unknown columns in 'uom': ['invalid_column']"
Fix: Use 'inspect uom' to see valid columns
```

### Access denied on aggregates
```
Error: "Access denied to table: inventory"  
Fix: Some tables have restricted aggregate access - try 'products', 'categories', 'product_families'
```

---

## Workflow: The Right Way to Use This

```bash
# 1. Discover what exists
python scripts/db_tool.py inspect                    # List tables
python scripts/db_tool.py inspect products          # Table structure

# 2. Check existing data (avoid duplicates)
python scripts/db_tool.py read products --search '{"sku": "TEST-%"}' --count-only

# 3. Preview your changes
python scripts/db_tool.py write --dry-run --intent '...'

# 4. Execute (remove --dry-run)
python scripts/db_tool.py write --intent '...'
```

---

## Environment Variables

Set these before running any command:

```powershell
$env:SUPABASE_URL='https://badupjrwhiucpvnuwluc.supabase.co'
$env:SUPABASE_SERVICE_ROLE_KEY='your-service-role-key'
```

---

## References

- `references/schema.json` — Complete database schema
- `references/query_patterns.md` — More read/aggregate examples  
- `references/write_patterns.md` — More WriteIntent examples

**Remember: This tool is designed to be copy-paste friendly. Change the values in the examples above and they'll work!**