import { html, nothing } from "lit";
import type { ConfigUiHint, ConfigUiHints } from "../types";

export type ConfigFormProps = {
  schema: unknown | null;
  uiHints: ConfigUiHints;
  value: Record<string, unknown> | null;
  onPatch: (path: Array<string | number>, value: unknown) => void;
};

type JsonSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema | JsonSchema[];
  enum?: unknown[];
  default?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
};

export function renderConfigForm(props: ConfigFormProps) {
  if (!props.schema) {
    return html`<div class="muted">Schema unavailable.</div>`;
  }
  const schema = props.schema as JsonSchema;
  const value = props.value ?? {};
  if (schemaType(schema) !== "object" || !schema.properties) {
    return html`<div class="callout danger">Unsupported schema. Use Raw.</div>`;
  }
  const entries = Object.entries(schema.properties);
  const sorted = entries.sort((a, b) => {
    const orderA = hintForPath([a[0]], props.uiHints)?.order ?? 0;
    const orderB = hintForPath([b[0]], props.uiHints)?.order ?? 0;
    if (orderA !== orderB) return orderA - orderB;
    return a[0].localeCompare(b[0]);
  });

  return html`
    <div class="config-form">
      ${sorted.map(([key, node]) =>
        renderNode({
          schema: node,
          value: (value as Record<string, unknown>)[key],
          path: [key],
          hints: props.uiHints,
          onPatch: props.onPatch,
        }),
      )}
    </div>
  `;
}

function renderNode(params: {
  schema: JsonSchema;
  value: unknown;
  path: Array<string | number>;
  hints: ConfigUiHints;
  onPatch: (path: Array<string | number>, value: unknown) => void;
}) {
  const { schema, value, path, hints, onPatch } = params;
  const type = schemaType(schema);
  const hint = hintForPath(path, hints);
  const label = hint?.label ?? schema.title ?? humanize(String(path.at(-1)));
  const help = hint?.help ?? schema.description;

  if (schema.anyOf || schema.oneOf || schema.allOf) {
    return html`<div class="callout danger">
      ${label}: unsupported schema node. Use Raw.
    </div>`;
  }

  if (type === "object") {
    const props = schema.properties ?? {};
    const entries = Object.entries(props);
    if (entries.length === 0) return nothing;
    return html`
      <fieldset class="field-group">
        <legend>${label}</legend>
        ${help ? html`<div class="muted">${help}</div>` : nothing}
        ${entries.map(([key, node]) =>
          renderNode({
            schema: node,
            value: value && typeof value === "object" ? (value as any)[key] : undefined,
            path: [...path, key],
            hints,
            onPatch,
          }),
        )}
      </fieldset>
    `;
  }

  if (type === "array") {
    const itemSchema = Array.isArray(schema.items)
      ? schema.items[0]
      : schema.items;
    const arr = Array.isArray(value) ? value : [];
    return html`
      <div class="field">
        <div class="row" style="justify-content: space-between;">
          <span>${label}</span>
          <button
            class="btn"
            @click=${() => {
              const next = [...arr, defaultValue(itemSchema)];
              onPatch(path, next);
            }}
          >
            Add
          </button>
        </div>
        ${help ? html`<div class="muted">${help}</div>` : nothing}
        ${arr.map((entry, index) =>
          html`<div class="array-item">
            ${itemSchema
              ? renderNode({
                  schema: itemSchema,
                  value: entry,
                  path: [...path, index],
                  hints,
                  onPatch,
                })
              : nothing}
            <button
              class="btn danger"
              @click=${() => {
                const next = arr.slice();
                next.splice(index, 1);
                onPatch(path, next);
              }}
            >
              Remove
            </button>
          </div>`,
        )}
      </div>
    `;
  }

  if (schema.enum) {
    return html`
      <label class="field">
        <span>${label}</span>
        ${help ? html`<div class="muted">${help}</div>` : nothing}
        <select
          .value=${value == null ? "" : String(value)}
          @change=${(e: Event) =>
            onPatch(path, (e.target as HTMLSelectElement).value)}
        >
          ${schema.enum.map(
            (opt) => html`<option value=${String(opt)}>${String(opt)}</option>`,
          )}
        </select>
      </label>
    `;
  }

  if (type === "boolean") {
    return html`
      <label class="field">
        <span>${label}</span>
        ${help ? html`<div class="muted">${help}</div>` : nothing}
        <input
          type="checkbox"
          .checked=${Boolean(value)}
          @change=${(e: Event) =>
            onPatch(path, (e.target as HTMLInputElement).checked)}
        />
      </label>
    `;
  }

  if (type === "number" || type === "integer") {
    return html`
      <label class="field">
        <span>${label}</span>
        ${help ? html`<div class="muted">${help}</div>` : nothing}
        <input
          type="number"
          .value=${value == null ? "" : String(value)}
          @input=${(e: Event) => {
            const raw = (e.target as HTMLInputElement).value;
            const parsed = raw === "" ? undefined : Number(raw);
            onPatch(path, parsed);
          }}
        />
      </label>
    `;
  }

  if (type === "string") {
    const isSensitive = hint?.sensitive ?? isSensitivePath(path);
    const placeholder = hint?.placeholder ?? (isSensitive ? "••••" : "");
    return html`
      <label class="field">
        <span>${label}</span>
        ${help ? html`<div class="muted">${help}</div>` : nothing}
        <input
          type=${isSensitive ? "password" : "text"}
          placeholder=${placeholder}
          .value=${value == null ? "" : String(value)}
          @input=${(e: Event) =>
            onPatch(path, (e.target as HTMLInputElement).value)}
        />
      </label>
    `;
  }

  return html`<div class="field">
    <span>${label}</span>
    <div class="muted">Unsupported type. Use Raw.</div>
  </div>`;
}

function schemaType(schema: JsonSchema): string | undefined {
  if (!schema) return undefined;
  if (Array.isArray(schema.type)) {
    const filtered = schema.type.filter((t) => t !== "null");
    return filtered[0] ?? schema.type[0];
  }
  return schema.type;
}

function defaultValue(schema?: JsonSchema): unknown {
  if (!schema) return "";
  if (schema.default !== undefined) return schema.default;
  const type = schemaType(schema);
  switch (type) {
    case "object":
      return {};
    case "array":
      return [];
    case "boolean":
      return false;
    case "number":
    case "integer":
      return 0;
    case "string":
      return "";
    default:
      return "";
  }
}

function hintForPath(path: Array<string | number>, hints: ConfigUiHints) {
  const key = pathKey(path);
  return hints[key];
}

function pathKey(path: Array<string | number>): string {
  return path.filter((segment) => typeof segment === "string").join(".");
}

function humanize(raw: string) {
  return raw
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .replace(/^./, (m) => m.toUpperCase());
}

function isSensitivePath(path: Array<string | number>): boolean {
  const key = pathKey(path).toLowerCase();
  return (
    key.includes("token") ||
    key.includes("password") ||
    key.includes("secret") ||
    key.includes("apikey") ||
    key.endsWith("key")
  );
}
