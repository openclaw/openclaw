import JSON5 from "json5";
import { html, nothing, type TemplateResult } from "lit";
import type { ConfigUiHints } from "../types.ts";
import {
  buildHelpText,
  icons,
  isAnySchema,
  jsonValue,
  renderFieldHeader,
  renderHelpPopover,
  renderRawFallback,
} from "./config-form.node.helpers.ts";
import {
  defaultValue,
  hintForPath,
  humanize,
  isSensitivePath,
  pathKey,
  schemaType,
  type JsonSchema,
} from "./config-form.shared.ts";

function comparableValueKey(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null) {
    return "null";
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return `${typeof value}:${String(value)}`;
  }
  const serialized = jsonValue(value);
  if (serialized) {
    return `json:${serialized}`;
  }
  return Object.prototype.toString.call(value);
}

function displayValueText(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  const serialized = jsonValue(value);
  if (serialized) {
    return serialized;
  }
  return Object.prototype.toString.call(value);
}

export function renderNode(params: {
  schema: JsonSchema;
  value: unknown;
  path: Array<string | number>;
  hints: ConfigUiHints;
  unsupported: Set<string>;
  disabled: boolean;
  showLabel?: boolean;
  onPatch: (path: Array<string | number>, value: unknown) => void;
}): TemplateResult | typeof nothing {
  const { schema, value, path, hints, unsupported, disabled, onPatch } = params;
  const showLabel = params.showLabel ?? true;
  const type = schemaType(schema);
  const hint = hintForPath(path, hints);
  const label = hint?.label ?? schema.title ?? humanize(String(path.at(-1)));
  const helpText = buildHelpText(schema, hint?.help);
  const key = pathKey(path);

  if (unsupported.has(key)) {
    return renderRawFallback({
      schema,
      value,
      path,
      hints,
      disabled,
      showLabel,
      reason: "This field uses a complex schema. Edit as JSON5.",
      onPatch,
    });
  }

  if (schema.anyOf || schema.oneOf) {
    const variants = schema.anyOf ?? schema.oneOf ?? [];
    const nonNull = variants.filter(
      (entry) =>
        !(entry.type === "null" || (Array.isArray(entry.type) && entry.type.includes("null"))),
    );

    if (nonNull.length === 1) {
      return renderNode({ ...params, schema: nonNull[0] });
    }

    const extractLiteral = (entry: JsonSchema): unknown => {
      if (entry.const !== undefined) {
        return entry.const;
      }
      if (entry.enum && entry.enum.length === 1) {
        return entry.enum[0];
      }
      return undefined;
    };
    const literals = nonNull.map(extractLiteral);
    const allLiterals = literals.every((entry) => entry !== undefined);

    if (allLiterals && literals.length > 0 && literals.length <= 5) {
      const resolvedValue = value ?? schema.default;
      return html`
        <div class="cfg-field cfg-field--compact cfg-item cfg-item--compact">
          ${renderFieldHeader(label, helpText, showLabel)}
          <div class="cfg-segmented">
            ${literals.map(
              (literal) => html`
                <button
                  type="button"
                  class="cfg-segmented__btn ${
                    comparableValueKey(literal) === comparableValueKey(resolvedValue)
                      ? "active"
                      : ""
                  }"
                  ?disabled=${disabled}
                  @click=${() => onPatch(path, literal)}
                >
                  ${displayValueText(literal)}
                </button>
              `,
            )}
          </div>
        </div>
      `;
    }

    if (allLiterals && literals.length > 5) {
      return renderSelect({ ...params, options: literals, value: value ?? schema.default });
    }

    const primitiveTypes = new Set(nonNull.map((entry) => schemaType(entry)).filter(Boolean));
    const normalizedTypes = new Set(
      [...primitiveTypes].map((entry) => (entry === "integer" ? "number" : entry)),
    );
    if (
      [...normalizedTypes].every((entry) =>
        ["string", "number", "boolean"].includes(entry as string),
      )
    ) {
      const hasString = normalizedTypes.has("string");
      const hasNumber = normalizedTypes.has("number");
      const hasBoolean = normalizedTypes.has("boolean");

      if (hasBoolean && normalizedTypes.size === 1) {
        return renderNode({
          ...params,
          schema: { ...schema, type: "boolean", anyOf: undefined, oneOf: undefined },
        });
      }

      if (hasString || hasNumber) {
        return renderTextInput({
          ...params,
          inputType: hasNumber && !hasString ? "number" : "text",
        });
      }
    }

    return renderRawFallback({
      schema,
      value,
      path,
      hints,
      disabled,
      showLabel,
      reason: "This union is not safely editable with basic controls.",
      onPatch,
    });
  }

  if (schema.enum) {
    const options = schema.enum;
    if (options.length <= 5) {
      const resolvedValue = value ?? schema.default;
      return html`
        <div class="cfg-field cfg-field--compact cfg-item cfg-item--compact">
          ${renderFieldHeader(label, helpText, showLabel)}
          <div class="cfg-segmented">
            ${options.map(
              (option) => html`
                <button
                  type="button"
                  class="cfg-segmented__btn ${
                    comparableValueKey(option) === comparableValueKey(resolvedValue) ? "active" : ""
                  }"
                  ?disabled=${disabled}
                  @click=${() => onPatch(path, option)}
                >
                  ${displayValueText(option)}
                </button>
              `,
            )}
          </div>
        </div>
      `;
    }
    return renderSelect({ ...params, options, value: value ?? schema.default });
  }

  if (type === "object") {
    return renderObject(params);
  }

  if (type === "array") {
    return renderArray(params);
  }

  if (type === "boolean") {
    const displayValue =
      typeof value === "boolean"
        ? value
        : typeof schema.default === "boolean"
          ? schema.default
          : false;
    return html`
      <div class="cfg-item cfg-item--compact">
        <label class="cfg-toggle-row ${disabled ? "disabled" : ""}">
        <div class="cfg-toggle-row__content">
          ${showLabel ? html`<span class="cfg-toggle-row__label">${label}</span>` : nothing}
        </div>
        <div class="cfg-toggle">
          <input
            type="checkbox"
            .checked=${displayValue}
            ?disabled=${disabled}
            @change=${(event: Event) => onPatch(path, (event.target as HTMLInputElement).checked)}
          />
          <span class="cfg-toggle__track"></span>
        </div>
        </label>
      </div>
    `;
  }

  if (type === "number" || type === "integer") {
    return renderNumberInput(params);
  }

  if (type === "string") {
    return renderTextInput({ ...params, inputType: "text" });
  }

  return renderRawFallback({
    schema,
    value,
    path,
    hints,
    disabled,
    showLabel,
    reason: `Unsupported field type${type ? `: ${type}` : ""}. Edit as JSON5.`,
    onPatch,
  });
}

function renderTextInput(params: {
  schema: JsonSchema;
  value: unknown;
  path: Array<string | number>;
  hints: ConfigUiHints;
  disabled: boolean;
  showLabel?: boolean;
  inputType: "text" | "number";
  onPatch: (path: Array<string | number>, value: unknown) => void;
}): TemplateResult {
  const { schema, value, path, hints, disabled, onPatch, inputType } = params;
  const showLabel = params.showLabel ?? true;
  const hint = hintForPath(path, hints);
  const label = hint?.label ?? schema.title ?? humanize(String(path.at(-1)));
  const helpText = buildHelpText(schema, hint?.help);
  const isSensitive = hint?.sensitive ?? isSensitivePath(path);
  const placeholder =
    hint?.placeholder ??
    (isSensitive
      ? "******"
      : schema.default !== undefined
        ? `Default: ${displayValueText(schema.default)}`
        : "");
  const displayValue = value ?? "";

  return html`
    <div class="cfg-field cfg-field--compact cfg-item cfg-item--compact">
      ${renderFieldHeader(label, helpText, showLabel)}
      <div class="cfg-input-wrap">
        <input
          type=${isSensitive ? "password" : inputType}
          class="cfg-input"
          placeholder=${placeholder}
          .value=${displayValueText(displayValue)}
          ?disabled=${disabled}
          @input=${(event: Event) => {
            const raw = (event.target as HTMLInputElement).value;
            if (inputType === "number") {
              if (raw.trim() === "") {
                onPatch(path, undefined);
                return;
              }
              const parsed = Number(raw);
              onPatch(path, Number.isNaN(parsed) ? raw : parsed);
              return;
            }
            onPatch(path, raw);
          }}
          @change=${(event: Event) => {
            if (inputType === "number") {
              return;
            }
            const raw = (event.target as HTMLInputElement).value;
            onPatch(path, raw.trim());
          }}
        />
        ${
          schema.default !== undefined
            ? html`
                <button
                  type="button"
                  class="cfg-input__reset"
                  title="Reset to default"
                  ?disabled=${disabled}
                  @click=${() => onPatch(path, schema.default)}
                >
                  Reset
                </button>
              `
            : nothing
        }
      </div>
    </div>
  `;
}

function renderNumberInput(params: {
  schema: JsonSchema;
  value: unknown;
  path: Array<string | number>;
  hints: ConfigUiHints;
  disabled: boolean;
  showLabel?: boolean;
  onPatch: (path: Array<string | number>, value: unknown) => void;
}): TemplateResult {
  const { schema, value, path, hints, disabled, onPatch } = params;
  const showLabel = params.showLabel ?? true;
  const hint = hintForPath(path, hints);
  const label = hint?.label ?? schema.title ?? humanize(String(path.at(-1)));
  const helpText = buildHelpText(schema, hint?.help);
  const displayValue = value ?? schema.default ?? "";
  const numValue = typeof displayValue === "number" ? displayValue : 0;
  const numberFieldClass = showLabel
    ? "cfg-field--number"
    : "cfg-field--number cfg-field--number-no-label";

  return html`
    <div class="cfg-field cfg-field--compact ${numberFieldClass} cfg-item cfg-item--compact">
      ${renderFieldHeader(label, helpText, showLabel, false)}
      <div class="cfg-number">
        <button
          type="button"
          class="cfg-number__btn"
          ?disabled=${disabled}
          @click=${() => onPatch(path, numValue - 1)}
        >
          -
        </button>
        <input
          type="number"
          class="cfg-number__input"
          .value=${displayValueText(displayValue)}
          ?disabled=${disabled}
          @input=${(event: Event) => {
            const raw = (event.target as HTMLInputElement).value;
            const parsed = raw === "" ? undefined : Number(raw);
            onPatch(path, parsed);
          }}
        />
        <button
          type="button"
          class="cfg-number__btn"
          ?disabled=${disabled}
          @click=${() => onPatch(path, numValue + 1)}
        >
          +
        </button>
      </div>
    </div>
  `;
}

function renderSelect(params: {
  schema: JsonSchema;
  value: unknown;
  path: Array<string | number>;
  hints: ConfigUiHints;
  disabled: boolean;
  showLabel?: boolean;
  options: unknown[];
  onPatch: (path: Array<string | number>, value: unknown) => void;
}): TemplateResult {
  const { schema, value, path, hints, disabled, options, onPatch } = params;
  const showLabel = params.showLabel ?? true;
  const hint = hintForPath(path, hints);
  const label = hint?.label ?? schema.title ?? humanize(String(path.at(-1)));
  const helpText = buildHelpText(schema, hint?.help);
  const resolvedValue = value ?? schema.default;
  const currentIndex = options.findIndex(
    (option) => comparableValueKey(option) === comparableValueKey(resolvedValue),
  );
  const unset = "__unset__";

  return html`
    <div class="cfg-field cfg-field--compact cfg-item cfg-item--compact">
      ${renderFieldHeader(label, helpText, showLabel)}
      <select
        class="cfg-select"
        ?disabled=${disabled}
        .value=${currentIndex >= 0 ? String(currentIndex) : unset}
        @change=${(event: Event) => {
          const raw = (event.target as HTMLSelectElement).value;
          onPatch(path, raw === unset ? undefined : options[Number(raw)]);
        }}
      >
        <option value=${unset}>Select...</option>
        ${options.map(
          (option, index) => html`
            <option value=${String(index)}>${displayValueText(option)}</option>
          `,
        )}
      </select>
    </div>
  `;
}

function renderObject(params: {
  schema: JsonSchema;
  value: unknown;
  path: Array<string | number>;
  hints: ConfigUiHints;
  unsupported: Set<string>;
  disabled: boolean;
  showLabel?: boolean;
  onPatch: (path: Array<string | number>, value: unknown) => void;
}): TemplateResult {
  const { schema, value, path, hints, unsupported, disabled, onPatch } = params;
  const showLabel = params.showLabel ?? true;
  const hint = hintForPath(path, hints);
  const label = hint?.label ?? schema.title ?? humanize(String(path.at(-1)));
  const helpText = buildHelpText(schema, hint?.help);

  const fallback = value ?? schema.default;
  const obj =
    fallback && typeof fallback === "object" && !Array.isArray(fallback)
      ? (fallback as Record<string, unknown>)
      : {};
  const props = schema.properties ?? {};
  const entries = Object.entries(props);

  const sorted = entries.toSorted((a, b) => {
    const orderA = hintForPath([...path, a[0]], hints)?.order ?? 0;
    const orderB = hintForPath([...path, b[0]], hints)?.order ?? 0;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return a[0].localeCompare(b[0]);
  });

  const reserved = new Set(Object.keys(props));
  const additional = schema.additionalProperties;
  const mapSchema =
    additional === true
      ? ({ type: "object" } as JsonSchema)
      : additional && typeof additional === "object"
        ? additional
        : null;
  const primitiveChildCount = sorted.filter(([, node]) => {
    const nodeType = schemaType(node);
    return (
      nodeType === "string" ||
      nodeType === "number" ||
      nodeType === "integer" ||
      nodeType === "boolean"
    );
  }).length;
  const complexChildCount = sorted.length - primitiveChildCount + (mapSchema ? 1 : 0);
  const fullWidth = complexChildCount > 4 || sorted.length >= 12;

  if (path.length === 1) {
    return html`
      <div class="cfg-fields cfg-fields--top">
        ${sorted.map(([propKey, node]) =>
          renderNode({
            schema: node,
            value: obj[propKey],
            path: [...path, propKey],
            hints,
            unsupported,
            disabled,
            onPatch,
          }),
        )}
        ${
          mapSchema
            ? renderMapField({
                schema: mapSchema,
                value: obj,
                path,
                hints,
                unsupported,
                disabled,
                reservedKeys: reserved,
                onPatch,
              })
            : nothing
        }
      </div>
    `;
  }

  if (!showLabel) {
    return html`
      <div class="cfg-fields cfg-fields--embedded">
        <div class="cfg-fields__meta">${renderHelpPopover(label, helpText)}</div>
        ${sorted.map(([propKey, node]) =>
          renderNode({
            schema: node,
            value: obj[propKey],
            path: [...path, propKey],
            hints,
            unsupported,
            disabled,
            onPatch,
          }),
        )}
        ${
          mapSchema
            ? renderMapField({
                schema: mapSchema,
                value: obj,
                path,
                hints,
                unsupported,
                disabled,
                reservedKeys: reserved,
                onPatch,
              })
            : nothing
        }
      </div>
    `;
  }

  return html`
    <details class="cfg-object cfg-item ${fullWidth ? "cfg-item--full" : "cfg-item--compact"}" open>
      <summary class="cfg-object__header">
        <span class="cfg-object__title">${label}</span>
        <span class="cfg-object__meta">
          ${renderHelpPopover(label, helpText)}
          <span class="cfg-object__chevron">${icons.chevronDown}</span>
        </span>
      </summary>
      <div class="cfg-object__content">
        ${sorted.map(([propKey, node]) =>
          renderNode({
            schema: node,
            value: obj[propKey],
            path: [...path, propKey],
            hints,
            unsupported,
            disabled,
            onPatch,
          }),
        )}
        ${
          mapSchema
            ? renderMapField({
                schema: mapSchema,
                value: obj,
                path,
                hints,
                unsupported,
                disabled,
                reservedKeys: reserved,
                onPatch,
              })
            : nothing
        }
      </div>
    </details>
  `;
}

function renderArray(params: {
  schema: JsonSchema;
  value: unknown;
  path: Array<string | number>;
  hints: ConfigUiHints;
  unsupported: Set<string>;
  disabled: boolean;
  showLabel?: boolean;
  onPatch: (path: Array<string | number>, value: unknown) => void;
}): TemplateResult {
  const { schema, value, path, hints, unsupported, disabled, onPatch } = params;
  const showLabel = params.showLabel ?? true;
  const hint = hintForPath(path, hints);
  const label = hint?.label ?? schema.title ?? humanize(String(path.at(-1)));
  const helpText = buildHelpText(schema, hint?.help);

  const itemsSchema = Array.isArray(schema.items) ? schema.items[0] : schema.items;
  if (!itemsSchema) {
    return renderRawFallback({
      schema,
      value,
      path,
      hints,
      disabled,
      showLabel,
      reason: "Array item schema is missing. Edit as JSON5.",
      onPatch,
    });
  }

  const arr = Array.isArray(value) ? value : Array.isArray(schema.default) ? schema.default : [];
  const itemType = schemaType(itemsSchema);
  const hasComplexItems = arr.some((entry) => typeof entry === "object" && entry !== null);
  const fullWidth =
    itemType === "object" || itemType === "array" || hasComplexItems || arr.length >= 4;

  return html`
    <div class="cfg-array cfg-item ${fullWidth ? "cfg-item--full" : "cfg-item--compact"}">
      <div class="cfg-array__header">
        ${
          showLabel
            ? html`
                <span class="cfg-array__label-wrap">
                  <span class="cfg-array__label">${label}</span>
                  ${renderHelpPopover(label, helpText)}
                </span>
              `
            : html`<span class="cfg-array__label-wrap">${renderHelpPopover(label, helpText)}</span>`
        }
        <span class="cfg-array__count">${arr.length} item${arr.length !== 1 ? "s" : ""}</span>
        <button
          type="button"
          class="cfg-array__add"
          ?disabled=${disabled}
          @click=${() => {
            const next = [...arr, defaultValue(itemsSchema)];
            onPatch(path, next);
          }}
        >
          <span class="cfg-array__add-icon">${icons.plus}</span>
          Add
        </button>
      </div>

      ${
        arr.length === 0
          ? html`
              <div class="cfg-array__empty">No items yet. Click "Add" to create one.</div>
            `
          : html`
              <div class="cfg-array__items">
                ${arr.map(
                  (item, idx) => html`
                    <div class="cfg-array__item">
                      <div class="cfg-array__item-header">
                        <span class="cfg-array__item-index">#${idx + 1}</span>
                        <button
                          type="button"
                          class="cfg-array__item-remove"
                          title="Remove item"
                          ?disabled=${disabled}
                          @click=${() => {
                            const next = [...arr];
                            next.splice(idx, 1);
                            onPatch(path, next);
                          }}
                        >
                          ${icons.trash}
                        </button>
                      </div>
                      <div class="cfg-array__item-content">
                        ${renderNode({
                          schema: itemsSchema,
                          value: item,
                          path: [...path, idx],
                          hints,
                          unsupported,
                          disabled,
                          showLabel: false,
                          onPatch,
                        })}
                      </div>
                    </div>
                  `,
                )}
              </div>
            `
      }
    </div>
  `;
}

function renderMapField(params: {
  schema: JsonSchema;
  value: Record<string, unknown>;
  path: Array<string | number>;
  hints: ConfigUiHints;
  unsupported: Set<string>;
  disabled: boolean;
  reservedKeys: Set<string>;
  onPatch: (path: Array<string | number>, value: unknown) => void;
}): TemplateResult {
  const { schema, value, path, hints, unsupported, disabled, reservedKeys, onPatch } = params;
  const anySchema = isAnySchema(schema);
  const entries = Object.entries(value ?? {}).filter(([key]) => !reservedKeys.has(key));
  const helpText = "Extra key/value entries not explicitly listed in the schema.";
  const valueType = schemaType(schema);
  const hasComplexEntries = entries.some(
    ([, entryValue]) => typeof entryValue === "object" && entryValue !== null,
  );
  const schemaIsComplex = !anySchema && (valueType === "object" || valueType === "array");
  const fullWidth = schemaIsComplex || hasComplexEntries || entries.length >= 4;

  return html`
    <div class="cfg-map cfg-item ${fullWidth ? "cfg-item--full" : "cfg-item--compact"}">
      <div class="cfg-map__header">
        <span class="cfg-map__label-wrap">
          <span class="cfg-map__label">Custom entries</span>
          ${renderHelpPopover("Custom entries", helpText)}
        </span>
        <button
          type="button"
          class="cfg-map__add"
          ?disabled=${disabled}
          @click=${() => {
            const next = { ...value };
            let index = 1;
            let key = `custom-${index}`;
            while (key in next) {
              index += 1;
              key = `custom-${index}`;
            }
            next[key] = anySchema ? {} : defaultValue(schema);
            onPatch(path, next);
          }}
        >
          <span class="cfg-map__add-icon">${icons.plus}</span>
          Add Entry
        </button>
      </div>

      ${
        entries.length === 0
          ? html`
              <div class="cfg-map__empty">No custom entries.</div>
            `
          : html`
              <div class="cfg-map__items">
                ${entries.map(([key, entryValue]) => {
                  const valuePath = [...path, key];
                  const fallback = jsonValue(entryValue);
                  return html`
                    <div class="cfg-map__item">
                      <div class="cfg-map__item-key">
                        <input
                          type="text"
                          class="cfg-input cfg-input--sm"
                          placeholder="Key"
                          .value=${key}
                          ?disabled=${disabled}
                          @change=${(event: Event) => {
                            const nextKey = (event.target as HTMLInputElement).value.trim();
                            if (!nextKey || nextKey === key) {
                              return;
                            }
                            const next = { ...value };
                            if (nextKey in next) {
                              return;
                            }
                            next[nextKey] = next[key];
                            delete next[key];
                            onPatch(path, next);
                          }}
                        />
                      </div>
                      <div class="cfg-map__item-value">
                        ${
                          anySchema
                            ? html`
                                <textarea
                                  class="cfg-textarea cfg-textarea--sm"
                                  placeholder="JSON5 value"
                                  rows="2"
                                  .value=${fallback}
                                  ?disabled=${disabled}
                                  @change=${(event: Event) => {
                                    const target = event.target as HTMLTextAreaElement;
                                    const raw = target.value.trim();
                                    if (!raw) {
                                      onPatch(valuePath, undefined);
                                      target.setCustomValidity("");
                                      return;
                                    }
                                    try {
                                      onPatch(valuePath, JSON5.parse(raw));
                                      target.setCustomValidity("");
                                    } catch {
                                      target.setCustomValidity("Invalid JSON5 value");
                                      target.reportValidity();
                                      target.value = fallback;
                                    }
                                  }}
                                ></textarea>
                              `
                            : renderNode({
                                schema,
                                value: entryValue,
                                path: valuePath,
                                hints,
                                unsupported,
                                disabled,
                                showLabel: false,
                                onPatch,
                              })
                        }
                      </div>
                      <button
                        type="button"
                        class="cfg-map__item-remove"
                        title="Remove entry"
                        ?disabled=${disabled}
                        @click=${() => {
                          const next = { ...value };
                          delete next[key];
                          onPatch(path, next);
                        }}
                      >
                        ${icons.trash}
                      </button>
                    </div>
                  `;
                })}
              </div>
            `
      }
    </div>
  `;
}
