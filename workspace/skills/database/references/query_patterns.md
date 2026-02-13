# Query Patterns

## Filters vs Search

**filters** = exact match, operators, IN lists. For IDs, booleans, enums, numbers.
**search** = ILIKE with `%` wildcards. For text/name fuzzy matching.

```bash
# Filters: exact match (strings use .eq(), not ILIKE — use --search for fuzzy)
--filters '{"is_active": true, "category_id": "<uuid>"}'

# Filters: operators
--filters '{"price": {"gt": 100, "lte": 500}}'

# Filters: IN list
--filters '{"status": ["<active>", "<draft>"]}'

# Search: single pattern
--search '{"name": "%<search_term>%"}'

# Search: OR between patterns
--search '{"name": ["%<term1>%", "%<term2>%", "%<term3>%"]}'
```

## Read Examples

### Simple filtered read
```bash
python scripts/db_tool.py read <table_name> --filters '{"is_active": true}' --limit 10
```

### Select specific columns
```bash
python scripts/db_tool.py read <table_name> --columns '<col1>,<col2>,<col3>,<col4>' --limit 50
```

### With relations (PostgREST embedding)
```bash
python scripts/db_tool.py read <table_name> --relations '<related_table>(<col1>,<col2>),<other_table>(<col3>,<nested_table>(<col4>))'
```

### Fuzzy search with pagination
```bash
python scripts/db_tool.py read <table_name> --search '{"name": "%<search_term>%"}' --limit 20 --offset 40
```

### Count only
```bash
python scripts/db_tool.py read <table_name> --filters '{"is_active": true}' --count-only
```

### Combined filters + search
```bash
python scripts/db_tool.py read <table_name> \
  --filters '{"is_active": true}' \
  --search '{"name": ["%<term1>%", "%<term2>%"]}' \
  --columns '<col1>,<col2>,<col3>,<col4>' \
  --limit 20
```

## Aggregate Examples

### Simple count
```bash
python scripts/db_tool.py aggregate <table_name> --aggregates '{"total": "count(*)"}'
```

### Group by with multiple aggregates
```bash
python scripts/db_tool.py aggregate <table_name> \
  --aggregates '{"count": "count(*)", "avg_value": "avg(<numeric_col>)", "max_value": "max(<numeric_col>)"}' \
  --group-by '<category_column>'
```

### With HAVING filter
```bash
python scripts/db_tool.py aggregate <table_name> \
  --aggregates '{"count": "count(*)"}' \
  --filters '{"is_active": true}' \
  --group-by '<category_column>' \
  --having '{"count": {"gt": 5}}'
```

### With search patterns
```bash
python scripts/db_tool.py aggregate <table_name> \
  --aggregates '{"count": "count(*)", "total_value": "sum(<numeric_col>)"}' \
  --search '{"name": "%<search_term>%"}' \
  --group-by '<category_column>'
```

## Ordering

```bash
# Order by single column descending
python scripts/db_tool.py read <table_name> --order '<column>.desc' --limit 10

# Order by column ascending (default)
python scripts/db_tool.py read <table_name> --order '<column>.asc' --limit 10

# Multiple columns
python scripts/db_tool.py read <table_name> --order '<col1>.desc,<col2>.asc' --limit 10
```

## Supported Aggregate Functions

- `count(*)` or `count(column)`
- `sum(column)`
- `avg(column)`
- `min(column)`
- `max(column)`

## Filter Operators

| Operator | Meaning |
|----------|---------|
| `gt` | Greater than |
| `gte` | Greater than or equal |
| `lt` | Less than |
| `lte` | Less than or equal |
| `eq` | Equal |
| `neq` | Not equal |
| `in` | In list |