import { html } from "lit";
import type { ConfigUiHints } from "../types";
import { hintForPath, schemaType, type JsonSchema } from "./config-form.shared";
import { renderNode } from "./config-form.node";

export type ConfigFormProps = {
  schema: JsonSchema | null;
  uiHints: ConfigUiHints;
  value: Record<string, unknown> | null;
  disabled?: boolean;
  unsupportedPaths?: string[];
  onPatch: (path: Array<string | number>, value: unknown) => void;
};

export function renderConfigForm(props: ConfigFormProps) {
  if (!props.schema) {
    return html`<div class="muted">Schema unavailable.</div>`;
  }
  const schema = props.schema;
  const value = props.value ?? {};
  if (schemaType(schema) !== "object" || !schema.properties) {
    return html`<div class="callout danger">Unsupported schema. Use Raw.</div>`;
  }
  const unsupported = new Set(props.unsupportedPaths ?? []);
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
          unsupported,
          disabled: props.disabled ?? false,
          onPatch: props.onPatch,
        }),
      )}
    </div>
  `;
}

