import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import type { ConfigUiHints } from "../types.ts";
import { icons } from "../icons.ts";
import { renderConfigForm } from "./config-form.ts";
import {
  ALL_SUBSECTION,
  DIFF_LIMIT,
  analyzeConfigSchemaCached,
  computeDiffScopedCached,
  normalizeIssues,
  renderInfoPopover,
  renderSectionIcon,
  resolveSectionsCached,
  resolveSubsectionsCached,
  sectionHeroHelpText,
  truncateValue,
} from "./config-view-core.ts";
import {
  parseRawJson5,
  RAW_TREE_MAX_CHARS,
  renderRawTreeNode,
  setRawTreeExpanded,
} from "./config-view-raw.ts";
import JSON5 from "json5";
import type { ConfigUiHints } from "../types.ts";
import { icons } from "../icons.ts";
import { hintForPath, humanize, schemaType, type JsonSchema } from "./config-form.shared.ts";
import { analyzeConfigSchema, renderConfigForm, SECTION_META } from "./config-form.ts";

export type ConfigProps = {
  raw: string;
  originalRaw: string;
  valid: boolean | null;
  issues: unknown[];
  loading: boolean;
  saving: boolean;
  applying: boolean;
  updating: boolean;
  connected: boolean;
  schema: unknown;
  schemaLoading: boolean;
  uiHints: ConfigUiHints;
  formMode: "form" | "raw";
  formValue: Record<string, unknown> | null;
  originalValue: Record<string, unknown> | null;
  formDirty?: boolean;
  renderLimit?: number;
  searchQuery: string;
  activeSection: string | null;
  activeSubsection: string | null;
  onRawChange: (next: string) => void;
  onFormModeChange: (mode: "form" | "raw") => void;
  onFormPatch: (path: Array<string | number>, value: unknown) => void;
  onSearchChange: (query: string) => void;
  onSectionChange: (section: string | null) => void;
  onSubsectionChange: (section: string | null) => void;
  onReload: () => void;
  onSave: () => void;
  onApply: () => void;
  onUpdate: () => void;
};

type SearchScore = { score: number; hits: number };

type SectionEntry = {
  key: string;
  label: string;
  description: string;
  schema: JsonSchema;
  order: number;
  search: SearchScore;
};

type SubsectionEntry = {
  key: string;
  label: string;
  description: string;
  schema: JsonSchema;
  order: number;
  search: SearchScore;
};

type ConfigIssueRow = {
  path: string;
  message: string;
};

type DiffEntry = { path: string; from: unknown; to: unknown };

type RawParseState = {
  raw: string;
  value: Record<string, unknown> | null;
  error: string | null;
  errorLine: number | null;
  errorColumn: number | null;
  errorContext: string | null;
};

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

const ALL_SUBSECTION = "__all__";
const DIFF_LIMIT = 120;
const RAW_TREE_MAX_CHARS = 120_000;

const schemaAnalysisCache = new WeakMap<object, ReturnType<typeof analyzeConfigSchema>>();
let sectionsCache:
  | {
      schema: JsonSchema | null;
      uiHints: ConfigUiHints;
      query: string;
      value: SectionEntry[];
    }
  | null = null;
let subsectionsCache:
  | {
      sectionKey: string;
      schema: JsonSchema | undefined;
      uiHints: ConfigUiHints;
      query: string;
      value: SubsectionEntry[];
    }
  | null = null;
const diffCache = new WeakMap<object, WeakMap<object, Map<string, DiffEntry[]>>>();
let rawParseCache: RawParseState | null = null;

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

function sectionHeroHelpText(section: SectionEntry, subsection: SubsectionEntry | null): string {
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

function renderInfoPopover(label: string, helpText: string) {
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

function renderSectionIcon(key: string) {
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

function scoreHintEntries(sectionKey: string, uiHints: ConfigUiHints, tokens: string[]): SearchScore {
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

function analyzeConfigSchemaCached(raw: unknown) {
  if (!raw || typeof raw !== "object") {
    return analyzeConfigSchema(raw);
  }
  const key = raw as object;
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

function resolveSectionsCached(params: {
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

function resolveSubsectionsCached(params: {
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
  let cursor = root;
  for (const segment of path) {
    if (!cursor || typeof cursor !== "object") {
      return undefined;
    }
    cursor = (cursor as Record<string | number, unknown>)[segment];
  }
  return cursor;
}

function diffScopeKey(path: Array<string | number>): string {
  return path.length > 0 ? path.join(".") : "<root>";
}

function computeDiffScoped(
  original: Record<string, unknown>,
  current: Record<string, unknown>,
  scopePath: Array<string | number>,
  limit = DIFF_LIMIT,
): DiffEntry[] {
  const scopedOriginal = readPathValue(original, scopePath);
  const scopedCurrent = readPathValue(current, scopePath);
  const changes: DiffEntry[] = [];
  const basePath = scopePath.join(".");

  function compare(orig: unknown, curr: unknown, path: string) {
    if (changes.length >= limit || orig === curr) {
      return;
    }

    if (typeof orig !== typeof curr) {
      changes.push({ path: path || "<root>", from: orig, to: curr });
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

function computeDiffScopedCached(
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

function truncateValue(value: unknown, maxLen = 52): string {
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

function buildRawErrorContext(raw: string, line: number | null, column: number | null): string | null {
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

function parseRawJson5(raw: string): RawParseState {
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

function setRawTreeExpanded(target: EventTarget | null, expand: boolean): void {
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

function renderRawToken(value: unknown) {
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
    return html`<span class="config-raw-token config-raw-token--null">null</span>`;
  }
  return html`<span class="config-raw-token config-raw-token--unknown">${String(value)}</span>`;
}

function renderRawKey(label: string, indexed = false) {
  const keyText = indexed ? `[${label}]` : JSON.stringify(label);
  const keyClass = indexed ? "config-raw-token--index" : "config-raw-token--key";
  return html`
    <span class="config-raw-token ${keyClass}">${keyText}</span>
    <span class="config-raw-token config-raw-token--punct">:</span>
  `;
}

function renderRawTreeNode(params: {
  value: unknown;
  depth: number;
  label?: string;
  indexed?: boolean;
}) {
  const { value, depth, label, indexed = false } = params;
  const keyTemplate =
    label !== undefined ? html`<span class="config-raw-key">${renderRawKey(label, indexed)}</span>` : nothing;

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
              ? value.map((entry, index) =>
                  renderRawTreeNode({ value: entry, depth: depth + 1, label: String(index), indexed: true }),
                )
              : html`<div class="config-raw-node__empty">empty array</div>`
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
              ? entries.map(([entryKey, entryValue]) =>
                  renderRawTreeNode({ value: entryValue, depth: depth + 1, label: entryKey }),
                )
              : html`<div class="config-raw-node__empty">empty object</div>`
          }
        </div>
      </details>
    `;
  }

  return html`<div class="config-raw-leaf">${keyTemplate}${renderRawToken(value)}</div>`;
}

function normalizeIssues(issues: unknown[]): ConfigIssueRow[] {
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

export function renderConfig(props: ConfigProps) {
  const analysis = analyzeConfigSchemaCached(props.schema);
  const sections = resolveSectionsCached({
    schema: analysis.schema,
    uiHints: props.uiHints,
    searchQuery: props.searchQuery,
  });
  const sectionKeys = new Set(sections.map((section) => section.key));
  const activeSection =
    props.activeSection && sectionKeys.has(props.activeSection) ? props.activeSection : null;
  const activeSectionSchema = activeSection
    ? sections.find((section) => section.key === activeSection)?.schema
    : undefined;
  const activeSectionMeta = activeSection
    ? sections.find((section) => section.key === activeSection)
    : null;

  const subsections = activeSection
    ? resolveSubsectionsCached({
        sectionKey: activeSection,
        schema: activeSectionSchema,
        uiHints: props.uiHints,
        searchQuery: props.searchQuery,
      })
    : [];

  const showSubnav =
    props.formMode === "form" &&
    Boolean(activeSection) &&
    subsections.length > 0 &&
    props.searchQuery.trim().length === 0;

  const isAllSubsection = props.activeSubsection === ALL_SUBSECTION;
  const effectiveSubsection = isAllSubsection ? null : (props.activeSubsection ?? null);
  const activeSubsectionMeta =
    effectiveSubsection && activeSection
      ? (subsections.find((entry) => entry.key === effectiveSubsection) ?? null)
      ? subsections.find((entry) => entry.key === effectiveSubsection) ?? null
      : null;
  const diffScopePath =
    activeSection && activeSubsectionMeta
      ? ([activeSection, activeSubsectionMeta.key] as Array<string | number>)
      : activeSection
        ? ([activeSection] as Array<string | number>)
        : [];
  const formDirty =
    props.formDirty ?? computeDiffScopedCached(props.originalValue, props.formValue, []).length > 0;
    props.formDirty ?? (computeDiffScopedCached(props.originalValue, props.formValue, []).length > 0);
  const hasScopedDiffContext = diffScopePath.length > 0;
  const diff =
    props.formMode === "form" && formDirty && hasScopedDiffContext
      ? computeDiffScopedCached(props.originalValue, props.formValue, diffScopePath)
      : [];
  const hasRawChanges = props.formMode === "raw" && props.raw !== props.originalRaw;
  const hasChanges = props.formMode === "form" ? formDirty : hasRawChanges;
  const showDiffDropdown = props.formMode === "form" && formDirty;
  const formUnsafe = analysis.schema ? analysis.unsupportedPaths.length > 0 : false;
  const rawParse = props.formMode === "raw" ? parseRawJson5(props.raw) : null;
  const rawValidationError = rawParse?.error ?? null;
  const rawTreeUnavailableReason =
    props.formMode === "raw" && props.raw.length > RAW_TREE_MAX_CHARS
      ? `Structured view is disabled for payloads above ${RAW_TREE_MAX_CHARS.toLocaleString()} chars.`
      : rawValidationError
        ? "Fix JSON5 errors to unlock structured view."
        : null;
  const issues = normalizeIssues(props.issues);

  const canSaveForm = Boolean(props.formValue) && !props.loading && Boolean(analysis.schema);
  const canSave =
    props.connected &&
    !props.saving &&
    hasChanges &&
    (props.formMode === "raw" ? !rawValidationError : canSaveForm);
  const canApply =
    props.connected &&
    !props.applying &&
    !props.updating &&
    hasChanges &&
    (props.formMode === "raw" ? !rawValidationError : canSaveForm);
  const canUpdate = props.connected && !props.applying && !props.updating;

  const validity = rawValidationError
    ? "invalid"
    : props.valid == null
      ? "unknown"
      : props.valid
        ? "valid"
        : "invalid";

  return html`
    <div class="config-layout">
      <aside class="config-sidebar">
        <div class="config-sidebar__header">
          <div class="config-sidebar__title">Configuration</div>
          <span
            class="pill pill--sm ${
              validity === "valid" ? "pill--ok" : validity === "invalid" ? "pill--danger" : ""
            }"
            >${validity}</span
          >
        </div>

        <div class="config-search">
          <span class="config-search__icon">${icons.search}</span>
          <input
            type="text"
            class="config-search__input"
            placeholder="Search settings, fields, descriptions..."
            .value=${props.searchQuery}
            @input=${(event: Event) => props.onSearchChange((event.target as HTMLInputElement).value)}
          />
          ${
            props.searchQuery
              ? html`
                  <button class="config-search__clear" @click=${() => props.onSearchChange("")}>
                    Clear
                  </button>
                `
              : nothing
          }
        </div>

        <nav class="config-nav">
          <button
            class="config-nav__item ${activeSection === null ? "active" : ""}"
            @click=${() => props.onSectionChange(null)}
          >
            <span class="config-nav__icon">${icons.settings}</span>
            <span class="config-nav__label">All Settings</span>
            ${
              props.searchQuery
                ? html`<span class="config-nav__meta">${sections.length}</span>`
                : nothing
            }
          </button>

          ${sections.map(
            (section) => html`
              <button
                class="config-nav__item ${activeSection === section.key ? "active" : ""}"
                title=${section.description || section.label}
                @click=${() => props.onSectionChange(section.key)}
              >
                <span class="config-nav__icon">${renderSectionIcon(section.key)}</span>
                <span class="config-nav__label">${section.label}</span>
                ${
                  props.searchQuery
                    ? html`<span class="config-nav__meta">${Math.max(1, section.search.hits)}</span>`
                    : nothing
                }
              </button>
            `,
          )}
        </nav>

        <div class="config-sidebar__footer">
          <div class="config-mode-toggle">
            <button
              class="config-mode-toggle__btn ${props.formMode === "form" ? "active" : ""}"
              ?disabled=${props.schemaLoading || !analysis.schema}
              @click=${() => props.onFormModeChange("form")}
            >
              Form
            </button>
            <button
              class="config-mode-toggle__btn ${props.formMode === "raw" ? "active" : ""}"
              @click=${() => props.onFormModeChange("raw")}
            >
              Raw
            </button>
          </div>
        </div>
      </aside>

      <main class="config-main">
        <div class="config-actions">
          <div class="config-actions__left">
            ${
              hasChanges
                ? html`
                    <span class="config-changes-badge"
                      >${props.formMode === "raw" ? "Unsaved changes" : "Unsaved changes"}</span
                    >
                  `
                : html`
                    <span class="config-status muted">No changes</span>
                      >${
                        props.formMode === "raw"
                          ? "Unsaved changes"
                          : "Unsaved changes"
                      }</span
                    >
                  `
                : html`<span class="config-status muted">No changes</span>`
            }
            ${
              rawValidationError
                ? html`<span class="pill pill--sm pill--danger">Invalid JSON5</span>`
                : nothing
            }
            ${
              showDiffDropdown
                ? html`
                    <details class="config-actions-diff">
                      <summary class="config-actions-diff__trigger">
                        <span>Changes</span>
                        <span class="config-actions-diff__chevron">${icons.arrowDown}</span>
                      </summary>
                      <div class="config-actions-diff__panel">
                        ${
                          hasScopedDiffContext
                            ? html`
                                <div class="config-diff__content">
                                  ${
                                    diff.length > 0
                                      ? diff.map(
                                          (change) => html`
                                            <div class="config-diff__item">
                                              <div class="config-diff__path">${change.path || "<root>"}</div>
                                              <div class="config-diff__values">
                                                <span class="config-diff__from">${truncateValue(change.from)}</span>
                                                <span class="config-diff__arrow">-></span>
                                                <span class="config-diff__to">${truncateValue(change.to)}</span>
                                              </div>
                                            </div>
                                          `,
                                        )
                                      : html`
                                          <div class="config-diff__item">
                                            <div class="config-diff__values">
                                              <span class="config-diff__path"
                                                >No changes in current section. Changes may be in another section.</span
                                              >
                                            </div>
                                          </div>
                                        `
                                  }
                                  ${
                                    diff.length >= DIFF_LIMIT
                                      ? html`
                                          <div class="config-diff__item">
                                            <div class="config-diff__values">
                                              <span class="config-diff__path"
                                                >Showing first ${DIFF_LIMIT} changes for performance.</span
                                              >
                                            </div>
                                          </div>
                                        `
                                      : nothing
                                  }
                                </div>
                              `
                            : html`
                                <div class="config-diff__content">
                                  <div class="config-diff__item">
                                    <div class="config-diff__values">
                                      <span class="config-diff__path">Select a section to view detailed changes.</span>
                                    </div>
                                  </div>
                                </div>
                              `
                        }
                      </div>
                    </details>
                  `
                : nothing
            }
            ${
              rawValidationError
                ? html`
                    <span class="pill pill--sm pill--danger">Invalid JSON5</span>
                  `
                : nothing
            }
            ${
              showDiffDropdown
                ? html`
                    <details class="config-actions-diff">
                      <summary class="config-actions-diff__trigger">
                        <span>Changes</span>
                        <span class="config-actions-diff__chevron">${icons.arrowDown}</span>
                      </summary>
                      <div class="config-actions-diff__panel">
                        ${
                          hasScopedDiffContext
                            ? html`
                                <div class="config-diff__content">
                                  ${
                                    diff.length > 0
                                      ? diff.map(
                                          (change) => html`
                                            <div class="config-diff__item">
                                              <div class="config-diff__path">${change.path || "<root>"}</div>
                                              <div class="config-diff__values">
                                                <span class="config-diff__from">${truncateValue(change.from)}</span>
                                                <span class="config-diff__arrow">-></span>
                                                <span class="config-diff__to">${truncateValue(change.to)}</span>
                                              </div>
                                            </div>
                                          `,
                                        )
                                      : html`
                                          <div class="config-diff__item">
                                            <div class="config-diff__values">
                                              <span class="config-diff__path"
                                                >No changes in current section. Changes may be in another section.</span
                                              >
                                            </div>
                                          </div>
                                        `
                                  }
                                  ${
                                    diff.length >= DIFF_LIMIT
                                      ? html`
                                          <div class="config-diff__item">
                                            <div class="config-diff__values">
                                              <span class="config-diff__path"
                                                >Showing first ${DIFF_LIMIT} changes for performance.</span
                                              >
                                            </div>
                                          </div>
                                        `
                                      : nothing
                                  }
                                </div>
                              `
                            : html`
                                <div class="config-diff__content">
                                  <div class="config-diff__item">
                                    <div class="config-diff__values">
                                      <span class="config-diff__path">Select a section to view detailed changes.</span>
                                    </div>
                                  </div>
                                </div>
                              `
                        }
                      </div>
                    </details>
                  `
                : nothing
            }
          </div>
          <div class="config-actions__right">
            <button class="btn btn--sm" ?disabled=${props.loading} @click=${props.onReload}>
              ${props.loading ? "Loading..." : "Reload"}
            </button>
            <button class="btn btn--sm primary" ?disabled=${!canSave} @click=${props.onSave}>
              ${props.saving ? "Saving..." : "Save"}
            </button>
            <button class="btn btn--sm" ?disabled=${!canApply} @click=${props.onApply}>
              ${props.applying ? "Applying..." : "Apply"}
            </button>
            <button class="btn btn--sm" ?disabled=${!canUpdate} @click=${props.onUpdate}>
              ${props.updating ? "Updating..." : "Update"}
            </button>
          </div>
        </div>

        ${
          activeSectionMeta && props.formMode === "form"
            ? html`
                <div class="config-section-hero">
                  <div class="config-section-hero__lead">
                    <div class="config-section-hero__icon">${renderSectionIcon(activeSectionMeta.key)}</div>
                    <div class="config-section-hero__text">
                      <div class="config-section-hero__title">${activeSectionMeta.label}</div>
                      ${
                        activeSectionMeta.description
                          ? html`<div class="config-section-hero__desc">${activeSectionMeta.description}</div>`
                          : nothing
                      }
                    </div>
                  </div>
                  <div class="config-section-hero__meta">
                    ${keyed(
                      `${activeSectionMeta.key}:${activeSubsectionMeta?.key ?? ALL_SUBSECTION}`,
                      renderInfoPopover(
                        `${activeSectionMeta.label} help`,
                        sectionHeroHelpText(activeSectionMeta, activeSubsectionMeta),
                      ),
                    )}
                  </div>
                </div>
              `
            : nothing
        }

        ${
          showSubnav
            ? html`
                <div class="config-subnav">
                  <button
                    class="config-subnav__item ${effectiveSubsection === null ? "active" : ""}"
                    @click=${() => props.onSubsectionChange(ALL_SUBSECTION)}
                  >
                    All
                  </button>
                  ${subsections.map(
                    (entry) => html`
                      <button
                        class="config-subnav__item ${effectiveSubsection === entry.key ? "active" : ""}"
                        title=${entry.description || entry.label}
                        @click=${() => props.onSubsectionChange(entry.key)}
                      >
                        ${entry.label}
                      </button>
                    `,
                  )}
                </div>
              `
            : nothing
        }

        <div class="config-content">
          ${
            props.formMode === "form"
              ? html`
                  ${
                    props.schemaLoading
                      ? html`
                          <div class="config-loading">
                            <div class="config-loading__spinner"></div>
                            <span>Loading schema...</span>
                          </div>
                        `
                      : renderConfigForm({
                          schema: analysis.schema,
                          uiHints: props.uiHints,
                          value: props.formValue,
                          disabled: props.loading || !props.formValue,
                          unsupportedPaths: analysis.unsupportedPaths,
                          renderLimit: props.renderLimit,
                          onPatch: props.onFormPatch,
                          searchQuery: props.searchQuery,
                          activeSection,
                          activeSubsection: effectiveSubsection,
                        })
                  }
                  ${
                    formUnsafe
                      ? html`
                          <div class="callout" style="margin-top: 12px">
                          <div class="callout" style="margin-top: 12px;">
                            Some advanced fields use JSON5 editors inside Form mode.
                          </div>
                        `
                      : nothing
                  }
                `
              : html`
                  <div class="config-raw-layout">
                    <section class="config-raw-editor">
                      <label class="field config-raw-field">
                        <span>Raw JSON5</span>
                        <textarea
                          wrap="soft"
                          spellcheck="false"
                          .value=${props.raw}
                          @input=${(event: Event) => props.onRawChange((event.target as HTMLTextAreaElement).value)}
                        ></textarea>
                      </label>
                      ${
                        rawValidationError
                          ? html`
                              <div class="callout danger config-raw-error">
                                <strong>JSON5 validation failed:</strong>
                                <div>${rawValidationError}</div>
                                ${
                                  rawParse?.errorLine && rawParse.errorColumn
                                    ? html`
                                        <div class="config-raw-error__meta">
                                          Line ${rawParse.errorLine}, column ${rawParse.errorColumn}
                                        </div>
                                      `
                                    : nothing
                                }
                                ${
                                  rawParse?.errorContext
                                    ? html`
                                        <pre class="config-raw-error__context">${rawParse.errorContext}</pre>
                                      `
                                    : nothing
                                }
                              </div>
                            `
                          : nothing
                      }
                    </section>
                    <section class="config-raw-panel">
                      <div class="config-raw-panel__header">
                        <div class="config-raw-panel__title">Structured view</div>
                        <div class="config-raw-panel__actions">
                          <button
                            type="button"
                            class="config-raw-panel__action"
                            ?disabled=${Boolean(rawTreeUnavailableReason)}
                            @click=${(event: Event) => setRawTreeExpanded(event.currentTarget, true)}
                          >
                            Expand all
                          </button>
                          <button
                            type="button"
                            class="config-raw-panel__action"
                            ?disabled=${Boolean(rawTreeUnavailableReason)}
                            @click=${(event: Event) => setRawTreeExpanded(event.currentTarget, false)}
                          >
                            Collapse all
                          </button>
                        </div>
                      </div>
                      ${
                        rawTreeUnavailableReason
                          ? html`<div class="config-raw-panel__empty">${rawTreeUnavailableReason}</div>`
                          : rawParse?.value
                            ? html`<div class="config-raw-tree">${renderRawTreeNode({ value: rawParse.value, depth: 0 })}</div>`
                            : html`
                                <div class="config-raw-panel__empty">No parsed data to display.</div>
                              `
                            : html`<div class="config-raw-panel__empty">No parsed data to display.</div>`
                      }
                    </section>
                  </div>
                `
          }
        </div>

        ${
          issues.length > 0
            ? html`
                <div class="callout danger config-issues">
                  <div class="config-issues__title">Validation issues</div>
                  <ul class="config-issues__list">
                    ${issues.map(
                      (issue) => html`
                        <li class="config-issues__item">
                          <code>${issue.path}</code>
                          <span>${issue.message}</span>
                        </li>
                      `,
                    )}
                  </ul>
                </div>
              `
            : nothing
        }
      </main>
    </div>
  `;
}
