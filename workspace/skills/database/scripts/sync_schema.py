#!/usr/bin/env python3
"""Sync schema.json from live Supabase OpenAPI spec.

Usage:
    python sync_schema.py                  # Update schema.json from live DB
    python sync_schema.py --compare-only   # Show drift without updating
"""

import json, os, sys, urllib.request, shutil
from datetime import datetime, timezone

SCHEMA_PATH = os.path.join(os.path.dirname(__file__), "..", "references", "schema.json")

# Auto-load .env from workspace root
_env_path = os.path.join(os.path.dirname(__file__), "..", "..", "..", ".env")
if os.path.exists(_env_path):
    with open(_env_path) as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _v = _line.split("=", 1)
                os.environ.setdefault(_k.strip(), _v.strip())

def fetch_openapi_spec():
    """Fetch the PostgREST OpenAPI spec from Supabase."""
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_KEY")
    if not url or not key:
        print(json.dumps({"success": False, "error": "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"}))
        sys.exit(1)

    req = urllib.request.Request(
        f"{url}/rest/v1/",
        headers={"apikey": key, "Authorization": f"Bearer {key}"}
    )
    resp = urllib.request.urlopen(req)
    return json.loads(resp.read())


def openapi_to_schema(spec):
    """Convert OpenAPI spec definitions to our schema.json format."""
    definitions = spec.get("definitions", {})
    paths = spec.get("paths", {})
    
    # Get table names from paths (excludes views/rpc)
    table_names = set()
    for path in paths:
        name = path.strip("/")
        if name and not name.startswith("rpc/"):
            table_names.add(name)

    schema = {"tables": {}, "version": "live", "synced_at": datetime.now(timezone.utc).isoformat()}

    for table_name in sorted(table_names):
        defn = definitions.get(table_name, {})
        props = defn.get("properties", {})
        required = set(defn.get("required", []))

        columns = {}
        for col_name, col_spec in props.items():
            col = {
                "type": _map_type(col_spec),
                "required": col_name in required,
            }
            
            desc = col_spec.get("description", "")
            
            # Parse description for metadata
            if "Primary Key" in desc or "primary key" in desc:
                col["pk"] = True
            
            if "default" in col_spec:
                col["default"] = str(col_spec["default"])
            elif "Note:" in desc:
                # PostgREST puts defaults in description like "Note:\nThis is a Primary Key.<pk/>\nDefault Value: now()"
                for line in desc.split("\n"):
                    if line.startswith("Default Value:"):
                        col["default"] = line.split(":", 1)[1].strip()
            
            # Extract FK info from description
            if "Foreign Key" in desc:
                for line in desc.split("\n"):
                    if "fk" in line.lower() or "foreign" in line.lower():
                        # Parse: "This is a Foreign Key to `categories.id`.<fk table='categories' column='id'/>"
                        if "table='" in line:
                            fk_table = line.split("table='")[1].split("'")[0]
                            fk_col = line.split("column='")[1].split("'")[0] if "column='" in line else "id"
                            col["fk"] = f"{fk_table}.{fk_col}"
            
            # Extract enum values from format or description
            if "enum" in col_spec:
                col["enum"] = col_spec["enum"]
            
            # Clean description — skip PostgREST boilerplate
            clean_desc = desc.split("\n")[0].strip() if desc else ""
            if clean_desc and clean_desc != "Note:" and "Primary Key" not in clean_desc and "Foreign Key" not in clean_desc:
                col["description"] = clean_desc
            
            columns[col_name] = col

        schema["tables"][table_name] = {
            "columns": columns,
            "description": defn.get("description", "")
        }

    return schema


def _map_type(col_spec):
    """Map OpenAPI type to our simplified type."""
    fmt = col_spec.get("format", "")
    typ = col_spec.get("type", "")
    desc = col_spec.get("description", "")
    
    if fmt == "uuid":
        return "uuid"
    if fmt == "timestamp with time zone" or "timestamptz" in fmt:
        return "timestamptz"
    if fmt == "timestamp without time zone":
        return "timestamp"
    if fmt == "date":
        return "date"
    if fmt in ("bigint", "integer", "smallint") or typ == "integer":
        return fmt or "integer"
    if fmt in ("numeric", "double precision", "real") or typ == "number":
        return fmt or "numeric"
    if fmt == "boolean" or typ == "boolean":
        return "boolean"
    if fmt == "jsonb" or fmt == "json":
        return fmt
    if fmt == "ARRAY" or "items" in col_spec:
        return "array"
    if fmt == "text":
        return "text"
    if "character varying" in fmt or fmt == "varchar":
        return "varchar"
    if typ == "string":
        return fmt if fmt else "text"
    return fmt or typ or "unknown"


def compare_schemas(old, new):
    """Compare two schemas and return differences."""
    diffs = []
    old_tables = set(old.get("tables", {}).keys())
    new_tables = set(new.get("tables", {}).keys())

    for t in sorted(new_tables - old_tables):
        diffs.append(f"  + NEW TABLE: {t} ({len(new['tables'][t]['columns'])} columns)")

    for t in sorted(old_tables - new_tables):
        diffs.append(f"  - REMOVED TABLE: {t}")

    for t in sorted(old_tables & new_tables):
        old_cols = set(old["tables"][t]["columns"].keys())
        new_cols = set(new["tables"][t]["columns"].keys())
        
        for c in sorted(new_cols - old_cols):
            col_type = new["tables"][t]["columns"][c].get("type", "?")
            diffs.append(f"  + {t}.{c} ({col_type})")
        
        for c in sorted(old_cols - new_cols):
            diffs.append(f"  - {t}.{c}")
        
        for c in sorted(old_cols & new_cols):
            old_type = old["tables"][t]["columns"][c].get("type", "")
            new_type = new["tables"][t]["columns"][c].get("type", "")
            if old_type != new_type:
                diffs.append(f"  ~ {t}.{c}: {old_type} → {new_type}")

    return diffs


def main():
    compare_only = "--compare-only" in sys.argv

    # Fetch live schema
    print("Fetching live schema from Supabase OpenAPI spec...", file=sys.stderr)
    spec = fetch_openapi_spec()
    live_schema = openapi_to_schema(spec)
    print(f"Live schema: {len(live_schema['tables'])} tables", file=sys.stderr)

    # Load existing
    old_schema = {}
    if os.path.exists(SCHEMA_PATH):
        with open(SCHEMA_PATH) as f:
            old_schema = json.load(f)
        print(f"Static schema: {len(old_schema.get('tables', {}))} tables", file=sys.stderr)

    # Compare
    diffs = compare_schemas(old_schema, live_schema)

    if not diffs:
        print(json.dumps({"success": True, "message": "Schemas are in sync", "tables": len(live_schema["tables"])}))
        return

    print(f"\nFound {len(diffs)} differences:", file=sys.stderr)
    for d in diffs:
        print(d, file=sys.stderr)

    if compare_only:
        print(json.dumps({
            "success": True,
            "message": f"Found {len(diffs)} differences (compare-only mode)",
            "differences": diffs,
            "tables": len(live_schema["tables"])
        }))
        return

    # Backup and write
    if os.path.exists(SCHEMA_PATH):
        backup = SCHEMA_PATH + ".backup"
        shutil.copy2(SCHEMA_PATH, backup)
        print(f"Backed up to {backup}", file=sys.stderr)

    with open(SCHEMA_PATH, "w") as f:
        json.dump(live_schema, f, indent=2)

    print(json.dumps({
        "success": True,
        "message": f"Schema updated. {len(diffs)} differences resolved.",
        "differences": diffs,
        "tables": len(live_schema["tables"])
    }))


if __name__ == "__main__":
    main()
