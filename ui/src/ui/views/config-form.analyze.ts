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

  if (isAnySchema(schema)) {
    return {
      schema: {
        ...schema,
        type: "string",
      },
      unsupportedPaths: [],
    };
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
  if (schema.allOf) {
    return null;
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

  // Config secrets accept either a raw key string or a structured secret ref object.
  // The form only supports editing the string path for now.
  const secretInput = normalizeSecretInputUnion(schema, path, remaining, nullable);
  if (secretInput) {
    return secretInput;
  }

  const primitiveTypes = new Set(["string", "number", "integer", "boolean"]);
  const primitiveEntries = remaining.filter((entry) => {
    const type = schemaType(entry);
    return type ? primitiveTypes.has(type) : false;
  });
  if (primitiveEntries.length > 0 && primitiveEntries.length < remaining.length) {
    if (primitiveEntries.length === 1) {
      return normalizeSchemaNode(
        {
          ...schema,
          ...primitiveEntries[0],
          nullable,
          anyOf: undefined,
          oneOf: undefined,
          allOf: undefined,
        },
        path,
      );
    }
    return {
      schema: {
        ...schema,
        anyOf: primitiveEntries,
        oneOf: undefined,
        allOf: undefined,
        nullable,
      },
      unsupportedPaths: [],
    };
  }

  const discriminatedObjectUnion = normalizeDiscriminatedObjectUnion(
    schema,
    path,
    remaining,
    nullable,
  );
  if (discriminatedObjectUnion) {
    return discriminatedObjectUnion;
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

  return null;
}

function normalizeDiscriminatedObjectUnion(
  schema: JsonSchema,
  path: Array<string | number>,
  remaining: JsonSchema[],
  nullable: boolean,
): ConfigSchemaAnalysis | null {
  if (remaining.length < 2 || remaining.some((entry) => schemaType(entry) !== "object")) {
    return null;
  }

  const variantProps = remaining.map((entry) => entry.properties ?? {});
  const discriminators = Object.keys(variantProps[0] ?? {}).filter((key) =>
    variantProps.every((props) => typeof props[key]?.const === "string"),
  );
  const discriminator = discriminators[0];
  if (!discriminator) {
    return null;
  }

  const discriminatorValues = variantProps.map((props) => props[discriminator]?.const);
  if (discriminatorValues.some((value): value is undefined => typeof value !== "string")) {
    return null;
  }

  const mergedProperties: Record<string, JsonSchema> = {
    [discriminator]: {
      type: "string",
      enum: Array.from(new Set(discriminatorValues)),
    },
  };

  for (const props of variantProps) {
    for (const [key, value] of Object.entries(props)) {
      if (key === discriminator) {
        continue;
      }
      const existing = mergedProperties[key];
      if (!existing) {
        mergedProperties[key] = value;
        continue;
      }
      if (JSON.stringify(existing) === JSON.stringify(value)) {
        continue;
      }
      mergedProperties[key] = {
        anyOf: [existing, value],
      };
    }
  }

  const requiredLists = remaining.map((entry) => new Set(entry.required ?? []));
  const required = Object.keys(mergedProperties).filter((key) =>
    requiredLists.every((variantRequired) => variantRequired.has(key)),
  );
  const additionalProperties = remaining.every((entry) => entry.additionalProperties === false)
    ? false
    : undefined;

  return normalizeSchemaNode(
    {
      ...schema,
      type: "object",
      properties: mergedProperties,
      required,
      additionalProperties,
      nullable,
      anyOf: undefined,
      oneOf: undefined,
      allOf: undefined,
    },
    path,
  );
}
