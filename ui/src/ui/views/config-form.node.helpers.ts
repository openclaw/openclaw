import JSON5 from "json5";
import { html, nothing, type TemplateResult } from "lit";
import type { ConfigUiHints } from "../types.ts";
import { hintForPath, humanize, schemaType, type JsonSchema } from "./config-form.shared.ts";

const META_KEYS = new Set(["title", "description", "default", "nullable"]);

export function isAnySchema(schema: JsonSchema): boolean {
  const keys = Object.keys(schema ?? {}).filter((key) => !META_KEYS.has(key));
  return keys.length === 0;
}

export function jsonValue(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "";
  }
}

function shortValue(value: unknown, max = 80): string {
  const raw = jsonValue(value).replace(/\s+/g, " ").trim();
  if (!raw) {
    return "";
  }
  if (raw.length <= max) {
    return raw;
  }
  return `${raw.slice(0, max - 3)}...`;
}

function fallbackHelpForType(type: string | undefined): string {
  switch (type) {
    case "string":
      return "Enter a text value.";
    case "number":
    case "integer":
      return "Enter a numeric value.";
    case "boolean":
      return "Toggle this setting on or off.";
    case "array":
      return "Manage one or more values.";
    case "object":
      return "Configure grouped settings.";
    default:
      return "Configure this setting.";
  }
}

export function buildHelpText(schema: JsonSchema, explicitHelp?: string): string {
  const help = explicitHelp?.trim() || schema.description?.trim() || "";
  const parts: string[] = [];
  if (help) {
    parts.push(help);
  } else {
    parts.push(fallbackHelpForType(schemaType(schema)));
  }
  if (schema.enum && schema.enum.length > 0) {
    parts.push(
      `Allowed values: ${schema.enum
        .map((entry) => shortValue(entry, 24))
        .filter(Boolean)
        .join(", ")}.`,
    );
  }
  if (schema.default !== undefined) {
    const def = shortValue(schema.default, 60);
    if (def) {
      parts.push(`Default: ${def}.`);
    }
  }
  return parts.join(" ");
}

function positionHelpPopover(details: HTMLDetailsElement): void {
  const doc = details.ownerDocument;
  const view = doc.defaultView;
  const panel = details.querySelector<HTMLElement>(".cfg-help__panel");
  if (!view || !panel) {
    return;
  }

  const viewportPadding = 12;
  const maxWidth = Math.max(180, Math.min(360, view.innerWidth - viewportPadding * 2));
  details.style.setProperty("--cfg-help-max-width", `${maxWidth}px`);

  const triggerRect = details.getBoundingClientRect();
  const panelWidth = Math.min(maxWidth, panel.scrollWidth || maxWidth);
  const leftIfRightAligned = triggerRect.right - panelWidth;
  const rightIfLeftAligned = triggerRect.left + panelWidth;

  let align: "right" | "left" = "right";
  if (
    leftIfRightAligned < viewportPadding &&
    rightIfLeftAligned <= view.innerWidth - viewportPadding
  ) {
    align = "left";
  } else if (
    leftIfRightAligned < viewportPadding &&
    rightIfLeftAligned > view.innerWidth - viewportPadding
  ) {
    const spaceOnLeft = triggerRect.right;
    const spaceOnRight = view.innerWidth - triggerRect.left;
    align = spaceOnRight >= spaceOnLeft ? "left" : "right";
  }

  details.dataset.align = align;
}

export function renderHelpPopover(label: string, helpText: string): TemplateResult {
  return html`
    <details
      class="cfg-help"
      @toggle=${(event: Event) => {
        const details = event.currentTarget as HTMLDetailsElement;
        if (!details.open) {
          delete details.dataset.align;
          return;
        }
        const doc = details.ownerDocument;
        doc.querySelectorAll<HTMLDetailsElement>(".cfg-help[open]").forEach((entry) => {
          if (entry !== details) {
            entry.open = false;
          }
        });
        const alignPopover = () => positionHelpPopover(details);
        alignPopover();
        doc.defaultView?.requestAnimationFrame(alignPopover);
      }}
    >
      <summary
        class="cfg-help__trigger"
        aria-label=${`Help for ${label}`}
        @click=${(event: Event) => event.stopPropagation()}
      >
        ?
      </summary>
      <div class="cfg-help__panel">${helpText}</div>
    </details>
  `;
}

export function renderFieldHeader(
  label: string,
  helpText: string,
  showLabel: boolean,
  showHelp = true,
): TemplateResult | typeof nothing {
  if (!showLabel) {
    return nothing;
  }
  if (!showHelp) {
    return html`
      <div class="cfg-field__header">
        <label class="cfg-field__label">${label}</label>
      </div>
    `;
  }
  return html`
    <div class="cfg-field__header">
      <label class="cfg-field__label">${label}</label>
      ${renderHelpPopover(label, helpText)}
    </div>
  `;
}

export function renderRawFallback(params: {
  schema: JsonSchema;
  value: unknown;
  path: Array<string | number>;
  hints: ConfigUiHints;
  disabled: boolean;
  reason: string;
  showLabel?: boolean;
  onPatch: (path: Array<string | number>, value: unknown) => void;
}): TemplateResult {
  const { schema, value, path, hints, disabled, reason, onPatch } = params;
  const showLabel = params.showLabel ?? true;
  const hint = hintForPath(path, hints);
  const label = hint?.label ?? schema.title ?? humanize(String(path.at(-1)));
  const helpText = buildHelpText(schema, hint?.help);
  const fallback = jsonValue(value);
  return html`
    <div class="cfg-field cfg-field--fallback cfg-item cfg-item--full">
      ${renderFieldHeader(label, helpText, showLabel)}
      <div class="cfg-field__warning">${reason}</div>
      <textarea
        class="cfg-textarea cfg-textarea--sm"
        placeholder="JSON5 value"
        rows="4"
        .value=${fallback}
        ?disabled=${disabled}
        @change=${(event: Event) => {
          const target = event.target as HTMLTextAreaElement;
          const raw = target.value.trim();
          if (!raw) {
            onPatch(path, undefined);
            target.setCustomValidity("");
            return;
          }
          try {
            onPatch(path, JSON5.parse(raw));
            target.setCustomValidity("");
          } catch {
            target.setCustomValidity("Invalid JSON5 value");
            target.reportValidity();
            target.value = fallback;
          }
        }}
      ></textarea>
    </div>
  `;
}

export const icons = {
  chevronDown: html`
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <polyline points="6 9 12 15 18 9"></polyline>
    </svg>
  `,
  plus: html`
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <line x1="12" y1="5" x2="12" y2="19"></line>
      <line x1="5" y1="12" x2="19" y2="12"></line>
    </svg>
  `,
  trash: html`
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <polyline points="3 6 5 6 21 6"></polyline>
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
    </svg>
  `,
};
