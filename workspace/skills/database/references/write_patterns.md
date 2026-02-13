# WriteIntent Patterns

Every write uses the same WriteIntent format — even single-row creates.

## 1. Single Row Create

```json
{
  "goal": "Create new <entity_type> entry",
  "reasoning": "Business justification for creating this record.",
  "operations": [
    {
      "action": "create",
      "table": "<table_name>",
      "data": {
        "code": "<CODE>",
        "name": "<Entity Name>",
        "category": "<CATEGORY>",
        "is_active": true,
        "decimal_places": 3
      }
    }
  ],
  "impact": {"creates": {"<table_name>": 1}}
}
```

Note: `id` and `created_at` are auto-generated.

## 2. Multi-Table: Parent + Children

```json
{
  "goal": "Create <parent_entity> with child records",
  "reasoning": "Business need description. No duplicates found.",
  "operations": [
    {
      "action": "create",
      "table": "<parent_table>",
      "data": {
        "name": "<Parent Entity>",
        "code": "<PRT>",
        "brand": "<Brand Name>",
        "base_price": 100.00,
        "lifecycle_stage": "<active>"
      },
      "returns": "parent"
    },
    {
      "action": "create",
      "table": "<axis_table>",
      "data": [
        {"parent_id": "@parent.id", "name": "<axis_name>", "display_label": "<Display Name>", "sort_order": 1}
      ],
      "returns": "axes"
    },
    {
      "action": "create",
      "table": "<value_table>",
      "data": [
        {"axis_id": "@axes.id", "value": "<value1>", "code": "<VAL1>"},
        {"axis_id": "@axes.id", "value": "<value2>", "code": "<VAL2>"},
        {"axis_id": "@axes.id", "value": "<value3>", "code": "<VAL3>"},
        {"axis_id": "@axes.id", "value": "<value4>", "code": "<VAL4>"}
      ],
      "returns": "values"
    },
    {
      "action": "create",
      "table": "<child_table>",
      "data": [
        {"parent_id": "@parent.id", "code": "<CHILD1>", "name": "<Child 1>", "price": 150},
        {"parent_id": "@parent.id", "code": "<CHILD2>", "name": "<Child 2>", "price": 200},
        {"parent_id": "@parent.id", "code": "<CHILD3>", "name": "<Child 3>", "price": 250},
        {"parent_id": "@parent.id", "code": "<CHILD4>", "name": "<Child 4>", "price": 300}
      ]
    }
  ],
  "impact": {
    "creates": {"<parent_table>": 1, "<axis_table>": 1, "<value_table>": 4, "<child_table>": 4}
  }
}
```

Dependencies are **auto-detected** from `@parent.id` and `@axes.id` references.

## 3. Update with Filters

```json
{
  "goal": "Update <entity> prices by percentage",
  "reasoning": "Business decision approved. Affects multiple records.",
  "operations": [
    {
      "action": "update",
      "table": "<table_name>",
      "filters": {"parent_id": "<uuid-of-parent>"},
      "updates": {"price": 275.50, "updated_at": "now()"}
    }
  ],
  "impact": {"updates": {"<table_name>": "estimated count"}}
}
```

## 4. Upsert (Insert or Update)

```json
{
  "goal": "Upsert <entity> entries for <context>",
  "reasoning": "Some records may already exist. Using upsert for idempotency.",
  "operations": [
    {
      "action": "upsert",
      "table": "<junction_table>",
      "data": [
        {"entity_id": "<uuid-1>", "list_id": "<list-uuid>", "value": 200.00},
        {"entity_id": "<uuid-2>", "list_id": "<list-uuid>", "value": 350.00}
      ],
      "on_conflict": "update",
      "conflict_fields": ["entity_id", "list_id"]
    }
  ],
  "impact": {"creates": {"<junction_table>": 2}}
}
```

## 5. Soft Delete

```json
{
  "goal": "Discontinue <specific_entity>",
  "reasoning": "Business decision. Soft delete to preserve history.",
  "operations": [
    {
      "action": "delete",
      "table": "<table_name>",
      "filters": {"code": "<ENTITY_CODE>"},
      "soft_delete": true
    }
  ],
  "impact": {"deletes": {"<table_name>": 1}}
}
```

Soft delete sets `is_active = false` and `deleted_at = now()` instead of removing the row.

## 6. Bulk Create

```json
{
  "goal": "Add multiple new <entity_type> records",
  "reasoning": "Business need description.",
  "operations": [
    {
      "action": "create",
      "table": "<table_name>",
      "data": [
        {"name": "<Entity Type 1>", "code": "<CODE1>"},
        {"name": "<Entity Type 2>", "code": "<CODE2>"},
        {"name": "<Entity Type 3>", "code": "<CODE3>"}
      ]
    }
  ],
  "impact": {"creates": {"<table_name>": 3}}
}
```

## Key Rules

1. **Always use WriteIntent format** — even for single row operations
2. **`@name.field` references** are auto-resolved — no need to specify `dependencies` manually
3. **`id`, `created_at`, `updated_at`** are auto-set — don't include unless overriding
4. **Numeric values** are auto-normalized (1.0 → 1 for integer columns)
5. **Use `--dry-run`** to preview before executing
6. **All operations are atomic** — if one fails, everything rolls back