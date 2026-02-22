import { pathKey, schemaType, type JsonSchema } from "./config-form.shared.ts";

export type ConfigSchemaAnalysis = {
  schema: JsonSchema | null;
  unsupportedPaths: string[];
};

const META_KEYS = new Set(["title", "description", "default", "nullable"]);

function isAnySchema(schema: JsonSchema): boolean {
  const keys = Object.keys(schema ?? {}).filter((key) => !META_KEYS.has(key));
  return keys.length === 0;
}

function normalizeEnum(values: unknown[]): { enumValues: unknown[]; nullable: boolean } {
  const filtered = values.filter((value) => value != null);
  const nullable = filtered.length !== values.length;
  const enumValues: unknown[] = [];
  for (const value of filtered) {
    if (!enumValues.some((existing) => Object.is(existing, value))) {
      enumValues.push(value);
    }
  }
  return { enumValues, nullable };
}

export function analyzeConfigSchema(raw: unknown): ConfigSchemaAnalysis {
  if (!raw || typeof raw !== "object") {
    return { schema: null, unsupportedPaths: ["<root>"] };
  }
  return normalizeSchemaNode(raw as JsonSchema, []);
}

function normalizeSchemaNode(
  schema: JsonSchema,
  path: Array<string | number>,
): ConfigSchemaAnalysis {
  const unsupported = new Set<string>();
  const normalized: JsonSchema = { ...schema };
  const pathLabel = pathKey(path) || "<root>";

  if (schema.anyOf || schema.oneOf || schema.allOf) {
    const union = normalizeUnion(schema, path);
    if (union) {
      return union;
    }
    return { schema, unsupportedPaths: [pathLabel] };
  }

  const nullable = Array.isArray(schema.type) && schema.type.includes("null");
  const type =
    schemaType(schema) ?? (schema.properties || schema.additionalProperties ? "object" : undefined);
  normalized.type = type ?? schema.type;
  normalized.nullable = nullable || schema.nullable;

  if (normalized.enum) {
    const { enumValues, nullable: enumNullable } = normalizeEnum(normalized.enum);
    normalized.enum = enumValues;
    if (enumNullable) {
      normalized.nullable = true;
    }
    if (enumValues.length === 0) {
      unsupported.add(pathLabel);
    }
  }

  if (type === "object") {
    const properties = schema.properties ?? {};
    const normalizedProps: Record<string, JsonSchema> = {};
    for (const [key, value] of Object.entries(properties)) {
      const res = normalizeSchemaNode(value, [...path, key]);
      if (res.schema) {
        normalizedProps[key] = res.schema;
      }
      for (const entry of res.unsupportedPaths) {
        unsupported.add(entry);
      }
    }
    normalized.properties = normalizedProps;

    if (schema.additionalProperties === true) {
      unsupported.add(pathLabel);
    } else if (schema.additionalProperties === false) {
      normalized.additionalProperties = false;
    } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      if (!isAnySchema(schema.additionalProperties)) {
        const res = normalizeSchemaNode(schema.additionalProperties, [...path, "*"]);
        normalized.additionalProperties = res.schema ?? schema.additionalProperties;
        if (res.unsupportedPaths.length > 0) {
          unsupported.add(pathLabel);
        }
      }
    }
  } else if (type === "array") {
    const itemsSchema = Array.isArray(schema.items) ? schema.items[0] : schema.items;
    if (!itemsSchema) {
      unsupported.add(pathLabel);
    } else {
      const res = normalizeSchemaNode(itemsSchema, [...path, "*"]);
      normalized.items = res.schema ?? itemsSchema;
      if (res.unsupportedPaths.length > 0) {
        unsupported.add(pathLabel);
      }
    }
  } else if (
    type !== "string" &&
    type !== "number" &&
    type !== "integer" &&
    type !== "boolean" &&
    !normalized.enum
  ) {
    unsupported.add(pathLabel);
  }

  return {
    schema: normalized,
    unsupportedPaths: Array.from(unsupported),
  };
}

function mergeAllOf(schema: JsonSchema, path: Array<string | number>): ConfigSchemaAnalysis | null {
  const branches = schema.allOf;
  if (!branches || branches.length === 0) {
    return null;
  }
  const merged: JsonSchema = { ...schema, allOf: undefined };
  for (const branch of branches) {
    if (!branch || typeof branch !== "object") {
      return null;
    }
    if (branch.type) {
      merged.type = merged.type ?? branch.type;
    }
    if (branch.properties) {
      merged.properties = { ...merged.properties, ...branch.properties };
    }
    if (branch.items && !merged.items) {
      merged.items = branch.items;
    }
    if (branch.enum) {
      merged.enum = branch.enum;
    }
    if (branch.description && !merged.description) {
      merged.description = branch.description;
    }
    if (branch.title && !merged.title) {
      merged.title = branch.title;
    }
    if (branch.default !== undefined && merged.default === undefined) {
      merged.default = branch.default;
    }
  }
  return normalizeSchemaNode(merged, path);
}

function normalizeUnion(
  schema: JsonSchema,
  path: Array<string | number>,
): ConfigSchemaAnalysis | null {
  if (schema.allOf) {
    return mergeAllOf(schema, path);
  }
  const union = schema.anyOf ?? schema.oneOf;
  if (!union) {
    return null;
  }

  const literals: unknown[] = [];
  const remaining: JsonSchema[] = [];
  let nullable = false;

  for (const entry of union) {
    if (!entry || typeof entry !== "object") {
      return null;
    }
    if (Array.isArray(entry.enum)) {
      const { enumValues, nullable: enumNullable } = normalizeEnum(entry.enum);
      literals.push(...enumValues);
      if (enumNullable) {
        nullable = true;
      }
      continue;
    }
    if ("const" in entry) {
      if (entry.const == null) {
        nullable = true;
        continue;
      }
      literals.push(entry.const);
      continue;
    }
    if (schemaType(entry) === "null") {
      nullable = true;
      continue;
    }
    remaining.push(entry);
  }

  if (literals.length > 0 && remaining.length === 0) {
    const unique: unknown[] = [];
    for (const value of literals) {
      if (!unique.some((existing) => Object.is(existing, value))) {
        unique.push(value);
      }
    }
    return {
      schema: {
        ...schema,
        enum: unique,
        nullable,
        anyOf: undefined,
        oneOf: undefined,
        allOf: undefined,
      },
      unsupportedPaths: [],
    };
  }

  if (remaining.length === 1 && literals.length === 0) {
    const res = normalizeSchemaNode(remaining[0], path);
    if (res.schema) {
      res.schema.nullable = nullable || res.schema.nullable;
    }
    return res;
  }

  // Literals + single typed remainder (e.g. boolean | enum["off","partial"]):
  // merge literals into an enum on the combined schema so segmented/select renders all options.
  if (remaining.length === 1 && literals.length > 0) {
    const remType = schemaType(remaining[0]);
    if (remType === "boolean") {
      const all = [true, false, ...literals];
      const unique: unknown[] = [];
      for (const v of all) {
        if (!unique.some((e) => Object.is(e, v))) {
          unique.push(v);
        }
      }
      return {
        schema: {
          ...schema,
          enum: unique,
          nullable,
          anyOf: undefined,
          oneOf: undefined,
          allOf: undefined,
        },
        unsupportedPaths: [],
      };
    }
    // Single remaining primitive — pass through as-is so the renderer picks the right widget
    const primitiveTypes = new Set(["string", "number", "integer"]);
    if (remType && primitiveTypes.has(remType)) {
      const res = normalizeSchemaNode(remaining[0], path);
      if (res.schema) {
        res.schema.nullable = nullable || res.schema.nullable;
      }
      return res;
    }
  }

  const primitiveTypes = new Set(["string", "number", "integer", "boolean"]);
  if (
    remaining.length > 0 &&
    literals.length === 0 &&
    remaining.every((entry) => entry.type && primitiveTypes.has(String(entry.type)))
  ) {
    return {
      schema: {
        ...schema,
        nullable,
      },
      unsupportedPaths: [],
    };
  }

  // Fallback: pass the schema through and let the renderer show a JSON textarea
  return {
    schema: { ...schema, nullable },
    unsupportedPaths: [],
  };
}
