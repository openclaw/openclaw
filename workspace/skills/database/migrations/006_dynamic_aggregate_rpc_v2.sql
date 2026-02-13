-- Migration: 006_dynamic_aggregate_rpc_v2
-- Description: Fix HAVING clause to use aggregate expressions instead of aliases
-- Date: 2026-02-13
-- Fix: Postgres doesn't allow SELECT aliases in HAVING. Resolve aliases to expressions.

CREATE OR REPLACE FUNCTION dynamic_aggregate(
    p_table TEXT,
    p_aggregates JSONB,  -- {"alias": "function(column)"}
    p_filters JSONB DEFAULT '{}',
    p_group_by TEXT[] DEFAULT NULL,
    p_having JSONB DEFAULT NULL,
    p_limit INT DEFAULT 1000
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_sql TEXT;
    v_select_parts TEXT[];
    v_where_parts TEXT[];
    v_having_parts TEXT[];
    v_key TEXT;
    v_value JSONB;
    v_aggregate TEXT;
    v_agg_expr TEXT;
    v_result JSONB;
BEGIN
    -- Whitelist allowed tables for security
    IF p_table NOT IN (
        'products', 'product_families', 'product_prices', 'price_lists',
        'categories', 'variant_axes', 'variant_values', 'product_variants',
        'campaigns', 'campaign_assets', 'content_library', 'customer_segments',
        'industries', 'product_family_industries', 'company_intelligence',
        'uom', 'uom_conversion', 'bom', 'bom_lines', 'batches',
        'inventory', 'inventory_transactions', 'suppliers', 'supplier_products',
        'product_images', 'product_assets', 'assets', 'locations',
        'marketing_content', 'customer_prices'
    ) THEN
        RAISE EXCEPTION 'Access denied to table: %', p_table;
    END IF;

    -- Build SELECT parts from aggregates
    v_select_parts := ARRAY[]::TEXT[];

    -- Add group by columns first
    IF p_group_by IS NOT NULL THEN
        FOREACH v_key IN ARRAY p_group_by LOOP
            v_select_parts := array_append(v_select_parts, quote_ident(v_key));
        END LOOP;
    END IF;

    -- Add aggregate expressions
    FOR v_key, v_value IN SELECT * FROM jsonb_each(p_aggregates) LOOP
        v_aggregate := v_value #>> '{}';
        -- Validate aggregate function (security)
        IF v_aggregate ~* '^(count|sum|avg|min|max)\s*\(' THEN
            v_select_parts := array_append(v_select_parts, v_aggregate || ' AS ' || quote_ident(v_key));
        ELSE
            RAISE EXCEPTION 'Invalid aggregate function: %', v_aggregate;
        END IF;
    END LOOP;

    -- Build WHERE parts from filters
    v_where_parts := ARRAY[]::TEXT[];
    FOR v_key, v_value IN SELECT * FROM jsonb_each(p_filters) LOOP
        -- Handle ILIKE patterns (prefixed with __ilike__)
        IF v_key LIKE '__ilike__%' THEN
            v_where_parts := array_append(v_where_parts,
                quote_ident(substring(v_key from 10)) || ' ILIKE ' || quote_literal(v_value #>> '{}'));
        ELSIF jsonb_typeof(v_value) = 'array' THEN
            v_where_parts := array_append(v_where_parts,
                quote_ident(v_key) || ' = ANY(SELECT jsonb_array_elements_text(' || quote_literal(v_value::text) || '::jsonb))');
        ELSIF jsonb_typeof(v_value) = 'boolean' THEN
            v_where_parts := array_append(v_where_parts,
                quote_ident(v_key) || ' = ' || (v_value #>> '{}')::TEXT);
        ELSIF jsonb_typeof(v_value) = 'null' THEN
            v_where_parts := array_append(v_where_parts,
                quote_ident(v_key) || ' IS NULL');
        ELSE
            v_where_parts := array_append(v_where_parts,
                quote_ident(v_key) || ' = ' || quote_literal(v_value #>> '{}'));
        END IF;
    END LOOP;

    -- Build HAVING parts (if provided)
    -- FIX: Resolve aliases to their aggregate expressions since Postgres
    -- doesn't allow SELECT aliases in HAVING clauses
    v_having_parts := ARRAY[]::TEXT[];
    IF p_having IS NOT NULL THEN
        FOR v_key, v_value IN SELECT * FROM jsonb_each(p_having) LOOP
            -- Resolve alias to aggregate expression
            v_agg_expr := p_aggregates ->> v_key;
            IF v_agg_expr IS NULL THEN
                RAISE EXCEPTION 'HAVING references unknown alias: %. Available: %', v_key, (SELECT string_agg(k, ', ') FROM jsonb_object_keys(p_aggregates) AS k);
            END IF;

            -- v_value is like {"gt": 10} or {"gte": 5, "lte": 100}
            IF v_value ? 'gt' THEN
                v_having_parts := array_append(v_having_parts, v_agg_expr || ' > ' || (v_value->>'gt'));
            END IF;
            IF v_value ? 'gte' THEN
                v_having_parts := array_append(v_having_parts, v_agg_expr || ' >= ' || (v_value->>'gte'));
            END IF;
            IF v_value ? 'lt' THEN
                v_having_parts := array_append(v_having_parts, v_agg_expr || ' < ' || (v_value->>'lt'));
            END IF;
            IF v_value ? 'lte' THEN
                v_having_parts := array_append(v_having_parts, v_agg_expr || ' <= ' || (v_value->>'lte'));
            END IF;
            IF v_value ? 'eq' THEN
                v_having_parts := array_append(v_having_parts, v_agg_expr || ' = ' || (v_value->>'eq'));
            END IF;
            IF v_value ? 'neq' THEN
                v_having_parts := array_append(v_having_parts, v_agg_expr || ' != ' || (v_value->>'neq'));
            END IF;
        END LOOP;
    END IF;

    -- Build final SQL
    v_sql := 'SELECT jsonb_agg(row_to_json(t)) FROM (SELECT ' || array_to_string(v_select_parts, ', ') ||
             ' FROM ' || quote_ident(p_table);

    IF array_length(v_where_parts, 1) > 0 THEN
        v_sql := v_sql || ' WHERE ' || array_to_string(v_where_parts, ' AND ');
    END IF;

    IF p_group_by IS NOT NULL AND array_length(p_group_by, 1) > 0 THEN
        v_sql := v_sql || ' GROUP BY ' || array_to_string(p_group_by, ', ');
    END IF;

    IF array_length(v_having_parts, 1) > 0 THEN
        v_sql := v_sql || ' HAVING ' || array_to_string(v_having_parts, ' AND ');
    END IF;

    v_sql := v_sql || ' LIMIT ' || p_limit || ') t';

    -- Execute and return
    EXECUTE v_sql INTO v_result;

    RETURN COALESCE(v_result, '[]'::JSONB);
END;
$$;

GRANT EXECUTE ON FUNCTION dynamic_aggregate TO authenticated, anon;
