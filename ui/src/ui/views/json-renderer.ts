import { html } from "lit";

export function tryParseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

export function renderJsonTree(obj: unknown, depth = 0): unknown {
  if (obj === null || obj === undefined) {
    return html`
      <span class="json-null">null</span>
    `;
  }
  if (typeof obj === "boolean") {
    return html`<span class="json-bool">${String(obj)}</span>`;
  }
  if (typeof obj === "number") {
    return html`<span class="json-num">${obj}</span>`;
  }
  if (typeof obj === "string") {
    return html`<span class="json-str">"${obj}"</span>`;
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) {
      return html`
        <span class="json-bracket">[]</span>
      `;
    }
    return html`<div class="json-array" style="padding-left:${depth > 0 ? 14 : 0}px">${obj.map((item, i) => html`<div class="json-row"><span class="json-idx">${i}</span>${renderJsonTree(item, depth + 1)}</div>`)}</div>`;
  }
  if (typeof obj === "object") {
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length === 0) {
      return html`
        <span class="json-bracket">{}</span>
      `;
    }
    return html`<div class="json-obj" style="padding-left:${depth > 0 ? 14 : 0}px">${entries.map(([k, v]) => html`<div class="json-row"><span class="json-key">${k}:</span> ${renderJsonTree(v, depth + 1)}</div>`)}</div>`;
  }
  return html`${String(obj)}`;
}

/**
 * Render a JSON object/value using the structured tree if possible, falling back to a code block.
 */
export function renderJsonBlock(data: unknown) {
  if (data === null || data === undefined) {
    return html`
      <pre class="code-block">null</pre>
    `;
  }
  if (typeof data === "string") {
    const parsed = tryParseJson(data);
    if (parsed) {
      return html`<div class="log-detail-json">${renderJsonTree(parsed)}</div>`;
    }
    return html`<pre class="code-block">${data}</pre>`;
  }
  return html`<div class="log-detail-json">${renderJsonTree(data)}</div>`;
}
