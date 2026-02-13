#!/usr/bin/env python3
"""
OpenClaw Database Tool — Single CLI for all database operations.

Ported from AutifyME's 3600+ line Supabase client + 4 LangChain tools
into a compact, model-agnostic CLI. JSON in, JSON out.

Subcommands: inspect, read, aggregate, write, sync-schema
Connection: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY)

Usage:
    python db_tool.py inspect [table] [--detailed]
    python db_tool.py read <table> [--filters '{}'] [--search '{}'] ...
    python db_tool.py aggregate <table> --aggregates '{}' ...
    python db_tool.py write --intent '{WriteIntent JSON}'
    python db_tool.py sync-schema [--compare-only]
"""

import argparse
import json
import os
import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Auto-load .env from workspace root (3 levels up from scripts/)
_env_path = Path(__file__).resolve().parent.parent.parent.parent / ".env"
if _env_path.exists():
    with open(_env_path) as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _v = _line.split("=", 1)
                os.environ.setdefault(_k.strip(), _v.strip())

# ---------------------------------------------------------------------------
# Schema loading
# ---------------------------------------------------------------------------

SCHEMA_PATH = Path(__file__).parent.parent / "references" / "schema.json"

_schema_cache: dict[str, Any] | None = None


def load_schema() -> dict[str, Any]:
    global _schema_cache
    if _schema_cache is None:
        with open(SCHEMA_PATH, "r", encoding="utf-8") as f:
            _schema_cache = json.load(f)
    return _schema_cache


def get_table_names() -> list[str]:
    return sorted(load_schema().get("tables", {}).keys())


def get_table_schema(table: str) -> dict[str, Any] | None:
    return load_schema().get("tables", {}).get(table)


def validate_table(table: str) -> None:
    if get_table_schema(table) is None:
        error_exit(
            f"Unknown table: '{table}'",
            hint="Use 'inspect' to list available tables.",
            available_tables=get_table_names(),
        )


def validate_columns(table: str, columns: list[str]) -> None:
    schema = get_table_schema(table)
    if not schema:
        return
    valid = set(schema.get("columns", {}).keys())
    bad = [c for c in columns if c not in valid]
    if bad:
        error_exit(
            f"Unknown columns in '{table}': {bad}",
            hint=f"Valid columns: {sorted(valid)}",
        )


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------


def output(data: dict[str, Any]) -> None:
    json.dump(data, sys.stdout, indent=2, default=str)
    sys.stdout.write("\n")
    sys.exit(0)


def error_exit(error: str, hint: str = "", **extra: Any) -> None:
    result: dict[str, Any] = {"success": False, "error": error}
    if hint:
        result["hint"] = hint
    result.update(extra)
    json.dump(result, sys.stdout, indent=2, default=str)
    sys.stdout.write("\n")
    sys.exit(1)


# ---------------------------------------------------------------------------
# Supabase client (sync)
# ---------------------------------------------------------------------------

_supabase_client = None


def get_client():
    global _supabase_client
    if _supabase_client is None:
        try:
            from supabase import create_client
        except ImportError:
            error_exit(
                "supabase package not installed",
                hint="Run: pip install supabase",
            )

        url = os.environ.get("SUPABASE_URL", "")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get(
            "SUPABASE_KEY", ""
        )
        if not url or not key:
            error_exit(
                "Missing environment variables",
                hint="Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY)",
            )
        _supabase_client = create_client(url, key)
    return _supabase_client


# ---------------------------------------------------------------------------
# Numeric normalization (LLMs produce 1.0 for integers)
# ---------------------------------------------------------------------------


def normalize_numeric(data: Any) -> Any:
    if isinstance(data, float) and data.is_integer():
        return int(data)
    if isinstance(data, dict):
        return {k: normalize_numeric(v) for k, v in data.items()}
    if isinstance(data, list):
        return [normalize_numeric(v) for v in data]
    return data


# ---------------------------------------------------------------------------
# Type coercion based on schema column types
# ---------------------------------------------------------------------------

_INT_TYPES = {"integer", "bigint", "smallint", "int4", "int8", "int2"}
_FLOAT_TYPES = {"decimal", "numeric", "real", "double precision", "float4", "float8"}
_BOOL_TYPES = {"boolean", "bool"}


def coerce_value(value: Any, col_type: str) -> Any:
    """Coerce a filter/data value to match the schema column type."""
    if value is None:
        return None
    col_type_lower = col_type.lower()
    if col_type_lower in _INT_TYPES:
        try:
            return int(float(value))
        except (ValueError, TypeError):
            return value
    if col_type_lower in _FLOAT_TYPES:
        try:
            return float(value)
        except (ValueError, TypeError):
            return value
    if col_type_lower in _BOOL_TYPES:
        if isinstance(value, str):
            return value.lower() in ("true", "1", "yes")
        return bool(value)
    return value


def coerce_filters(table: str, filters: dict[str, Any]) -> dict[str, Any]:
    """Type-coerce filter values based on schema column types."""
    schema = get_table_schema(table)
    if not schema:
        return filters
    columns = schema.get("columns", {})
    result = {}
    for key, value in filters.items():
        col_info = columns.get(key)
        if col_info and not isinstance(value, (dict, list)):
            result[key] = coerce_value(value, col_info.get("type", ""))
        elif col_info and isinstance(value, list):
            col_type = col_info.get("type", "")
            result[key] = [coerce_value(v, col_type) for v in value]
        else:
            result[key] = value
    return result


# NOTE: This function was an attempt to add operator support to aggregates
# but the dynamic_aggregate RPC doesn't support it. Keeping for future reference.
# def expand_aggregate_filters(table: str, filters: dict[str, Any]) -> dict[str, Any]:
#     """Expand operator syntax in filters for aggregate RPC function."""
#     # Implementation removed - RPC doesn't support operator syntax


# ---------------------------------------------------------------------------
# INSPECT
# ---------------------------------------------------------------------------


def cmd_inspect(args: argparse.Namespace) -> None:
    if not args.table:
        output({"success": True, "tables": get_table_names(), "count": len(get_table_names())})

    table = args.table
    validate_table(table)
    schema = get_table_schema(table)
    assert schema is not None

    cols = schema.get("columns", {})
    if not args.detailed:
        compact = []
        for name, info in cols.items():
            entry: dict[str, Any] = {
                "name": name,
                "type": info.get("type", "unknown"),
            }
            # Support both old schema format (nullable/primary_key/references)
            # and new OpenAPI-derived format (required/pk/fk)
            if info.get("required") or not info.get("nullable", True):
                entry["required"] = True
            if info.get("default"):
                entry["default"] = info["default"]
            if info.get("pk") or info.get("primary_key"):
                entry["pk"] = True
            if info.get("fk") or info.get("references"):
                entry["fk"] = info.get("fk") or info.get("references")
            compact.append(entry)
        output({"success": True, "table": table, "columns": compact})
    else:
        # Detailed: full column info + relationships + indexes
        detailed_cols = {}
        for name, info in cols.items():
            entry = dict(info)
            if "valid_values" in info:
                entry["valid_values"] = info["valid_values"]
            if "valid_values_descriptions" in info:
                entry["valid_values_descriptions"] = info["valid_values_descriptions"]
            detailed_cols[name] = entry

        result: dict[str, Any] = {
            "success": True,
            "table": table,
            "description": schema.get("description", ""),
            "columns": detailed_cols,
        }
        if schema.get("relationships"):
            result["relationships"] = schema["relationships"]
        if schema.get("indexes"):
            result["indexes"] = schema["indexes"]
        if schema.get("business_rules"):
            result["business_rules"] = schema["business_rules"]
        output(result)


# ---------------------------------------------------------------------------
# READ
# ---------------------------------------------------------------------------


def cmd_read(args: argparse.Namespace) -> None:
    table = args.table
    validate_table(table)

    filters = json.loads(args.filters) if args.filters else {}
    search = json.loads(args.search) if args.search else {}
    columns = [c.strip() for c in args.columns.split(",")] if args.columns else None
    relations = [r.strip() for r in args.relations.split(",")] if args.relations else None
    limit = args.limit or 20
    offset = args.offset or 0
    count_only = args.count_only

    # Validate columns exist
    if columns:
        validate_columns(table, columns)

    # Type-coerce filters
    filters = coerce_filters(table, filters)

    client = get_client()

    # Build select clause
    if count_only:
        select_clause = "*"
    elif columns and not relations:
        select_clause = ",".join(columns)
    elif relations:
        base = ",".join(columns) if columns else "*"
        select_clause = f"{base},{','.join(relations)}"
    else:
        select_clause = "*"

    query = client.table(table).select(
        select_clause, count="exact" if count_only else None
    )

    # Apply filters (exact match, operators, IN lists)
    # NOTE: filters are for EXACT matching. Strings in filters use .eq(), not .ilike().
    # Use --search for fuzzy/ILIKE matching.
    SUPPORTED_FILTER_OPS = {"gt", "gte", "lt", "lte", "eq", "neq", "in"}
    for key, value in filters.items():
        if isinstance(value, dict):
            # Operator dict: {"gt": 100, "lte": 500}
            for op, operand in value.items():
                op_lower = op.lower()
                if op_lower not in SUPPORTED_FILTER_OPS:
                    error_exit(
                        f"Unsupported filter operator '{op}' on column '{key}'.",
                        hint=f"Supported operators: {sorted(SUPPORTED_FILTER_OPS)}. Use --search for ILIKE/pattern matching.",
                    )
                if op_lower == "gt":
                    query = query.gt(key, operand)
                elif op_lower == "gte":
                    query = query.gte(key, operand)
                elif op_lower == "lt":
                    query = query.lt(key, operand)
                elif op_lower == "lte":
                    query = query.lte(key, operand)
                elif op_lower == "eq":
                    query = query.eq(key, operand)
                elif op_lower == "neq":
                    query = query.neq(key, operand)
                elif op_lower == "in":
                    query = query.in_(key, operand)
        elif isinstance(value, list):
            query = query.in_(key, value)
        else:
            query = query.eq(key, value)

    # Apply search patterns (ILIKE with % wildcards)
    # List = OR by default. Use {"col": {"all": ["%a%", "%b%"]}} for AND.
    for key, patterns in search.items():
        if isinstance(patterns, dict) and "all" in patterns:
            # AND search: all patterns must match
            for p in patterns["all"]:
                query = query.ilike(key, p)
        elif isinstance(patterns, list):
            or_conds = ",".join(f"{key}.ilike.{p}" for p in patterns)
            query = query.or_(or_conds)
        else:
            query = query.ilike(key, patterns)

    # Ordering
    if args.order:
        for order_spec in args.order.split(","):
            order_spec = order_spec.strip()
            if "." in order_spec:
                col, direction = order_spec.rsplit(".", 1)
                desc = direction.lower() == "desc"
            else:
                col, desc = order_spec, False
            query = query.order(col, desc=desc)

    # Pagination
    if not count_only:
        query = query.limit(limit)
        if offset:
            query = query.offset(offset)

    try:
        response = query.execute()
    except Exception as e:
        error_exit(f"Query failed: {e}", hint="Check filters and table name.")

    if count_only:
        output({"success": True, "table": table, "count": response.count or 0})
    else:
        data = response.data or []
        output({"success": True, "table": table, "count": len(data), "data": data})


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
        return True
    except (ValueError, AttributeError):
        return False


# ---------------------------------------------------------------------------
# AGGREGATE
# ---------------------------------------------------------------------------


def cmd_aggregate(args: argparse.Namespace) -> None:
    table = args.table
    validate_table(table)

    aggregates = json.loads(args.aggregates) if args.aggregates else {}
    filters = json.loads(args.filters) if args.filters else {}
    search = json.loads(args.search) if args.search else {}
    group_by = [c.strip() for c in args.group_by.split(",")] if args.group_by else None
    having = json.loads(args.having) if args.having else None

    if not aggregates:
        error_exit("--aggregates is required", hint='Example: --aggregates \'{"total": "count(*)"}\'')

    # Type-coerce filters
    filters = coerce_filters(table, filters)

    # NOTE: Aggregate filters only support exact equality matching and search patterns
    # For operator-based filtering (gt, lt, etc.), use read command to pre-filter data
    # then aggregate the results, or modify the dynamic_aggregate RPC function
    for key, value in filters.items():
        if isinstance(value, dict):
            error_exit(
                f"Aggregate filters don't support operator syntax in '{key}': {value}",
                hint="Use exact values, lists (for IN), or --search patterns. For complex filtering, use 'read' command first.",
                limitation="AGGREGATE_FILTER_OPERATORS"
            )

    # Merge search patterns into filters with __ilike__ prefix for RPC
    combined_filters = dict(filters)
    if search:
        for col, pattern in search.items():
            combined_filters[f"__ilike__{col}"] = pattern

    # Validate HAVING aliases match aggregate aliases
    if having:
        for alias in having:
            if alias not in aggregates:
                error_exit(
                    f"HAVING references unknown alias '{alias}'",
                    hint=f"Available aliases: {list(aggregates.keys())}. HAVING must reference an alias from --aggregates.",
                )

    client = get_client()

    try:
        response = client.rpc(
            "dynamic_aggregate",
            {
                "p_table": table,
                "p_aggregates": aggregates,
                "p_filters": combined_filters if combined_filters else {},
                "p_group_by": group_by,
                "p_having": having,
            },
        ).execute()
    except Exception as e:
        error_exit(
            f"Aggregate query failed: {e}",
            hint="Ensure dynamic_aggregate RPC function is deployed (migration 006).",
        )

    data = response.data or []
    if isinstance(data, dict):
        data = [data]
    output({"success": True, "table": table, "count": len(data), "data": data})


# ---------------------------------------------------------------------------
# WRITE (WriteIntent)
# ---------------------------------------------------------------------------


def cmd_write(args: argparse.Namespace) -> None:
    intent = json.loads(args.intent)
    dry_run = args.dry_run

    # Validate basic structure
    if "operations" not in intent or not intent["operations"]:
        error_exit("WriteIntent must have non-empty 'operations' array.")
    if "goal" not in intent:
        error_exit("WriteIntent must have a 'goal' field.")

    operations = intent["operations"]

    # Validate each operation
    for i, op in enumerate(operations):
        action = op.get("action")
        if action not in ("create", "update", "delete", "upsert"):
            error_exit(f"Operation {i}: invalid action '{action}'", hint="Use: create, update, delete, upsert")
        table = op.get("table", "")
        validate_table(table)
        if action in ("create", "upsert") and op.get("data") is None:
            error_exit(f"Operation {i} ({action} on {table}): 'data' is required.")
        if action == "update" and op.get("filters") is None:
            error_exit(f"Operation {i} (update on {table}): 'filters' is required.")
        if action == "delete" and op.get("filters") is None:
            error_exit(f"Operation {i} (delete on {table}): 'filters' is required.")
        if action == "update" and op.get("updates") is None and op.get("data") is None:
            error_exit(f"Operation {i} (update on {table}): 'updates' or 'data' required.")

    # Auto-detect dependencies from @references (model doesn't need to specify them)
    returns_set = {op.get("returns") for op in operations if op.get("returns")}
    for i, op in enumerate(operations):
        detected_deps = _detect_refs(op)
        # Validate all @ref aliases point to a real 'returns' name
        invalid_refs = detected_deps - returns_set
        if invalid_refs:
            error_exit(
                f"Operation {i} ({op.get('action','')} on {op.get('table','')}): @ref aliases not found: {sorted(invalid_refs)}",
                hint=f"Available 'returns' aliases: {sorted(returns_set) if returns_set else '(none)'}. Check spelling or add a 'returns' name to the referenced operation.",
            )
        existing_deps = set(op.get("dependencies", []))
        op["dependencies"] = list(existing_deps | (detected_deps & returns_set))

    # Validate @ref.field — check referenced fields exist on the source table
    returns_table_map = {op["returns"]: op["table"] for op in operations if op.get("returns")}
    ref_field_pattern = re.compile(r"@([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)")
    for i, op in enumerate(operations):
        def _scan_ref_fields(obj: Any) -> list[tuple[str, str]]:
            """Extract all (alias, field) pairs from @alias.field refs."""
            pairs = []
            if isinstance(obj, str):
                pairs.extend(ref_field_pattern.findall(obj))
            elif isinstance(obj, dict):
                for v in obj.values():
                    pairs.extend(_scan_ref_fields(v))
            elif isinstance(obj, list):
                for v in obj:
                    pairs.extend(_scan_ref_fields(v))
            return pairs

        ref_pairs = _scan_ref_fields(op.get("data"))
        ref_pairs.extend(_scan_ref_fields(op.get("filters")))
        ref_pairs.extend(_scan_ref_fields(op.get("updates")))
        for alias, field in ref_pairs:
            if alias in returns_table_map:
                ref_table = returns_table_map[alias]
                table_schema = get_table_schema(ref_table)
                if table_schema:
                    cols = table_schema.get("columns", {}) if isinstance(table_schema, dict) else {}
                    if isinstance(cols, dict):
                        valid_cols = set(cols.keys())
                    elif isinstance(cols, list):
                        valid_cols = {c["name"] for c in cols if isinstance(c, dict)}
                    else:
                        valid_cols = set()
                    if valid_cols and field not in valid_cols:
                        error_exit(
                            f"Operation {i} ({op.get('action','')} on {op.get('table','')}): @{alias}.{field} — field '{field}' does not exist on table '{ref_table}'.",
                            hint=f"Valid columns on '{ref_table}': {sorted(valid_cols)}",
                        )

    # Check for duplicate returns names
    returns_list = [op["returns"] for op in operations if op.get("returns")]
    if len(returns_list) != len(set(returns_list)):
        error_exit("Duplicate 'returns' names in operations.")

    # Check circular dependencies
    sorted_ops = _topo_sort(operations)

    # Enrich data: auto-generate UUIDs, timestamps
    for op in sorted_ops:
        _enrich_operation(op)

    # Normalize numeric types
    for op in sorted_ops:
        if op.get("data"):
            op["data"] = normalize_numeric(op["data"])
        if op.get("updates"):
            op["updates"] = normalize_numeric(op["updates"])

    # Validate required fields for create/upsert operations
    for i, op in enumerate(sorted_ops):
        if op["action"] in ("create", "upsert"):
            _validate_required_fields(i, op)

    # Dry run — just preview
    if dry_run:
        output({
            "success": True,
            "dry_run": True,
            "goal": intent.get("goal", ""),
            "operations_count": len(sorted_ops),
            "impact": intent.get("impact", {}),
            "operations_preview": [
                {"action": op["action"], "table": op["table"], "returns": op.get("returns")}
                for op in sorted_ops
            ],
        })

    # Build RPC payload (strip client-only fields)
    rpc_ops = []
    for op in sorted_ops:
        rpc_op: dict[str, Any] = {
            "action": op["action"],
            "table": op["table"],
        }
        for key in ("data", "filters", "updates", "returns", "on_conflict", "conflict_fields", "soft_delete"):
            if op.get(key) is not None:
                rpc_op[key] = op[key]
        rpc_ops.append(rpc_op)

    client = get_client()

    try:
        response = client.rpc(
            "execute_write_intent",
            {"p_operations": rpc_ops, "p_context": {}},
        ).execute()
    except Exception as e:
        error_exit(
            f"Write failed: {_categorize_error(str(e))}",
            hint="Check data against schema. Use 'inspect <table>' to see requirements.",
        )

    result = response.data
    if result is None:
        error_exit("RPC returned null result.")

    if result.get("success"):
        # Parse results into summary
        created, updated, deleted = {}, {}, {}
        for r in result.get("results", []):
            t = r.get("table", "")
            a = r.get("action", "")
            c = r.get("count", 0)
            if a in ("create", "upsert"):
                created[t] = created.get(t, 0) + c
            elif a == "update":
                updated[t] = updated.get(t, 0) + c
            elif a == "delete":
                deleted[t] = deleted.get(t, 0) + c

        output({
            "success": True,
            "goal": intent.get("goal", ""),
            "operations_executed": result.get("operations_executed", len(rpc_ops)),
            "created": created,
            "updated": updated,
            "deleted": deleted,
            "results": result.get("results", []),
        })
    else:
        error_exit(
            result.get("error", "Unknown RPC error"),
            hint="Transaction rolled back. Fix the error and retry.",
        )


def _detect_refs(op: dict[str, Any]) -> set[str]:
    """Scan operation data/filters/updates for @name.field references."""
    refs: set[str] = set()
    pattern = re.compile(r"@([A-Za-z_][A-Za-z0-9_]*)\.")

    def scan(obj: Any) -> None:
        if isinstance(obj, str):
            for m in pattern.finditer(obj):
                refs.add(m.group(1))
        elif isinstance(obj, dict):
            for v in obj.values():
                scan(v)
        elif isinstance(obj, list):
            for v in obj:
                scan(v)

    scan(op.get("data"))
    scan(op.get("filters"))
    scan(op.get("updates"))
    return refs


def _topo_sort(operations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Topological sort by dependencies (Kahn's algorithm)."""
    n = len(operations)
    returns_map: dict[str, int] = {}
    for i, op in enumerate(operations):
        if op.get("returns"):
            returns_map[op["returns"]] = i

    # Build adjacency: dep_idx -> [dependent_indices]
    graph: dict[int, list[int]] = {i: [] for i in range(n)}
    in_degree = [0] * n
    for i, op in enumerate(operations):
        for dep in op.get("dependencies", []):
            if dep in returns_map:
                dep_idx = returns_map[dep]
                graph[dep_idx].append(i)
                in_degree[i] += 1

    queue = [i for i in range(n) if in_degree[i] == 0]
    result_indices: list[int] = []
    while queue:
        node = queue.pop(0)
        result_indices.append(node)
        for neighbor in graph[node]:
            in_degree[neighbor] -= 1
            if in_degree[neighbor] == 0:
                queue.append(neighbor)

    if len(result_indices) != n:
        error_exit("Circular dependencies detected in operations.")

    return [operations[i] for i in result_indices]


def _enrich_operation(op: dict[str, Any]) -> None:
    """Auto-generate UUIDs for id fields, set created_at/updated_at."""
    table = op["table"]
    schema = get_table_schema(table)
    if not schema:
        return
    columns = schema.get("columns", {})
    now = datetime.now(timezone.utc).isoformat()

    def enrich_row(row: dict[str, Any]) -> None:
        # Auto-generate UUID for 'id' if column is uuid type and not provided
        if "id" in columns and columns["id"].get("type") == "uuid" and "id" not in row:
            row["id"] = str(uuid.uuid4())
        # Auto-set timestamps
        if "created_at" in columns and "created_at" not in row and op["action"] == "create":
            row["created_at"] = now
        if "updated_at" in columns and "updated_at" not in row:
            row["updated_at"] = now

    if op["action"] in ("create", "upsert") and op.get("data"):
        data = op["data"]
        if isinstance(data, list):
            for row in data:
                enrich_row(row)
        elif isinstance(data, dict):
            enrich_row(data)

    if op["action"] == "update" and op.get("updates"):
        if "updated_at" in columns and "updated_at" not in op["updates"]:
            op["updates"]["updated_at"] = now


def _validate_required_fields(op_index: int, op: dict[str, Any]) -> None:
    """Check that required fields (without defaults) are provided in create/upsert data."""
    table = op["table"]
    schema = get_table_schema(table)
    if not schema:
        return
    columns = schema.get("columns", {})

    # Find required columns that have no default and aren't auto-enriched
    auto_fields = {"id", "created_at", "updated_at"}
    required_no_default = []
    for col_name, col_info in columns.items():
        is_required = col_info.get("required") or not col_info.get("nullable", True)
        has_default = bool(col_info.get("default"))
        if is_required and not has_default and col_name not in auto_fields:
            required_no_default.append(col_name)

    if not required_no_default:
        return

    data = op.get("data")
    if not data:
        return

    rows = data if isinstance(data, list) else [data]
    for row_idx, row in enumerate(rows):
        # Skip @ref values — they'll be resolved at execution time
        provided = set(row.keys())
        missing = [c for c in required_no_default if c not in provided]
        if missing:
            loc = f"Operation {op_index}" + (f", row {row_idx}" if isinstance(data, list) else "")
            error_exit(
                f"{loc} ({op['action']} on {table}): missing required fields: {missing}",
                hint=f"These columns have no default. Add them to your data or use 'inspect {table}' to check.",
            )


def _categorize_error(error_msg: str) -> str:
    """Categorize error for actionable feedback."""
    lower = error_msg.lower()
    if "unique constraint" in lower or "already exists" in lower:
        return f"CONSTRAINT_VIOLATION: {error_msg} — Check for duplicates in unique fields."
    if "foreign key" in lower or "not found" in lower:
        return f"MISSING_REFERENCE: {error_msg} — Ensure parent entities exist."
    if "null value" in lower and "not-null" in lower:
        return f"REQUIRED_FIELD: {error_msg} — Check required fields via inspect."
    return error_msg


# ---------------------------------------------------------------------------
# SYNC-SCHEMA
# ---------------------------------------------------------------------------


def cmd_sync_schema(args: argparse.Namespace) -> None:
    """Synchronize schema.json with live database."""
    import subprocess
    
    script_path = Path(__file__).parent / "sync_schema.py"
    
    cmd_args = [sys.executable, str(script_path)]
    if args.compare_only:
        cmd_args.append("--compare-only")
    
    result = subprocess.run(cmd_args, env=os.environ)
    sys.exit(result.returncode)


# ---------------------------------------------------------------------------
# CLI setup
# ---------------------------------------------------------------------------


_VALID_COMMANDS = ("inspect", "read", "aggregate", "write", "sync-schema")


def _args_from_file(filepath: str) -> argparse.Namespace:
    """Build an argparse.Namespace from a JSON file.

    JSON format:
        {"command": "read", "table": "products", "filters": {"price": {"gt": 50}}, "limit": 5}

    JSON values that are dicts/lists are auto-serialized to JSON strings
    so the existing cmd_* functions receive the same string args as CLI mode.
    """
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        error_exit(f"File not found: '{filepath}'")
    except json.JSONDecodeError as e:
        error_exit(f"Invalid JSON in '{filepath}': {e}")

    if not isinstance(data, dict):
        error_exit("JSON file must contain an object, not a list or scalar")

    command = data.pop("command", None)
    if not command:
        error_exit("JSON file must include a 'command' field",
                   hint=f"Valid commands: {', '.join(_VALID_COMMANDS)}")
    if command not in _VALID_COMMANDS:
        error_exit(f"Unknown command: '{command}'",
                   hint=f"Valid commands: {', '.join(_VALID_COMMANDS)}")

    # Normalize: convert dict/list values to JSON strings (matching CLI behavior)
    for key, val in data.items():
        if isinstance(val, (dict, list)):
            data[key] = json.dumps(val)

    # Map JSON keys to argparse-style attribute names
    mapped: dict[str, Any] = {"command": command}
    key_map = {
        "group_by": "group_by", "group-by": "group_by",
        "dry_run": "dry_run", "dry-run": "dry_run",
        "count_only": "count_only", "count-only": "count_only",
        "compare_only": "compare_only", "compare-only": "compare_only",
    }
    for key, val in data.items():
        attr = key_map.get(key, key.replace("-", "_"))
        mapped[attr] = val

    # Set defaults for missing optional fields
    defaults = {
        "inspect": {"table": None, "detailed": False},
        "read": {"table": None, "filters": None, "search": None, "columns": None,
                 "relations": None, "limit": None, "offset": None, "order": None,
                 "count_only": False},
        "aggregate": {"table": None, "aggregates": None, "filters": None,
                      "search": None, "group_by": None, "having": None},
        "write": {"intent": None, "dry_run": False},
        "sync-schema": {"compare_only": False},
    }
    for key, default in defaults.get(command, {}).items():
        mapped.setdefault(key, default)

    return argparse.Namespace(**mapped)


def main() -> None:
    # --file mode: read all args from a JSON file, skip argparse entirely
    if len(sys.argv) >= 2 and sys.argv[1] == "--file":
        if len(sys.argv) < 3:
            error_exit("--file requires a path", hint="Usage: python db_tool.py --file query.json")
        args = _args_from_file(sys.argv[2])
    else:
        parser = argparse.ArgumentParser(
            description="OpenClaw Database Tool",
            formatter_class=argparse.RawDescriptionHelpFormatter,
        )
        sub = parser.add_subparsers(dest="command")

        # inspect
        p_inspect = sub.add_parser("inspect", help="Inspect schema")
        p_inspect.add_argument("table", nargs="?", default=None)
        p_inspect.add_argument("--detailed", action="store_true")

        # read
        p_read = sub.add_parser("read", help="Read data")
        p_read.add_argument("table")
        p_read.add_argument("--filters", default=None)
        p_read.add_argument("--search", default=None)
        p_read.add_argument("--columns", default=None)
        p_read.add_argument("--relations", default=None)
        p_read.add_argument("--limit", type=int, default=None)
        p_read.add_argument("--offset", type=int, default=None)
        p_read.add_argument("--order", default=None, help="Order by: 'col.desc' or 'col.asc' (comma-separated)")
        p_read.add_argument("--count-only", action="store_true")

        # aggregate
        p_agg = sub.add_parser("aggregate", help="Aggregate data")
        p_agg.add_argument("table")
        p_agg.add_argument("--aggregates", default=None)
        p_agg.add_argument("--filters", default=None)
        p_agg.add_argument("--search", default=None)
        p_agg.add_argument("--group-by", default=None)
        p_agg.add_argument("--having", default=None)

        # write
        p_write = sub.add_parser("write", help="Write data (WriteIntent)")
        p_write.add_argument("--intent", required=True)
        p_write.add_argument("--dry-run", action="store_true")

        # sync-schema
        p_sync = sub.add_parser("sync-schema", help="Synchronize schema.json with live database")
        p_sync.add_argument("--compare-only", action="store_true", help="Only compare, don't update files")

        args = parser.parse_args()
        if not args.command:
            parser.print_help()
            sys.exit(1)

    commands = {
        "inspect": cmd_inspect, 
        "read": cmd_read, 
        "aggregate": cmd_aggregate, 
        "write": cmd_write,
        "sync-schema": cmd_sync_schema
    }
    commands[args.command](args)


if __name__ == "__main__":
    main()
