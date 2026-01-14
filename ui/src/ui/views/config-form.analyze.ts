import { pathKey, schemaType, type JsonSchema } from "./config-form.shared";

export type ConfigSchemaAnalysis = {
  schema: JsonSchema | null;
  unsupportedPaths: string[];
};

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
  const unsupportedPaths: string[] = [];
  const normalized: JsonSchema = { ...schema };
  const pathLabel = pathKey(path) || "<root>";

  if (schema.anyOf || schema.oneOf || schema.allOf) {
    const union = normalizeUnion(schema, path);
    if (union) return union;
    unsupportedPaths.push(pathLabel);
    return { schema, unsupportedPaths };
  }

  const nullable = Array.isArray(schema.type) && schema.type.includes("null");
  const type =
    schemaType(schema) ??
    (schema.properties || schema.additionalProperties ? "object" : undefined);
  normalized.type = type ?? schema.type;

  if (nullable && !normalized.nullable) {
    normalized.nullable = true;
  }

  if (type === "object") {
    const properties = schema.properties ?? {};
    const normalizedProps: Record<string, JsonSchema> = {};
    for (const [key, value] of Object.entries(properties)) {
      const res = normalizeSchemaNode(value, [...path, key]);
      normalizedProps[key] = res.schema ?? value;
      unsupportedPaths.push(...res.unsupportedPaths);
    }
    normalized.properties = normalizedProps;

    if (
      schema.additionalProperties &&
      typeof schema.additionalProperties === "object"
    ) {
      const res = normalizeSchemaNode(
        schema.additionalProperties as JsonSchema,
        [...path, "*"],
      );
      normalized.additionalProperties =
        res.schema ?? schema.additionalProperties;
      unsupportedPaths.push(...res.unsupportedPaths);
    }
  }

  if (type === "array" && schema.items && !Array.isArray(schema.items)) {
    const res = normalizeSchemaNode(schema.items, [...path, 0]);
    normalized.items = res.schema ?? schema.items;
    unsupportedPaths.push(...res.unsupportedPaths);
  }

  return { schema: normalized, unsupportedPaths };
}

function normalizeUnion(
  schema: JsonSchema,
  path: Array<string | number>,
): ConfigSchemaAnalysis | null {
  const union = schema.anyOf ?? schema.oneOf ?? schema.allOf ?? [];
  const pathLabel = pathKey(path) || "<root>";
  if (union.length === 0) return null;

  const nonNull = union.filter(
    (v) =>
      !(
        v.type === "null" ||
        (Array.isArray(v.type) && v.type.includes("null"))
      ),
  );

  if (nonNull.length === 1) {
    const res = normalizeSchemaNode(nonNull[0], path);
    return {
      schema: { ...(res.schema ?? nonNull[0]), nullable: true },
      unsupportedPaths: res.unsupportedPaths,
    };
  }

  const literals = nonNull
    .map((v) => {
      if (v.const !== undefined) return v.const;
      if (v.enum && v.enum.length === 1) return v.enum[0];
      return undefined;
    })
    .filter((v) => v !== undefined);

  if (literals.length === nonNull.length) {
    return {
      schema: {
        ...schema,
        anyOf: undefined,
        oneOf: undefined,
        allOf: undefined,
        type: "string",
        enum: literals as unknown[],
      },
      unsupportedPaths: [],
    };
  }

  return { schema, unsupportedPaths: [pathLabel] };
}

