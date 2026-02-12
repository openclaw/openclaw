import { html } from "lit";
import type { ConfigUiHints } from "../types.ts";
import { icons } from "../icons.ts";
import { hintForPath, humanize, schemaType, type JsonSchema } from "./config-form.shared.ts";
import { analyzeConfigSchema, SECTION_META } from "./config-form.ts";

export type SearchScore = { score: number; hits: number };

export type SectionEntry = {
  key: string;
  label: string;
  description: string;
  schema: JsonSchema;
  order: number;
  search: SearchScore;
};

export type SubsectionEntry = {
  key: string;
  label: string;
  description: string;
  schema: JsonSchema;
  order: number;
  search: SearchScore;
};

export type ConfigIssueRow = {
  path: string;
  message: string;
};

export type DiffEntry = { path: string; from: unknown; to: unknown };

const KNOWN_SECTION_ORDER = [
  "env",
  "update",
  "diagnostics",
  "logging",
  "gateway",
  "nodeHost",
  "agents",
  "tools",
  "bindings",
  "audio",
  "models",
  "messages",
  "commands",
  "session",
  "cron",
  "hooks",
  "ui",
  "browser",
  "talk",
  "channels",
  "skills",
  "plugins",
  "discovery",
  "presence",
  "voicewake",
  "wizard",
] as const;

const KNOWN_ORDER_MAP = new Map<string, number>(
  KNOWN_SECTION_ORDER.map((key, index) => [key, index * 10 + 10]),
);

export const ALL_SUBSECTION = "__all__";
export const DIFF_LIMIT = 120;

const schemaAnalysisCache = new WeakMap<object, ReturnType<typeof analyzeConfigSchema>>();
let sectionsCache: {
  schema: JsonSchema | null;
  uiHints: ConfigUiHints;
  query: string;
  value: SectionEntry[];
} | null = null;
let subsectionsCache: {
  sectionKey: string;
  schema: JsonSchema | undefined;
  uiHints: ConfigUiHints;
  query: string;
  value: SubsectionEntry[];
} | null = null;
const diffCache = new WeakMap<object, WeakMap<object, Map<string, DiffEntry[]>>>();

function normalizeConfigKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[\s._-]+/g, "");
}

function canonicalDocKey(raw: string): string {
  switch (raw) {
    case "channel":
      return "channels";
    case "agent":
      return "agents";
    case "tool":
      return "tools";
    case "model":
      return "models";
    case "command":
      return "commands";
    case "skill":
      return "skills";
    case "plugin":
      return "plugins";
    case "discover":
      return "discovery";
    case "voice":
      return "talk";
    case "onboarding":
      return "wizard";
    case "authentication":
    case "credentials":
      return "auth";
    case "node":
    case "nodes":
      return "nodehost";
    case "canvas":
      return "canvashost";
    default:
      return raw;
  }
}

// Summaries distilled from docs/gateway/configuration.md and related docs/channels/*.
const SECTION_DOC_HELP: Record<string, string> = {
  env: "From docs: environment variable sources, shellEnv import, and ${VAR} substitution in config.",
  update: "From docs: update channel and auto-update policy for runtime components.",
  diagnostics: "From docs: diagnostics and health-check surfaces used for troubleshooting.",
  logging: "From docs: log levels, log file path, console format, and sensitive data redaction.",
  gateway: "From docs: Gateway mode/bind/auth/port settings and config reload behavior.",
  nodehost: "From docs: node host connection and runtime settings for attached nodes.",
  agents: "From docs: agent list/defaults, workspace/repoRoot, and multi-agent behavior.",
  tools: "From docs: tool settings and controls for tool invocation behavior.",
  bindings: "From docs: routing bindings that map channels/sources to agents.",
  audio: "From docs: audio input/output parameters and voice data handling.",
  models: "From docs: model providers, base URLs, credentials, and routing options.",
  messages: "From docs: inbound/queue/group-message behavior and delivery controls.",
  commands: "From docs: chat command handling rules and command routing behavior.",
  session: "From docs: session persistence, context windows, and conversation state handling.",
  cron: "From docs: Gateway scheduler configuration for periodic tasks.",
  hooks: "From docs: Gateway webhook integrations and outbound hook behavior.",
  ui: "From docs: control UI and appearance-related behavior.",
  browser: "From docs: openclaw-managed browser automation runtime settings.",
  talk: "From docs: talk mode, speech pipeline, and voice behavior settings.",
  channels: "From docs: channel transports, accounts, DM/group policies, and channel behavior.",
  skills: "From docs: skills configuration and skill runtime controls.",
  plugins: "From docs: extension/plugin loading and runtime plugin behavior.",
  discovery: "From docs: mDNS and wide-area discovery settings for gateway discovery.",
  presence: "From docs: presence and broadcast visibility behavior.",
  voicewake: "From docs: wake-word and voice wake forwarding settings.",
  wizard: "From docs: onboarding wizard metadata written by CLI flows.",
  web: "From docs: runtime settings for web-based channels including WhatsApp web.",
  auth: "From docs: auth profile metadata, provider order, and auth mode selection.",
  canvashost: "From docs: Canvas Host LAN/tailnet file serving and live reload.",
};

function sectionDocHelp(sectionKey: string | null, sectionLabel = "Section"): string {
  if (!sectionKey) {
    return "Shows all configuration sections and their key controls.";
  }
  const normalized = canonicalDocKey(normalizeConfigKey(sectionKey));
  return (
    SECTION_DOC_HELP[normalized] ??
    `From docs: "${sectionLabel}" controls runtime behavior for this OpenClaw module.`
  );
}

function summarizeSchema(label: string, schema: JsonSchema): string {
  const type = schemaType(schema);
  if (schema.enum && schema.enum.length > 0) {
    const values = schema.enum
      .slice(0, 4)
      .map((value) => String(value))
      .join(", ");
    return `Allowed values include: ${values}${schema.enum.length > 4 ? ", ..." : ""}.`;
  }
  if (type === "object") {
    const keys = Object.keys(schema.properties ?? {});
    if (keys.length > 0) {
      const preview = keys
        .slice(0, 4)
        .map((key) => humanize(key))
        .join(", ");
      return `${label} contains: ${preview}${keys.length > 4 ? ", ..." : ""}.`;
    }
    if (schema.additionalProperties) {
      return `${label} supports custom key/value entries.`;
    }
    return `${label} contains nested options.`;
  }
  if (type === "array") {
    const items = Array.isArray(schema.items) ? schema.items[0] : schema.items;
    const itemType = items ? schemaType(items) : undefined;
    return `${label} manages a list${itemType ? ` of ${itemType} entries` : ""}.`;
  }
  if (type === "boolean") {
    return `${label} is an on/off toggle.`;
  }
  if (type === "number" || type === "integer") {
    return `${label} expects a numeric value.`;
  }
  if (type === "string") {
    return `${label} expects a text value.`;
  }
  return `${label} controls this part of configuration.`;
}

export function sectionHeroHelpText(
  section: SectionEntry,
  subsection: SubsectionEntry | null,
): string {
  const sectionHelp = sectionDocHelp(section.key, section.label);
  if (subsection) {
    const detail = subsection.description.trim();
    const summary = summarizeSchema(subsection.label, subsection.schema);
    if (detail.length > 0) {
      return `${sectionHelp} Current block "${subsection.label}": ${detail} ${summary}`;
    }
    return `${sectionHelp} Current block "${subsection.label}". ${summary}`;
  }
  const detail = section.description.trim();
  const summary = summarizeSchema(section.label, section.schema);
  if (detail.length > 0) {
    return `${sectionHelp} ${detail} ${summary}`;
  }
  return `${sectionHelp} ${summary}`;
}

function positionInfoPopover(details: HTMLDetailsElement): void {
  const doc = details.ownerDocument;
  const view = doc.defaultView;
  const panel = details.querySelector<HTMLElement>(".config-help__panel");
  if (!view || !panel) {
    return;
  }

  const viewportPadding = 12;
  const maxWidth = Math.max(220, Math.min(420, view.innerWidth - viewportPadding * 2));
  panel.style.maxWidth = `${maxWidth}px`;

  const triggerRect = details.getBoundingClientRect();
  const panelWidth = Math.min(maxWidth, panel.scrollWidth || maxWidth);
  const panelHeight = panel.scrollHeight;
  const left = Math.max(
    viewportPadding,
    Math.min(view.innerWidth - panelWidth - viewportPadding, triggerRect.right - panelWidth),
  );
  const top = Math.min(
    view.innerHeight - Math.min(panelHeight, 320) - viewportPadding,
    triggerRect.bottom + 8,
  );

  details.style.setProperty("--config-help-left", `${Math.max(left, viewportPadding)}px`);
  details.style.setProperty("--config-help-top", `${Math.max(top, viewportPadding)}px`);
}

export function renderInfoPopover(label: string, helpText: string) {
  return html`
    <details
      class="config-help"
      @toggle=${(event: Event) => {
        const details = event.currentTarget as HTMLDetailsElement;
        if (!details.open) {
          return;
        }
        const doc = details.ownerDocument;
        doc.querySelectorAll<HTMLDetailsElement>(".config-help[open]").forEach((entry) => {
          if (entry !== details) {
            entry.open = false;
          }
        });
        const alignPopover = () => positionInfoPopover(details);
        alignPopover();
        doc.defaultView?.requestAnimationFrame(alignPopover);
      }}
    >
      <summary
        class="config-help__trigger"
        aria-label=${`Help for ${label}`}
        @click=${(event: Event) => event.stopPropagation()}
      >
        ?
      </summary>
      <div class="config-help__panel">${helpText}</div>
    </details>
  `;
}

export function renderSectionIcon(key: string) {
  const normalized = normalizeConfigKey(key);
  switch (normalized) {
    case "env":
      return icons.settings;
    case "diagnostics":
    case "debug":
      return icons.bug;
    case "logging":
      return icons.scrollText;
    case "meta":
      return icons.edit;
    case "node":
    case "nodehost":
    case "nodes":
      return icons.monitor;
    case "channel":
    case "channels":
      return icons.messageSquare;
    case "agent":
    case "agents":
      return icons.folder;
    case "authentication":
    case "credentials":
    case "auth":
      return icons.plug;
    case "memory":
    case "history":
      return icons.fileText;
    case "message":
    case "messages":
      return icons.messageSquare;
    case "command":
    case "commands":
      return icons.fileCode;
    case "webhooks":
    case "hooks":
      return icons.link;
    case "skill":
    case "skills":
      return icons.zap;
    case "tool":
    case "tools":
      return icons.wrench;
    case "sessions":
    case "session":
      return icons.fileText;
    case "scheduler":
    case "schedule":
    case "cron":
      return icons.loader;
    case "broadcast":
    case "presence":
      return icons.radio;
    case "audio":
    case "voice":
    case "talk":
      return icons.smartphone;
    case "ux":
    case "ui":
    case "bindings":
      return icons.settings;
    case "model":
    case "models":
      return icons.barChart;
    case "browser":
      return icons.monitor;
    case "onboarding":
    case "wizard":
      return icons.loader;
    case "canvas":
    case "canvashost":
      return icons.image;
    case "plugin":
    case "plugins":
      return icons.puzzle;
    case "update":
      return icons.arrowDown;
    case "gateway":
    case "web":
    case "discover":
    case "discovery":
      return icons.globe;
    case "wakeword":
    case "voicewake":
      return icons.smartphone;
    default:
      return icons.settings;
  }
}

function normalizeSectionMeta(
  key: string,
  schema: JsonSchema,
  uiHints: ConfigUiHints,
): { label: string; description: string } {
  const hint = hintForPath([key], uiHints);
  const fromMeta = SECTION_META[key];
  return {
    label: hint?.label ?? fromMeta?.label ?? schema.title ?? humanize(key),
    description: hint?.help ?? fromMeta?.description ?? schema.description ?? "",
  };
}

function tokenizeSearch(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function scoreText(text: string, tokens: string[]): SearchScore {
  if (!text || tokens.length === 0) {
    return { score: 0, hits: 0 };
  }
  const value = text.toLowerCase();
  let score = 0;
  let hits = 0;
  for (const token of tokens) {
    if (!token) {
      continue;
    }
    if (value === token) {
      score += 120;
      hits += 1;
      continue;
    }
    if (value.startsWith(token)) {
      score += 80;
      hits += 1;
      continue;
    }
    if (value.includes(token)) {
      score += 40;
      hits += 1;
    }
  }
  return { score, hits };
}

function mergeScores(a: SearchScore, b: SearchScore): SearchScore {
  return {
    score: a.score + b.score,
    hits: a.hits + b.hits,
  };
}

function scoreSchema(schema: JsonSchema, tokens: string[], depth = 0): SearchScore {
  if (!schema || tokens.length === 0 || depth > 6) {
    return { score: 0, hits: 0 };
  }
  let result = { score: 0, hits: 0 };
  result = mergeScores(result, scoreText(schema.title ?? "", tokens));
  result = mergeScores(result, scoreText(schema.description ?? "", tokens));
  if (schema.enum) {
    for (const entry of schema.enum) {
      result = mergeScores(result, scoreText(String(entry), tokens));
    }
  }
  if (schema.properties) {
    for (const [key, node] of Object.entries(schema.properties)) {
      result = mergeScores(result, scoreText(key, tokens));
      result = mergeScores(result, scoreSchema(node, tokens, depth + 1));
    }
  }
  if (schema.items) {
    const items = Array.isArray(schema.items) ? schema.items : [schema.items];
    for (const item of items) {
      result = mergeScores(result, scoreSchema(item, tokens, depth + 1));
    }
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    result = mergeScores(result, scoreSchema(schema.additionalProperties, tokens, depth + 1));
  }
  for (const union of [schema.anyOf, schema.oneOf, schema.allOf]) {
    if (!union) {
      continue;
    }
    for (const entry of union) {
      result = mergeScores(result, scoreSchema(entry, tokens, depth + 1));
    }
  }
  return result;
}

function scoreHintEntries(
  sectionKey: string,
  uiHints: ConfigUiHints,
  tokens: string[],
): SearchScore {
  if (tokens.length === 0) {
    return { score: 0, hits: 0 };
  }
  let result = { score: 0, hits: 0 };
  const prefix = `${sectionKey}.`;
  for (const [path, hint] of Object.entries(uiHints)) {
    if (!path.startsWith(prefix)) {
      continue;
    }
    result = mergeScores(result, scoreText(path.slice(prefix.length), tokens));
    if (hint.label) {
      result = mergeScores(result, scoreText(hint.label, tokens));
    }
    if (hint.help) {
      result = mergeScores(result, scoreText(hint.help, tokens));
    }
  }
  return result;
}

function scoreSection(params: {
  key: string;
  schema: JsonSchema;
  uiHints: ConfigUiHints;
  label: string;
  description: string;
  tokens: string[];
}): SearchScore {
  const { key, schema, uiHints, label, description, tokens } = params;
  if (tokens.length === 0) {
    return { score: 0, hits: 0 };
  }
  let result = { score: 0, hits: 0 };
  result = mergeScores(result, scoreText(key, tokens));
  result = mergeScores(result, scoreText(label, tokens));
  result = mergeScores(result, scoreText(description, tokens));
  result = mergeScores(result, scoreHintEntries(key, uiHints, tokens));
  result = mergeScores(result, scoreSchema(schema, tokens));
  return result;
}

export function analyzeConfigSchemaCached(raw: unknown) {
  if (!raw || typeof raw !== "object") {
    return analyzeConfigSchema(raw);
  }
  const key = raw;
  const cached = schemaAnalysisCache.get(key);
  if (cached) {
    return cached;
  }
  const analysis = analyzeConfigSchema(raw);
  schemaAnalysisCache.set(key, analysis);
  return analysis;
}

function resolveSections(params: {
  schema: JsonSchema | null;
  uiHints: ConfigUiHints;
  searchQuery: string;
}): SectionEntry[] {
  const { schema, uiHints, searchQuery } = params;
  if (!schema || schemaType(schema) !== "object" || !schema.properties) {
    return [];
  }
  const tokens = tokenizeSearch(searchQuery);
  const items: SectionEntry[] = [];
  for (const [key, node] of Object.entries(schema.properties)) {
    const meta = normalizeSectionMeta(key, node, uiHints);
    const order = hintForPath([key], uiHints)?.order ?? KNOWN_ORDER_MAP.get(key) ?? 9999;
    const search = scoreSection({
      key,
      schema: node,
      uiHints,
      label: meta.label,
      description: meta.description,
      tokens,
    });
    if (tokens.length > 0 && search.score <= 0) {
      continue;
    }
    items.push({
      key,
      label: meta.label,
      description: meta.description,
      schema: node,
      order,
      search,
    });
  }
  items.sort((a, b) => {
    if (tokens.length > 0) {
      if (a.search.score !== b.search.score) {
        return b.search.score - a.search.score;
      }
      if (a.search.hits !== b.search.hits) {
        return b.search.hits - a.search.hits;
      }
    }
    if (a.order !== b.order) {
      return a.order - b.order;
    }
    return a.label.localeCompare(b.label);
  });
  return items;
}

export function resolveSectionsCached(params: {
  schema: JsonSchema | null;
  uiHints: ConfigUiHints;
  searchQuery: string;
}): SectionEntry[] {
  if (
    sectionsCache &&
    sectionsCache.schema === params.schema &&
    sectionsCache.uiHints === params.uiHints &&
    sectionsCache.query === params.searchQuery
  ) {
    return sectionsCache.value;
  }
  const value = resolveSections(params);
  sectionsCache = {
    schema: params.schema,
    uiHints: params.uiHints,
    query: params.searchQuery,
    value,
  };
  return value;
}

function resolveSubsections(params: {
  sectionKey: string;
  schema: JsonSchema | undefined;
  uiHints: ConfigUiHints;
  searchQuery: string;
}): SubsectionEntry[] {
  const { sectionKey, schema, uiHints, searchQuery } = params;
  if (!schema || schemaType(schema) !== "object" || !schema.properties) {
    return [];
  }
  const tokens = tokenizeSearch(searchQuery);
  const entries: SubsectionEntry[] = [];
  for (const [key, node] of Object.entries(schema.properties)) {
    const hint = hintForPath([sectionKey, key], uiHints);
    const label = hint?.label ?? node.title ?? humanize(key);
    const description = hint?.help ?? node.description ?? "";
    const order = hint?.order ?? 50;
    const search = mergeScores(
      mergeScores(scoreText(key, tokens), scoreText(label, tokens)),
      mergeScores(scoreText(description, tokens), scoreSchema(node, tokens)),
    );
    if (tokens.length > 0 && search.score <= 0) {
      continue;
    }
    entries.push({ key, label, description, schema: node, order, search });
  }
  entries.sort((a, b) => {
    if (tokens.length > 0) {
      if (a.search.score !== b.search.score) {
        return b.search.score - a.search.score;
      }
      if (a.search.hits !== b.search.hits) {
        return b.search.hits - a.search.hits;
      }
    }
    if (a.order !== b.order) {
      return a.order - b.order;
    }
    return a.label.localeCompare(b.label);
  });
  return entries;
}

export function resolveSubsectionsCached(params: {
  sectionKey: string;
  schema: JsonSchema | undefined;
  uiHints: ConfigUiHints;
  searchQuery: string;
}): SubsectionEntry[] {
  if (
    subsectionsCache &&
    subsectionsCache.sectionKey === params.sectionKey &&
    subsectionsCache.schema === params.schema &&
    subsectionsCache.uiHints === params.uiHints &&
    subsectionsCache.query === params.searchQuery
  ) {
    return subsectionsCache.value;
  }
  const value = resolveSubsections(params);
  subsectionsCache = {
    sectionKey: params.sectionKey,
    schema: params.schema,
    uiHints: params.uiHints,
    query: params.searchQuery,
    value,
  };
  return value;
}

function readPathValue(root: unknown, path: Array<string | number>): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[String(segment)];
  }
  return current;
}

function diffScopeKey(path: Array<string | number>): string {
  return path.length > 0 ? path.map((segment) => String(segment)).join(".") : "<root>";
}

function computeDiffScoped(
  original: Record<string, unknown> | null,
  current: Record<string, unknown> | null,
  scopePath: Array<string | number>,
  limit = DIFF_LIMIT,
): DiffEntry[] {
  if (!original || !current) {
    return [];
  }

  const scopedOriginal =
    scopePath.length > 0 ? readPathValue(original, scopePath) : (original as unknown);
  const scopedCurrent =
    scopePath.length > 0 ? readPathValue(current, scopePath) : (current as unknown);
  const basePath = scopePath.length > 0 ? scopePath.join(".") : "";
  const changes: DiffEntry[] = [];

  function compare(orig: unknown, curr: unknown, path: string) {
    if (changes.length >= limit) {
      return;
    }
    if (orig === curr) {
      return;
    }
    if (typeof orig !== "object" || orig === null || curr === null) {
      changes.push({ path: path || "<root>", from: orig, to: curr });
      return;
    }
    if (Array.isArray(orig) && Array.isArray(curr)) {
      if (orig.length !== curr.length) {
        changes.push({ path: path || "<root>", from: orig, to: curr });
        return;
      }
      for (let index = 0; index < orig.length; index += 1) {
        compare(orig[index], curr[index], path ? `${path}.${index}` : String(index));
        if (changes.length >= limit) {
          return;
        }
      }
      return;
    }
    if (Array.isArray(orig) !== Array.isArray(curr)) {
      changes.push({ path: path || "<root>", from: orig, to: curr });
      return;
    }
    const origObj = orig as Record<string, unknown>;
    const currObj = curr as Record<string, unknown>;
    const allKeys = new Set([...Object.keys(origObj), ...Object.keys(currObj)]);
    for (const key of allKeys) {
      compare(origObj[key], currObj[key], path ? `${path}.${key}` : key);
      if (changes.length >= limit) {
        return;
      }
    }
  }

  compare(scopedOriginal, scopedCurrent, basePath);
  return changes;
}

export function computeDiffScopedCached(
  original: Record<string, unknown> | null,
  current: Record<string, unknown> | null,
  scopePath: Array<string | number>,
): DiffEntry[] {
  if (!original || !current) {
    return [];
  }
  const key = diffScopeKey(scopePath);
  let currentMap = diffCache.get(original);
  if (!currentMap) {
    currentMap = new WeakMap<object, Map<string, DiffEntry[]>>();
    diffCache.set(original, currentMap);
  }
  let scopeMap = currentMap.get(current);
  if (!scopeMap) {
    scopeMap = new Map<string, DiffEntry[]>();
    currentMap.set(current, scopeMap);
  }
  const cached = scopeMap.get(key);
  if (cached) {
    return cached;
  }
  const value = computeDiffScoped(original, current, scopePath, DIFF_LIMIT);
  scopeMap.set(key, value);
  return value;
}

export function truncateValue(value: unknown, maxLen = 52): string {
  let str: string;
  try {
    const json = JSON.stringify(value);
    str = json ?? String(value);
  } catch {
    str = String(value);
  }
  if (str.length <= maxLen) {
    return str;
  }
  return `${str.slice(0, maxLen - 3)}...`;
}

export function normalizeIssues(issues: unknown[]): ConfigIssueRow[] {
  const rows: ConfigIssueRow[] = [];
  for (const issue of issues) {
    if (issue && typeof issue === "object") {
      const path =
        typeof (issue as { path?: unknown }).path === "string"
          ? (issue as { path: string }).path || "<root>"
          : "<root>";
      const message =
        typeof (issue as { message?: unknown }).message === "string"
          ? (issue as { message: string }).message
          : JSON.stringify(issue);
      rows.push({ path, message });
      continue;
    }
    rows.push({ path: "<root>", message: String(issue) });
  }
  return rows;
}
