import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaFiles = {
  CreateProjectRequest:
    "schemas/v1/projects/create-project-request.schema.json",
  ProjectAcceptedResponse:
    "schemas/v1/projects/project-accepted-response.schema.json",
  ProjectActivatedEvent:
    "schemas/v1/projects/project-activated-event.schema.json",
  ProjectProvisioningFailedEvent:
    "schemas/v1/projects/project-provisioning-failed-event.schema.json",
  ProjectResponse: "schemas/v1/projects/project-response.schema.json",
  CreateJobRequest: "schemas/v1/jobs/create-job-request.schema.json",
  JobAcceptedResponse: "schemas/v1/jobs/job-accepted-response.schema.json",
  JobResponse: "schemas/v1/jobs/job-response.schema.json",
  StartExecutionCommand:
    "schemas/v1/executions/start-execution-command.schema.json",
  ExecutionAcceptedResponse:
    "schemas/v1/executions/execution-accepted-response.schema.json",
  ExecutionCompletedEvent:
    "schemas/v1/executions/execution-completed-event.schema.json",
  ExecutionFailedEvent:
    "schemas/v1/executions/execution-failed-event.schema.json",
  StartReviewCommand: "schemas/v1/reviews/start-review-command.schema.json",
  ReviewAcceptedResponse:
    "schemas/v1/reviews/review-accepted-response.schema.json",
  ReviewCompletedEvent:
    "schemas/v1/reviews/review-completed-event.schema.json",
  ArtifactManifest: "schemas/v1/artifacts/artifact-manifest.schema.json",
};

const cache = new Map();

function loadSchema(file) {
  const absolute = resolve(packageRoot, file);
  if (!cache.has(absolute)) {
    cache.set(absolute, JSON.parse(readFileSync(absolute, "utf8")));
  }
  return { schema: cache.get(absolute), file: absolute };
}

function resolvePointer(document, fragment) {
  if (!fragment || fragment === "#") {
    return document;
  }
  return fragment
    .replace(/^#\//, "")
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((value, part) => value?.[part], document);
}

function resolveReference(reference, currentFile) {
  const [target, fragment = ""] = reference.split("#");
  const targetFile = target ? resolve(dirname(currentFile), target) : currentFile;
  if (!cache.has(targetFile)) {
    cache.set(targetFile, JSON.parse(readFileSync(targetFile, "utf8")));
  }
  return {
    schema: resolvePointer(cache.get(targetFile), `#${fragment}`),
    file: targetFile,
  };
}

function isType(value, type) {
  switch (type) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    default:
      return typeof value === type;
  }
}

function allowedProperties(schema, file, seen = new Set()) {
  if (!schema || seen.has(schema)) {
    return new Set();
  }
  seen.add(schema);

  if (schema.$ref) {
    const resolved = resolveReference(schema.$ref, file);
    return allowedProperties(resolved.schema, resolved.file, seen);
  }

  const names = new Set(Object.keys(schema.properties ?? {}));
  for (const part of schema.allOf ?? []) {
    for (const name of allowedProperties(part, file, seen)) {
      names.add(name);
    }
  }
  return names;
}

function validateSchema(schema, value, file, path, errors) {
  if (schema.$ref) {
    const resolved = resolveReference(schema.$ref, file);
    validateSchema(resolved.schema, value, resolved.file, path, errors);
    return;
  }

  if (schema.const !== undefined && !Object.is(value, schema.const)) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
    return;
  }

  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) {
    errors.push(`${path} must be one of ${schema.enum.join(", ")}`);
    return;
  }

  if (schema.oneOf) {
    const attempts = schema.oneOf.map((candidate) => {
      const candidateErrors = [];
      validateSchema(candidate, value, file, path, candidateErrors);
      return candidateErrors;
    });
    const matches = attempts.filter(
      (candidateErrors) => candidateErrors.length === 0,
    );
    if (matches.length !== 1) {
      errors.push(`${path} must match exactly one allowed shape`);
      if (matches.length === 0) {
        const nearest = attempts.reduce((best, candidate) =>
          candidate.length < best.length ? candidate : best,
        );
        errors.push(...nearest);
      }
    }
    return;
  }

  for (const part of schema.allOf ?? []) {
    validateSchema(part, value, file, path, errors);
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => isType(value, type))) {
      errors.push(`${path} must be ${types.join(" or ")}`);
      return;
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path} is shorter than ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path} is longer than ${schema.maxLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${path} has an invalid format`);
    }
    if (
      schema.format === "date-time" &&
      (!value.endsWith("Z") || Number.isNaN(Date.parse(value)))
    ) {
      errors.push(`${path} must be an RFC 3339 UTC timestamp`);
    }
  }

  if (typeof value === "number" && schema.minimum !== undefined) {
    if (value < schema.minimum) {
      errors.push(`${path} must be at least ${schema.minimum}`);
    }
  }
  if (typeof value === "number" && schema.maximum !== undefined) {
    if (value > schema.maximum) {
      errors.push(`${path} must be at most ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path} has fewer than ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path} has more than ${schema.maxItems} items`);
    }
    if (schema.uniqueItems) {
      const serialized = value.map((item) => JSON.stringify(item));
      if (new Set(serialized).size !== serialized.length) {
        errors.push(`${path} must contain unique items`);
      }
    }
    if (schema["x-openclaw-uniqueBy"]) {
      const key = schema["x-openclaw-uniqueBy"];
      const values = value.map((item) => item?.[key]);
      if (new Set(values).size !== values.length) {
        errors.push(`${path} must contain unique ${key} values`);
      }
    }
    value.forEach((item, index) => {
      if (schema.items) {
        validateSchema(schema.items, item, file, `${path}[${index}]`, errors);
      }
    });
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        errors.push(`${path}.${required} is required`);
      }
    }
    for (const [name, propertySchema] of Object.entries(
      schema.properties ?? {},
    )) {
      if (Object.hasOwn(value, name)) {
        validateSchema(
          propertySchema,
          value[name],
          file,
          `${path}.${name}`,
          errors,
        );
      }
    }
    if (
      schema.additionalProperties === false ||
      schema.unevaluatedProperties === false
    ) {
      const allowed = allowedProperties(schema, file);
      for (const name of Object.keys(value)) {
        if (!allowed.has(name)) {
          errors.push(`${path}.${name} is not allowed`);
        }
      }
    }
  }
}

export function validate(contractName, value) {
  const schemaFile = schemaFiles[contractName];
  if (!schemaFile) {
    throw new TypeError(`unknown contract: ${contractName}`);
  }

  const loaded = loadSchema(schemaFile);
  const errors = [];
  validateSchema(loaded.schema, value, loaded.file, "$", errors);
  return {
    valid: errors.length === 0,
    errors,
  };
}

export const validators = Object.freeze(
  Object.fromEntries(
    Object.keys(schemaFiles).map((name) => [
      name,
      (value) => validate(name, value),
    ]),
  ),
);
