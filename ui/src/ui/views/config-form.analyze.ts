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

  if (schema.allOf) {
    const composition = normalizeAllOf(schema, path);
    if (composition) {
      return composition;
    }
    return { schema, unsupportedPaths: [pathLabel] };
  }

  if (schema.anyOf || schema.oneOf) {
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
      // Treat `true` as an untyped map schema so dynamic object keys can still be edited.
      normalized.additionalProperties = {};
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

function isSecretRefVariant(entry: JsonSchema): boolean {
  if (schemaType(entry) !== "object") {
    return false;
  }
  const source = entry.properties?.source;
  const provider = entry.properties?.provider;
  const id = entry.properties?.id;
  if (!source || !provider || !id) {
    return false;
  }
  return (
    typeof source.const === "string" &&
    schemaType(provider) === "string" &&
    schemaType(id) === "string"
  );
}

function isSecretRefUnion(entry: JsonSchema): boolean {
  const variants = entry.oneOf ?? entry.anyOf;
  if (!variants || variants.length === 0) {
    return false;
  }
  return variants.every((variant) => isSecretRefVariant(variant));
}

function normalizeSecretInputUnion(
  schema: JsonSchema,
  path: Array<string | number>,
  remaining: JsonSchema[],
  nullable: boolean,
): ConfigSchemaAnalysis | null {
  const stringIndex = remaining.findIndex((entry) => schemaType(entry) === "string");
  if (stringIndex < 0) {
    return null;
  }
  const nonString = remaining.filter((_, index) => index !== stringIndex);
  if (nonString.length !== 1 || !isSecretRefUnion(nonString[0])) {
    return null;
  }
  return normalizeSchemaNode(
    {
      ...schema,
      ...remaining[stringIndex],
      nullable,
      anyOf: undefined,
      oneOf: undefined,
      allOf: undefined,
    },
    path,
  );
}

function normalizeUnion(
  schema: JsonSchema,
  path: Array<string | number>,
): ConfigSchemaAnalysis | null {
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

  // Config secrets accept either a raw key string or a structured secret ref object.
  // The form only supports editing the string path for now.
  const secretInput = normalizeSecretInputUnion(schema, path, remaining, nullable);
  if (secretInput) {
    return secretInput;
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

  if (remaining.length === 1) {
    const res = normalizeSchemaNode(remaining[0], path);
    if (res.schema) {
      res.schema.nullable = nullable || res.schema.nullable;
    }
    return res;
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

  const objectUnion = normalizeObjectComposition(schema, path, remaining, nullable);
  if (objectUnion) {
    return objectUnion;
  }

  return null;
}

function normalizeAllOf(
  schema: JsonSchema,
  path: Array<string | number>,
): ConfigSchemaAnalysis | null {
  const entries = schema.allOf;
  if (!entries || entries.length === 0) {
    return null;
  }
  return normalizeObjectComposition(schema, path, entries, Boolean(schema.nullable));
}

function normalizeObjectComposition(
  schema: JsonSchema,
  path: Array<string | number>,
  entries: JsonSchema[],
  nullable: boolean,
): ConfigSchemaAnalysis | null {
  if (entries.length === 0) {
    return null;
  }

  const pathLabel = pathKey(path) || "<root>";
  const unsupported = new Set<string>();
  const normalized: JsonSchema = {
    ...schema,
    type: "object",
    properties: {},
    anyOf: undefined,
    oneOf: undefined,
    allOf: undefined,
    nullable,
  };

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      return null;
    }

    const res = normalizeSchemaNode(entry, path);
    if (!res.schema || schemaType(res.schema) !== "object") {
      return null;
    }
    if (res.unsupportedPaths.includes(pathLabel)) {
      return null;
    }

    normalized.nullable = Boolean(normalized.nullable || res.schema.nullable);

    for (const issue of res.unsupportedPaths) {
      unsupported.add(issue);
    }

    for (const [key, value] of Object.entries(res.schema.properties ?? {})) {
      const existing = normalized.properties?.[key];
      if (!existing) {
        normalized.properties = {
          ...(normalized.properties ?? {}),
          [key]: value,
        };
        continue;
      }

      const mergedProperty = mergeObjectMember(existing, value, [...path, key]);
      if (!mergedProperty) {
        return null;
      }

      normalized.properties = {
        ...(normalized.properties ?? {}),
        [key]: mergedProperty.schema,
      };
      for (const issue of mergedProperty.unsupportedPaths) {
        unsupported.add(issue);
      }
    }

    const mergedAdditional = mergeAdditionalProperties(
      normalized.additionalProperties,
      res.schema.additionalProperties,
      [...path, "*"],
    );
    if (mergedAdditional === null) {
      return null;
    }
    if (mergedAdditional !== undefined) {
      normalized.additionalProperties = mergedAdditional;
    }
  }

  return {
    schema: normalized,
    unsupportedPaths: Array.from(unsupported),
  };
}

function mergeObjectMember(
  left: JsonSchema,
  right: JsonSchema,
  path: Array<string | number>,
): ConfigSchemaAnalysis | null {
  if (JSON.stringify(left) === JSON.stringify(right)) {
    return {
      schema: {
        ...left,
        nullable: Boolean(left.nullable || right.nullable),
      },
      unsupportedPaths: [],
    };
  }

  if (schemaType(left) === "object" && schemaType(right) === "object") {
    return normalizeObjectComposition({ type: "object" }, path, [left, right], false);
  }

  return null;
}

function mergeAdditionalProperties(
  left: JsonSchema | boolean | undefined,
  right: JsonSchema | boolean | undefined,
  path: Array<string | number>,
): JsonSchema | boolean | undefined | null {
  if (right === undefined) {
    return left;
  }
  if (left === undefined) {
    return right;
  }
  if (left === right) {
    return left;
  }

  const normalizedLeft = left === true ? {} : left;
  const normalizedRight = right === true ? {} : right;

  if (left === false || right === false) {
    return normalizedLeft === normalizedRight ? left : null;
  }

  if (isAnySchema(normalizedLeft) || isAnySchema(normalizedRight)) {
    return isAnySchema(normalizedLeft) ? normalizedRight : normalizedLeft;
  }

  if (JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight)) {
    return normalizedLeft;
  }

  const merged = mergeObjectMember(normalizedLeft, normalizedRight, path);
  return merged?.schema ?? null;
}
