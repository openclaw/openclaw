# AutifyME Database Tool/Skill — Deep Dive Analysis

**Created:** 2026-02-13  
**Purpose:** Complete analysis of AutifyME's database layer for designing an OpenClaw skill.

---

## TABLE OF CONTENTS

1. [Architecture Overview](#1-architecture-overview)
2. [Tool Definitions & Interface](#2-tool-definitions--interface)
3. [DB Tool Implementations](#3-db-tool-implementations)
4. [Supabase Client (Storage Layer)](#4-supabase-client-storage-layer)
5. [Schema Registry & v2 Schema](#5-schema-registry--v2-schema)
6. [WriteIntent System](#6-writeintent-system)
7. [Access Control & Table Scoping](#7-access-control--table-scoping)
8. [Query Patterns & Capabilities](#8-query-patterns--capabilities)
9. [SQL Migrations & RPC Functions](#9-sql-migrations--rpc-functions)
10. [Configuration & Connection](#10-configuration--connection)
11. [Redesign Vision (OpenClaw)](#11-redesign-vision-openclaw)
12. [Key Takeaways for OpenClaw Skill Design](#12-key-takeaways-for-openclaw-skill-design)

---

## 1. ARCHITECTURE OVERVIEW

AutifyME uses a **hexagonal architecture** with ports and adapters:

```
LangChain StructuredTool (4 tools)
  → StorageInterface (abstract port, composed of 7 mixins)
    → SupabaseStorageClient (concrete adapter)
      → Supabase PostgREST API (reads/writes)
      → Supabase RPC functions (aggregates, atomic writes)
```

**Key files:**
| Layer | File | Purpose |
|-------|------|---------|
| Tools | `agents/src/autifyme_agents/tools/data_engine/` | 4 LangChain tools |
| Port | `agents/src/autifyme_agents/core/ports/storage.py` | Abstract interface (7 mixins) |
| Adapter | `agents/src/autifyme_agents/integrations/storage/supabase_client.py` | 3600+ line Supabase implementation |
| Schemas | `agents/src/autifyme_agents/schemas/write_intent.py` | WriteIntent/Operation/AssetUpload Pydantic models |
| Schema Registry | `agents/src/autifyme_agents/schemas/registry/versions/complete_database/v2.json` | Full schema definition (JSON) |
| Migrations | `database/migrations/001-007` | 7 SQL migration files |

---

## 2. TOOL DEFINITIONS & INTERFACE

Four LangChain `StructuredTool` instances, each created via factory functions:

### 2.1 `inspect_schema`
**File:** `tools/data_engine/inspect_schema.py`  
**Factory:** `create_inspect_schema_tool(storage, tables?, version?, domain?)`

**Input schema (`InspectSchemaInput`):**
| Parameter | Type | Description |
|-----------|------|-------------|
| `tables` | `list[str]` | Tables to inspect |
| `details` | `list[Literal["structure","relationships","constraints","stats","samples"]]` | What to return |
| `sample_limit` | `int` (1-10, default 3) | Sample rows per table |

**How it works:**
- Loads from `SchemaRegistry` (JSON file), NOT from live database `information_schema`
- `structure`: columns, types, nullable, defaults, descriptions, required/unique columns, indexes
- `relationships`: FK targets, cascade rules
- `constraints`: enum valid_values, regex patterns, computed columns, JSONB schemas
- `stats`: Live query via `storage.get_table_stats()`
- `samples`: Live query via `storage.sample_data()`

**Key insight:** Schema is **pre-baked in a JSON registry file** (`v2.json`), not discovered at runtime. Only stats and samples hit the live DB.

### 2.2 `read_data`
**File:** `tools/data_engine/read_data.py`  
**Factory:** `create_read_data_tool(storage, tables?)`

**Input schema (`ReadDataInput`):**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `table` | `str` | required | Table name |
| `filters` | `dict[str, Any]` | None | Exact match / IN filters |
| `search_patterns` | `dict[str, str\|list[str]]` | None | ILIKE patterns with `%` wildcards |
| `columns` | `list[str]` | None (all) | Column selection |
| `relations` | `list[str]` | None | PostgREST join syntax |
| `ids` | `list[str]` | None | Batch fetch by IDs |
| `limit` | `int` (1-1000) | 50 | Row limit |
| `offset` | `int` | None | Pagination offset |
| `count_only` | `bool` | False | Return count instead of rows |

**Three modes:**
1. **Batch read** (`ids` provided): `storage.batch_read()` — IN clause by ID
2. **Count only** (`count_only=True`): `storage.count_entities()` — exact count
3. **Standard query**: `storage.query_advanced()` — filters + search + relations + limit

**Critical distinction hammered into tool description:**
- `filters` = exact match (IDs, booleans, enums) — uses `.eq()` / `.in_()`
- `search_patterns` = fuzzy ILIKE match (names, text) — uses `.ilike()` / `.or_()`

### 2.3 `aggregate_data`
**File:** `tools/data_engine/aggregate_data.py`  
**Factory:** `create_aggregate_data_tool(storage, tables?)`

**Input schema (`AggregateDataInput`):**
| Parameter | Type | Description |
|-----------|------|-------------|
| `table` | `str` | Table to aggregate |
| `aggregates` | `dict[str, str]` | `{alias: "function(column)"}` — count, sum, avg, min, max |
| `filters` | `dict[str, Any]` | Pre-aggregation exact filters |
| `search_patterns` | `dict[str, str\|list[str]]` | Pre-aggregation ILIKE patterns |
| `group_by` | `list[str]` | GROUP BY columns |
| `having` | `dict[str, Any]` | Post-aggregation filters (`{alias: {gt: 10}}`) |

**Implementation:** Calls `storage.query_aggregate()` → tries RPC function `dynamic_aggregate` first → raises error if RPC not found (no PostgREST fallback).

### 2.4 `write_data`
**File:** `tools/data_engine/write_data.py`  
**Factory:** `create_write_data_tool(storage, tables?)`

**Input schema (`WriteDataInput` extends `WriteIntent`):**
| Parameter | Type | Description |
|-----------|------|-------------|
| `goal` | `str` | Human-readable goal |
| `reasoning` | `str` | Why this operation (duplicate checks, research) |
| `hitl_summary` | `str` | Plain language for business user approval |
| `operations` | `list[Operation]` | Array of CRUD operations |
| `impact` | `dict[str, Any]` | What changes (creates/updates/deletes counts) |
| `asset_uploads` | `list[AssetUpload]` | Files to upload before DB ops |
| `dry_run` | `bool` | Preview without executing |
| `validate_only` | `bool` | Schema check only |

**Uses `MultiOperationExecutor`** (see Section 6).

---

## 3. DB TOOL IMPLEMENTATIONS

### 3.1 File Structure

```
tools/data_engine/
  __init__.py          — exports 4 factory functions
  inspect_schema.py    — schema discovery (from JSON registry + live stats/samples)
  read_data.py         — unified read (query, batch, count)
  aggregate_data.py    — GROUP BY analytics via RPC
  write_data.py        — multi-op atomic writes via WriteIntent
  _executor.py         — MultiOperationExecutor (transaction engine)
```

### 3.2 Tool Creation Pattern

All tools are created by specialist/analyst setup code (not shown in data_engine itself). The pattern:

```python
# Specialist with scoped access
read_tool = create_read_data_tool(storage, tables=CATALOG_TABLES_CRUD)
write_tool = create_write_data_tool(storage, tables=CATALOG_TABLES_CRUD)

# Analyst with full read access  
read_tool = create_read_data_tool(storage)  # No table restriction
```

The `tables` parameter controls access — if provided, any query to an unlisted table returns `ACCESS_DENIED`.

### 3.3 Error Handling Pattern

All tools use `build_agent_error_response()` and `build_success_response()` from `core/tool_error_handler.py`:
- Success: `{"success": True, "table": "...", "results": [...], "count": N}`
- Error: `{"success": False, "error": "...", "error_type": "QUERY_ERROR", "Agent Action": "..."}`

Error messages are **agent-actionable** — they tell the LLM what to do next (e.g., "Check available tables with inspect_schema tool").

---

## 4. SUPABASE CLIENT (Storage Layer)

**File:** `agents/src/autifyme_agents/integrations/storage/supabase_client.py` (3600+ lines)

### 4.1 Connection Setup

```python
class SupabaseStorageClient(StorageInterface):
    def __init__(self, supabase_url=None, service_key=None, client=None):
        self._supabase_url = supabase_url or settings.SUPABASE_URL
        derived_key = service_key or settings.SUPABASE_SERVICE_ROLE_KEY or settings.SUPABASE_ANON_KEY
```

- Uses **service role key** (bypasses RLS) or falls back to **anon key** (RLS enforced)
- Two clients: **sync** (`_client`) and **async** (`_async_client`) — lazy initialization
- HTTP/1.1 forced (HTTP/2 disabled to prevent connection issues)
- Connection validated on init by querying `companies` table
- Event loop awareness: recreates async client if running in new loop (Lambda reuse)

### 4.2 Key Methods for Data Engine

| Method | Returns | Used By |
|--------|---------|---------|
| `query_advanced(table, filters, columns, relations, search_patterns, count_only, limit)` | `list[dict]` or `int` | read_data |
| `batch_read(table, ids, relations)` | `list[dict]` | read_data (batch mode) |
| `count_entities(table, filters)` | `int` | read_data (count mode) |
| `query_aggregate(table, aggregates, filters, search_patterns, group_by, having)` | `list[dict]` | aggregate_data |
| `insert_entity(table, data)` | `dict` | write_data executor |
| `insert_entities(table, data)` | `list[dict]` | write_data executor |
| `update_entities(table, filters, updates)` | `int` | write_data executor |
| `delete_entities(table, filters, soft_delete)` | `int` | write_data executor |
| `upsert_entity(table, data, conflict_fields)` | `dict` | write_data executor |
| `bulk_upsert(table, data, conflict_fields)` | `list[dict]` | write_data executor |
| `execute_write_intent_rpc(operations, context)` | `dict` | write_data executor (atomic) |
| `get_table_stats(table)` | `dict` | inspect_schema |
| `sample_data(table, limit)` | `list[dict]` | inspect_schema |
| `move_asset(source_path, target_folder, bucket)` | `dict` | write_data executor (assets) |
| `upload_asset(file_path, bucket, folder)` | `dict` | write_data executor (assets) |

### 4.3 Query Construction (PostgREST)

**NOT raw SQL.** All queries go through the Supabase Python client which generates PostgREST REST API calls:

```python
# Filters
query = client.table(table).select(select_clause)
for key, value in filters.items():
    if isinstance(value, list):
        query = query.in_(key, value)           # IN operator
    elif isinstance(value, str) and not self._is_uuid(value):
        query = query.ilike(key, value)         # Case-insensitive for strings
    else:
        query = query.eq(key, value)            # Exact match

# Search patterns (ILIKE with OR support)
for key, patterns in search_patterns.items():
    if isinstance(patterns, list):
        or_conditions = ",".join(f"{key}.ilike.{p}" for p in patterns)
        query = query.or_(or_conditions)        # OR between patterns
    else:
        query = query.ilike(key, patterns)      # Single ILIKE

# Relations (PostgREST embedding)
select_clause = "*,categories(name,code),variant_axes(*)"
```

**Filter operators for updates/deletes:**
```python
# Nested dict operators: {"id": {"in": [...]}, "price": {"gt": 100}}
if operator == "in": query.in_(key, operand)
if operator == "gt": query.gt(key, operand)
if operator == "gte": query.gte(key, operand)
# etc: lt, lte, eq, neq
```

### 4.4 Numeric Normalization

```python
def _normalize_numeric_types(data):
    """Convert 1.0 → 1 for PostgreSQL integer columns."""
```
LLMs often generate `1.0` instead of `1` — this prevents PostgreSQL type errors.

---

## 5. SCHEMA REGISTRY & V2 SCHEMA

### 5.1 Schema Registry System

**File:** `agents/src/autifyme_agents/schemas/registry/`

The schema is stored as a **static JSON file** (`v2.json`) loaded by `SchemaRegistry`:
- Version: `v2`
- Domain: `complete_database`
- ~4600 lines of JSON defining all tables

### 5.2 V2 Database Tables

From `v2.json` and `docs/database/COMPLETE_SCHEMA_EXPORT.md`, the full table set:

#### Core Product Catalog
| Table | Description | Key Columns |
|-------|-------------|-------------|
| `product_families` | Product groupings (parent) | id, product_group_id (unique), sku_prefix (unique), name, brand, category_id, base_price, lifecycle_stage, tags[], custom_attributes (jsonb) |
| `products` | Individual SKUs (child) | id, product_family_id (FK), sku (unique), name, price, stock_quantity, availability, is_primary_variant |
| `variant_axes` | Variant dimensions per family | id, product_family_id (FK), name (snake_case), display_label, sort_order |
| `variant_values` | Values per axis | id, variant_axis_id (FK), value, sku_code, price_adjustment, color_hex |
| `product_variant_values` | M:N junction (product↔variant_value) | product_id (FK), variant_value_id (FK) |

#### Pricing
| Table | Description |
|-------|-------------|
| `price_lists` | Pricing contexts (wholesale, retail, MRP) |
| `product_prices` | Price entries per product per list |

#### Taxonomy
| Table | Description |
|-------|-------------|
| `categories` | Hierarchical categories (parent_id self-ref) |
| `industries` | NAICS industry codes |

#### Assets & Media
| Table | Description |
|-------|-------------|
| `assets` | Digital assets with storage paths, MIME types, AI lineage |
| `product_images` | Multi-level image junction (family or product level) |
| `product_assets` | Product-to-asset junction |

#### Marketing
| Table | Description |
|-------|-------------|
| `marketing_content` | Platform-specific content with versioning |
| `customer_segments` | B2B/B2C/D2C targeting per family |
| `product_family_industries` | M:N industry targeting junction |
| `campaigns` | Marketing campaigns |
| `campaign_products` / `campaign_channels` / `campaign_assets` | Campaign junctions |

#### UoM (Units of Measure)
| Table | Description |
|-------|-------------|
| `uom` | Master units (KG, PCS, etc.) with categories |
| `uom_conversion` | Global unit conversions |
| `product_uom_conversion` | Product-specific conversions |

#### Company
| Table | Description |
|-------|-------------|
| `companies` | Single-tenant company profile |
| `company_intelligence` | AI-discovered brand intelligence |

#### Operational / System
| Table | Description |
|-------|-------------|
| `workflow_outcomes` | Execution tracking |
| `processed_messages` | Webhook idempotency |
| `pending_messages` | Message batching buffer |
| `checkpoints` / `checkpoint_writes` / `checkpoint_blobs` | LangGraph state persistence |

### 5.3 Key Relationships

```
product_families (1) ──→ (N) products
product_families (1) ──→ (N) variant_axes ──→ (N) variant_values
products (M) ←──→ (N) variant_values  [via product_variant_values]
product_families (1) ──→ (N) customer_segments
product_families (M) ←──→ (N) industries  [via product_family_industries]
product_families (N) ──→ (1) categories
products (1) ──→ (N) product_prices ──→ (1) price_lists
products (M) ←──→ (N) assets  [via product_assets]
```

---

## 6. WRITEINTENT SYSTEM

**File:** `agents/src/autifyme_agents/schemas/write_intent.py`  
**Executor:** `agents/src/autifyme_agents/tools/data_engine/_executor.py`

### 6.1 Data Model

```
WriteIntent
  ├── goal: str              — "Create PET Bottles family with variants"
  ├── reasoning: str         — "Duplicate check: 0 matches. Research complete."
  ├── hitl_summary: str      — Plain language for business user approval
  ├── asset_uploads: [AssetUpload]  — Files to move/upload before DB ops
  ├── operations: [Operation]       — Ordered CRUD operations
  └── impact: dict           — {creates: {table: count}, warnings: [...]}

Operation
  ├── action: create|update|delete|upsert
  ├── table: str
  ├── data: dict | list[dict]     — For create/upsert
  ├── filters: dict               — For update/delete
  ├── updates: dict               — For update
  ├── dependencies: list[str]     — Named deps (e.g., ["parent", "axes"])
  ├── returns: str                — Name for cross-references
  ├── on_conflict: error|skip|update
  ├── conflict_fields: list[str]
  └── soft_delete: bool (default True)

AssetUpload
  ├── storage_path: str     — Supabase path (pending/...)
  ├── returns: str          — Reference name
  ├── caption: str          — HITL preview text
  ├── bucket: str           — "assets"
  └── target_folder: str    — "products"
```

### 6.2 MultiOperationExecutor

**File:** `tools/data_engine/_executor.py`

**Execution flow:**
1. **Validate** — required fields, no circular deps, resolvable references
2. **Dry-run** (optional) — preview impact without executing
3. **Phase 1: Assets** — upload/move files to Supabase Storage
4. **Phase 2: DB Operations** — ALL ops via single `execute_write_intent_rpc()` call (atomic)
5. **On failure** — Postgres auto-rolls back DB; executor deletes uploaded assets

**Dependency Resolution:**
- Topological sort (Kahn's algorithm) on operation `dependencies` / `returns` graph
- Detects circular dependencies

**Reference Resolution:**
- `@parent.id` → context["parent"]["id"]
- `@axes_batch[0].id` → context["axes_batch"][0]["id"]
- `@product_image.public_url` → context from asset upload result
- Resolved by RPC function server-side (context passed to RPC)

**Atomic execution via RPC:**
- All operations sent as a single array to `execute_write_intent_rpc(operations, context)`
- Postgres function executes them in one transaction
- If ANY operation fails, entire transaction rolls back

### 6.3 Error Messages

Errors are categorized and include agent-actionable guidance:
- `CONSTRAINT_VIOLATION` → "Check for duplicate values in unique fields"
- `MISSING_REFERENCE` → "Ensure referenced entities exist, create parents first"
- `VALIDATION_ERROR` → "Fix data format/values, check schema requirements"
- `DEPENDENCY_ERROR` → "Reorder operations to resolve dependencies"

---

## 7. ACCESS CONTROL & TABLE SCOPING

### 7.1 Application-Level Access Control

Each tool factory accepts an optional `tables: list[str]` parameter:

```python
# Specialist: can only touch catalog tables
create_read_data_tool(storage, tables=["products", "product_families", "variant_axes", ...])

# Analyst: full read access
create_read_data_tool(storage)  # tables=None → no restriction
```

If a query targets an unlisted table → `ACCESS_DENIED` error with available tables listed.

### 7.2 Database-Level (RLS)

- Service role key **bypasses RLS** (used in production)
- Anon key respects RLS policies
- The `dynamic_aggregate` RPC has a **hardcoded table whitelist**:
  ```sql
  IF p_table NOT IN ('products', 'product_families', 'product_prices', 
     'price_lists', 'categories', 'variant_axes', 'variant_values', ...)
  THEN RAISE EXCEPTION 'Access denied to table: %', p_table;
  ```
- `SECURITY DEFINER` on RPC functions = runs with function owner's privileges

### 7.3 Single-Tenant Architecture

- One company per Supabase project
- No `tenant_id` column; isolation is at the project level
- Company profile loaded from `companies` table (always `LIMIT 1`)

---

## 8. QUERY PATTERNS & CAPABILITIES

### 8.1 Supported Operations

| Pattern | Support | Implementation |
|---------|---------|----------------|
| **Simple select** | ✅ | PostgREST `.select()` |
| **Exact filters** | ✅ | `.eq()`, `.in_()` |
| **Fuzzy search (ILIKE)** | ✅ | `.ilike()` with `%` wildcards |
| **OR search** | ✅ | `.or_()` with multiple ILIKE patterns |
| **Relations/Joins** | ✅ | PostgREST embedding: `table(col1,col2)` |
| **Nested joins** | ✅ | `parent(*,child(*))` syntax |
| **Batch by IDs** | ✅ | `.in_("id", ids)` |
| **Pagination** | ✅ | `limit` + `offset` (also cursor-based via `paginate_query`) |
| **Count** | ✅ | `count="exact"` header |
| **Aggregations** | ✅ | RPC `dynamic_aggregate` (count, sum, avg, min, max) |
| **GROUP BY** | ✅ | Via RPC |
| **HAVING** | ✅ | Via RPC (gt, gte, lt, lte, eq, neq operators) |
| **Insert** | ✅ | `.insert()` |
| **Bulk insert** | ✅ | `.insert(list)` |
| **Update** | ✅ | `.update().eq()/in_()` with operator dicts |
| **Upsert** | ✅ | `.upsert(on_conflict=...)` |
| **Soft delete** | ✅ | `is_active=False, deleted_at=now()` |
| **Hard delete** | ✅ | `.delete()` |
| **Multi-table atomic** | ✅ | RPC `execute_write_intent_rpc` (single transaction) |
| **Cross-reference** | ✅ | `@name.field` syntax resolved by RPC |
| **Asset upload** | ✅ | Supabase Storage move/upload |
| **Raw SQL** | ❌ | Not supported — all via PostgREST/RPC |
| **Complex JOINs** | ⚠️ | Limited to PostgREST FK-based embedding |
| **Subqueries** | ❌ | Not supported |
| **Window functions** | ❌ | Not supported |

### 8.2 Query Complexity Examples

**Simple read:**
```python
read_data(table="products", filters={"is_active": True}, limit=50)
```

**Fuzzy search with relations:**
```python
read_data(
    table="products",
    search_patterns={"name": ["%PET%", "%bottle%"]},
    relations=["product_families(name,sku_prefix)"],
    columns=["id", "sku", "name", "price"]
)
```

**Aggregation with GROUP BY + HAVING:**
```python
aggregate_data(
    table="products",
    aggregates={"count": "count(*)", "avg_price": "avg(price)"},
    filters={"is_active": True},
    group_by=["product_family_id"],
    having={"count": {"gt": 5}}
)
```

**Multi-table atomic write:**
```python
write_data(
    goal="Create PET Bottles family with 4 variants",
    operations=[
        {"action": "create", "table": "product_families", "data": {...}, "returns": "family"},
        {"action": "create", "table": "variant_axes", 
         "data": [{"name": "size", "product_family_id": "@family.id"}],
         "dependencies": ["family"], "returns": "axes"},
        {"action": "create", "table": "products",
         "data": [{"product_family_id": "@family.id", "sku": "PET-500ML", ...}],
         "dependencies": ["family"]}
    ],
    impact={"creates": {"product_families": 1, "variant_axes": 1, "products": 4}}
)
```

---

## 9. SQL MIGRATIONS & RPC FUNCTIONS

**Directory:** `database/migrations/`

| Migration | Purpose |
|-----------|---------|
| `001_workflow_outcomes.sql` | Workflow tracking tables + views |
| `002_processed_messages.sql` | Webhook idempotency |
| `003_add_trace_id.sql` | LangSmith trace ID to outcomes |
| `004_storage_policies.sql` | Supabase Storage bucket policies |
| `005_assets_caption.sql` | Caption field on assets |
| `006_dynamic_aggregate_rpc.sql` | `dynamic_aggregate()` function |
| `007_fix_array_type_handling.sql` | Array type fix for aggregates |

### Key RPC Functions

**`dynamic_aggregate(p_table, p_aggregates, p_filters, p_group_by, p_having, p_limit)`**
- Builds dynamic SQL for aggregate queries
- Table whitelist for security
- Validates aggregate function names (regex: `^(count|sum|avg|min|max)\s*\(`)
- Handles ILIKE via `__ilike__` prefix in filters
- `SECURITY DEFINER` + `search_path = public`

**`execute_write_intent_rpc(operations, context)`** (referenced but SQL not in migrations — likely exists in base schema)
- Executes array of operations in single transaction
- Resolves `@name.field` references from context
- Returns results array with action, table, count, data per operation

**`check_and_mark_processed(p_message_id, ...)`** — Atomic INSERT ON CONFLICT for idempotency

**`fetch_and_clear_pending_batch(p_batch_key)`** — Atomic fetch + delete for message batching

---

## 10. CONFIGURATION & CONNECTION

**File:** `agents/src/autifyme_agents/core/config.py`

```python
class Settings(BaseSettings):
    SUPABASE_URL: str                          # Required
    SUPABASE_ANON_KEY: str                     # Required  
    SUPABASE_SERVICE_ROLE_KEY: str | None       # Optional (bypasses RLS)
    DATABASE_URL: str                           # PostgreSQL direct (for LangGraph)
```

**Environment:** Loaded from `.env` via `pydantic_settings`.

**Connection details:**
- PostgREST (via supabase-py): HTTP/1.1, 120s timeout, 10 max connections
- Service role key = full access (no RLS)
- Anon key = restricted (RLS enforced)
- Both sync and async clients available

---

## 11. REDESIGN VISION (OpenClaw)

From `docs/REDESIGN_MASTER_DOCUMENT.md`:

### 11.1 Core Change

**Before:** 4 LangChain StructuredTools + StorageInterface port + SupabaseStorageClient adapter (3600+ lines)  
**After:** Single `db_tool.py` CLI script called via `exec`

### 11.2 Planned CLI Interface

```bash
python db_tool.py tables [--pattern "product*"]
python db_tool.py inspect <table> [--details structure|constraints|all]
python db_tool.py read <table> [--filters '{}'] [--search '{}'] [--select "col1,col2"] [--limit 50]
python db_tool.py write <table> --data '{}' [--operation insert|update|upsert|delete] [--match '{}'] [--dry-run]
python db_tool.py aggregate <table> --function count|sum|avg|min|max [--column col] [--group-by col]
```

### 11.3 Key Behaviors to Preserve

From the redesign document:
1. **filters vs search_patterns** — separate parameters (exact vs ILIKE)
2. **List values in filters** → IN operator
3. **Join support** for related tables
4. **dry-run mode** for write preview
5. **Multi-operation support** with FK resolution (parent + child in one call)
6. **Schema inspection** — columns, types, nullable, defaults, constraints, FKs
7. **GROUP BY with HAVING** for aggregates

### 11.4 Architecture Simplification

| AutifyME | OpenClaw |
|----------|----------|
| StorageInterface (7 mixins, ~600 lines abstract) | Direct supabase-py calls |
| SupabaseStorageClient (3600+ lines) | ~300 lines in db_tool.py |
| 4 LangChain StructuredTools | CLI commands |
| SchemaRegistry JSON | Live `information_schema` or embedded JSON |
| WriteIntent Pydantic models | JSON in/out |
| MultiOperationExecutor | Simplified multi-op in db_tool.py |
| `build_agent_error_response()` | JSON to stdout, errors to stderr |

### 11.5 HITL Change

**Before:** WriteIntent includes `hitl_summary`, middleware intercepts for approval  
**After:** Sub-agent does dry-run → reports back → main agent asks user → executes

---

## 12. KEY TAKEAWAYS FOR OPENCLAW SKILL DESIGN

### 12.1 What Works Well (Keep)

1. **4-tool paradigm** — inspect → read → aggregate → write is a proven pattern
2. **filters vs search_patterns** distinction — prevents LLM confusion, eliminates zero-result bugs
3. **WriteIntent pattern** — goal + reasoning + operations + impact structure gives excellent LLM outputs
4. **Dependency resolution** — `@name.field` cross-references + topological sort
5. **Dry-run mode** — critical for HITL safety
6. **Agent-actionable errors** — error messages tell the LLM what to do next
7. **Table scoping** — access control per agent role
8. **Numeric normalization** — `1.0 → 1` for PostgreSQL compatibility

### 12.2 What to Simplify

1. **No hexagonal architecture needed** — direct supabase-py calls in a CLI script
2. **No LangChain dependency** — plain Python with JSON I/O
3. **No 7-mixin abstract interface** — one class or module
4. **Schema can be live-queried** OR embedded (the JSON registry is nice but adds maintenance)
5. **PostgREST is fine for reads** but aggregates need RPC — the `dynamic_aggregate` pattern should be preserved or improved

### 12.3 Critical Implementation Notes

1. **Supabase-py handles query building** — no raw SQL needed for CRUD
2. **Aggregates REQUIRE the RPC function** — PostgREST doesn't support aggregate functions natively
3. **Atomic multi-table writes REQUIRE an RPC function** — PostgREST is single-table per request
4. **Service role key bypasses RLS** — this is intentional for server-side operations
5. **The v2 schema has 20+ tables** — the skill needs schema awareness to be useful
6. **Relations use PostgREST embedding** — `table(col1,col2)` not SQL JOINs

### 12.4 Skill File Structure (Recommended)

```
skills/database/
  SKILL.md              # How to use db_tool.py, inspect→read→write pattern
  db_tool.py            # CLI: tables, inspect, read, write, aggregate
  schema/
    v2.json             # Optional: embedded schema for inspect without live DB
  knowledge/
    query_patterns.md   # Extracted from tool_mastery protocols
    write_intent.md     # WriteIntent pattern docs
```

### 12.5 Environment Requirements

```
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_KEY=<service_role_key>  # or SUPABASE_SERVICE_ROLE_KEY
```

Dependencies: `supabase` Python package (pip install supabase)

---

**END OF ANALYSIS**
