import JSON5 from "json5";
import { html, type TemplateResult } from "lit";

type RawParseState = {
  raw: string;
  value: Record<string, unknown> | null;
  error: string | null;
  errorLine: number | null;
  errorColumn: number | null;
  errorContext: string | null;
};

export const RAW_TREE_MAX_CHARS = 120_000;

let rawParseCache: RawParseState | null = null;

function parseJson5ErrorLocation(message: string): { line: number | null; column: number | null } {
  const patterns = [
    /at\s+(\d+):(\d+)/i,
    /\((\d+):(\d+)\)/,
    /line\s+(\d+)\s*(?:,|and)?\s*column\s+(\d+)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    if (!match) {
      continue;
    }
    return {
      line: Number.parseInt(match[1] ?? "", 10) || null,
      column: Number.parseInt(match[2] ?? "", 10) || null,
    };
  }
  return { line: null, column: null };
}

function buildRawErrorContext(
  raw: string,
  line: number | null,
  column: number | null,
): string | null {
  if (!line || !column) {
    return null;
  }
  const lines = raw.split(/\r?\n/);
  if (line < 1 || line > lines.length) {
    return null;
  }
  const start = Math.max(1, line - 1);
  const end = Math.min(lines.length, line + 1);
  const width = String(end).length;
  const context: string[] = [];
  for (let current = start; current <= end; current += 1) {
    context.push(`${String(current).padStart(width, " ")} | ${lines[current - 1] ?? ""}`);
    if (current === line) {
      context.push(`${" ".repeat(width)} | ${" ".repeat(Math.max(0, column - 1))}^`);
    }
  }
  return context.join("\n");
}

export function parseRawJson5(raw: string): RawParseState {
  if (rawParseCache && rawParseCache.raw === raw) {
    return rawParseCache;
  }

  let value: Record<string, unknown> | null = null;
  let error: string | null = null;
  let errorLine: number | null = null;
  let errorColumn: number | null = null;

  try {
    const parsed = JSON5.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      error = "Root config must be an object.";
    } else {
      value = parsed as Record<string, unknown>;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    const location = parseJson5ErrorLocation(error);
    errorLine = location.line;
    errorColumn = location.column;
  }

  const errorContext = error ? buildRawErrorContext(raw, errorLine, errorColumn) : null;
  rawParseCache = {
    raw,
    value,
    error,
    errorLine,
    errorColumn,
    errorContext,
  };
  return rawParseCache;
}

export function setRawTreeExpanded(target: EventTarget | null, expand: boolean): void {
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const panel = target.closest(".config-raw-panel");
  if (!panel) {
    return;
  }
  const nodes = panel.querySelectorAll<HTMLDetailsElement>(".config-raw-node");
  nodes.forEach((node, index) => {
    node.open = expand ? true : index === 0;
  });
}

function unknownTokenText(value: unknown): string {
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
    return String(value);
  }
  if (typeof value === "symbol") {
    return value.toString();
  }
  if (typeof value === "function") {
    return "[Function]";
  }
  try {
    return JSON.stringify(value) ?? Object.prototype.toString.call(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function renderRawToken(value: unknown): TemplateResult {
  if (typeof value === "string") {
    return html`<span class="config-raw-token config-raw-token--string">${JSON.stringify(value)}</span>`;
  }
  if (typeof value === "number") {
    const text = Number.isFinite(value)
      ? String(value)
      : Number.isNaN(value)
        ? "NaN"
        : value > 0
          ? "Infinity"
          : "-Infinity";
    return html`<span class="config-raw-token config-raw-token--number">${text}</span>`;
  }
  if (typeof value === "boolean") {
    return html`<span class="config-raw-token config-raw-token--boolean">${String(value)}</span>`;
  }
  if (value === null) {
    return html`
      <span class="config-raw-token config-raw-token--null">null</span>
    `;
  }
  return html`
    <span class="config-raw-token config-raw-token--unknown">${unknownTokenText(value)}</span>
  `;
}

function renderRawKey(label: string, indexed = false): TemplateResult {
  const keyText = indexed ? `[${label}]` : JSON.stringify(label);
  const keyClass = indexed ? "config-raw-token--index" : "config-raw-token--key";
  return html`
    <span class="config-raw-token ${keyClass}">${keyText}</span>
    <span class="config-raw-token config-raw-token--punct">:</span>
  `;
}

export function renderRawTreeNode(params: {
  value: unknown;
  depth: number;
  label?: string;
  indexed?: boolean;
}): TemplateResult {
  const { value, depth, label, indexed = false } = params;
  const keyTemplate =
    label !== undefined
      ? html`<span class="config-raw-key">${renderRawKey(label, indexed)}</span>`
      : null;

  if (Array.isArray(value)) {
    const countLabel = `${value.length} item${value.length === 1 ? "" : "s"}`;
    return html`
      <details class="config-raw-node config-raw-node--array" ?open=${depth === 0}>
        <summary class="config-raw-node__summary">
          ${keyTemplate}
          <span class="config-raw-token config-raw-token--punct">[</span>
          <span class="config-raw-node__meta">${countLabel}</span>
          <span class="config-raw-token config-raw-token--punct">]</span>
        </summary>
        <div class="config-raw-node__children">
          ${
            value.length > 0
              ? value.map(
                  (entry, index): TemplateResult =>
                    renderRawTreeNode({
                      value: entry,
                      depth: depth + 1,
                      label: String(index),
                      indexed: true,
                    }),
                )
              : html`
                  <div class="config-raw-node__empty">empty array</div>
                `
          }
        </div>
      </details>
    `;
  }

  if (value && typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    const entries = Object.entries(objectValue);
    const countLabel = `${entries.length} field${entries.length === 1 ? "" : "s"}`;
    return html`
      <details class="config-raw-node config-raw-node--object" ?open=${depth === 0}>
        <summary class="config-raw-node__summary">
          ${keyTemplate}
          <span class="config-raw-token config-raw-token--punct">{</span>
          <span class="config-raw-node__meta">${countLabel}</span>
          <span class="config-raw-token config-raw-token--punct">}</span>
        </summary>
        <div class="config-raw-node__children">
          ${
            entries.length > 0
              ? entries.map(
                  ([entryKey, entryValue]): TemplateResult =>
                    renderRawTreeNode({ value: entryValue, depth: depth + 1, label: entryKey }),
                )
              : html`
                  <div class="config-raw-node__empty">empty object</div>
                `
          }
        </div>
      </details>
    `;
  }

  return html`<div class="config-raw-leaf">${keyTemplate}${renderRawToken(value)}</div>`;
}
