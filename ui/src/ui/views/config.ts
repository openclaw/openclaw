import { html, nothing } from "lit";

import { toast } from "../components/toast";
import { icon } from "../icons";
import type { ConfigUiHints } from "../types";
import { analyzeConfigSchema, renderConfigForm, SECTION_META } from "./config-form";
import {
  pathKey,
  hintForPath,
  humanize,
  schemaType,
  type ConfigIssueSeverity,
  type ConfigValidationIssue,
  type ConfigValidationMap,
  type JsonSchema,
} from "./config-form.shared";

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
  schema: unknown | null;
  schemaLoading: boolean;
  uiHints: ConfigUiHints;
  formMode: "form" | "raw";
  formValue: Record<string, unknown> | null;
  originalValue: Record<string, unknown> | null;
  searchQuery: string;
  activeSection: string | null;
  activeSubsection: string | null;
  // New: Quick setup state
  showQuickSetup: boolean;
  onRawChange: (next: string) => void;
  onFormModeChange: (mode: "form" | "raw") => void;
  onFormPatch: (path: Array<string | number>, value: unknown) => void;
  onSearchChange: (query: string) => void;
  onSectionChange: (section: string | null) => void;
  onSubsectionChange: (section: string | null) => void;
  onReload: () => void;
  onToggleQuickSetup?: () => void;
  onSave: () => void;
  onApply: () => void;
  onUpdate: () => void;
};

// SVG Icons for sidebar (Lucide-style)
const sidebarIcons = {
  all: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>`,
  env: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,
  update: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`,
  agents: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"></path><circle cx="8" cy="14" r="1"></circle><circle cx="16" cy="14" r="1"></circle></svg>`,
  auth: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`,
  channels: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`,
  messages: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>`,
  commands: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>`,
  hooks: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>`,
  skills: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`,
  tools: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>`,
  gateway: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`,
  wizard: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 4V2"></path><path d="M15 16v-2"></path><path d="M8 9h2"></path><path d="M20 9h2"></path><path d="M17.8 11.8 19 13"></path><path d="M15 9h0"></path><path d="M17.8 6.2 19 5"></path><path d="m3 21 9-9"></path><path d="M12.2 6.2 11 5"></path></svg>`,
  // Additional sections
  meta: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>`,
  logging: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>`,
  browser: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="4"></circle><line x1="21.17" y1="8" x2="12" y2="8"></line><line x1="3.95" y1="6.06" x2="8.54" y2="14"></line><line x1="10.88" y1="21.94" x2="15.46" y2="14"></line></svg>`,
  ui: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>`,
  models: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>`,
  bindings: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect><rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>`,
  broadcast: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"></path><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"></path><circle cx="12" cy="12" r="2"></circle><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"></path><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"></path></svg>`,
  audio: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`,
  session: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`,
  cron: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`,
  web: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`,
  discovery: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,
  canvasHost: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`,
  talk: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`,
  plugins: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v6"></path><path d="m4.93 10.93 4.24 4.24"></path><path d="M2 12h6"></path><path d="m4.93 13.07 4.24-4.24"></path><path d="M12 22v-6"></path><path d="m19.07 13.07-4.24-4.24"></path><path d="M22 12h-6"></path><path d="m19.07 10.93-4.24 4.24"></path></svg>`,
  default: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`,
};

// Section definitions
const SECTIONS: Array<{ key: string; label: string }> = [
  { key: "env", label: "Environment" },
  { key: "update", label: "Updates" },
  { key: "agents", label: "Agents" },
  { key: "auth", label: "Authentication" },
  { key: "channels", label: "Channels" },
  { key: "messages", label: "Messages" },
  { key: "commands", label: "Commands" },
  { key: "hooks", label: "Hooks" },
  { key: "skills", label: "Skills" },
  { key: "tools", label: "Tools" },
  { key: "gateway", label: "Gateway" },
  { key: "wizard", label: "Setup Wizard" },
];

type SubsectionEntry = {
  key: string;
  label: string;
  description?: string;
  order: number;
};

const ALL_SUBSECTION = "__all__";

type NormalizedConfigIssue = {
  severity: ConfigIssueSeverity;
  message: string;
  path: Array<string | number> | null;
  sectionKey: string | null;
  raw: unknown;
};

function normalizeIssueSeverity(raw: unknown): ConfigIssueSeverity {
  const s = String(raw ?? "").toLowerCase();
  if (s.includes("warn")) return "warn";
  if (s.includes("info")) return "info";
  if (s.includes("error")) return "error";
  return "error";
}

function parsePathSegments(raw: unknown): Array<string | number> | null {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    const out: Array<string | number> = [];
    for (const seg of raw) {
      if (typeof seg === "string" || typeof seg === "number") out.push(seg);
      else if (seg != null) out.push(String(seg));
    }
    return out.length ? out : null;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("/")) {
      const parts = trimmed.split("/").filter(Boolean).map(decodeURIComponent);
      return parts.length ? parts : null;
    }
    if (trimmed.includes(".")) {
      const parts = trimmed.split(".").filter(Boolean);
      return parts.length ? parts : null;
    }
    return [trimmed];
  }
  return null;
}

function normalizeIssue(issue: unknown): NormalizedConfigIssue {
  // Default: preserve the raw issue and show it in details.
  let severity: ConfigIssueSeverity = "error";
  let message = "";
  let path: Array<string | number> | null = null;

  if (typeof issue === "string") {
    message = issue;
  } else if (issue && typeof issue === "object") {
    const obj = issue as Record<string, unknown>;
    severity =
      normalizeIssueSeverity(obj.severity ?? obj.level ?? obj.type ?? obj.kind ?? "error");

    const msgCandidate =
      obj.message ??
      obj.msg ??
      obj.error ??
      obj.summary ??
      obj.reason ??
      obj.keyword;
    message = msgCandidate != null ? String(msgCandidate) : "";

    // Common JSON schema validator shapes (Ajv-style).
    path =
      parsePathSegments(obj.path) ??
      parsePathSegments(obj.instancePath) ??
      parsePathSegments(obj.dataPath) ??
      parsePathSegments(obj.pointer) ??
      parsePathSegments(obj.field) ??
      null;

    if (!message) {
      try {
        message = JSON.stringify(issue);
      } catch {
        message = String(issue);
      }
    }
  } else {
    message = String(issue);
  }

  const sectionKey =
    path && path.length > 0 && typeof path[0] === "string" ? String(path[0]) : null;

  return {
    severity,
    message,
    path,
    sectionKey,
    raw: issue,
  };
}

function applyDiagnosticsFilters(dialog: HTMLElement) {
  const filter = (dialog.getAttribute("data-diag-filter") ?? "all").toLowerCase();
  const q = (dialog.getAttribute("data-diag-query") ?? "").toLowerCase();
  const items = Array.from(dialog.querySelectorAll("[data-diag-item]")) as HTMLElement[];

  for (const el of items) {
    const sev = (el.getAttribute("data-diag-sev") ?? "").toLowerCase();
    const text = (el.getAttribute("data-diag-text") ?? "").toLowerCase();
    const matchesSev = filter === "all" || sev === filter;
    const matchesQuery = !q || text.includes(q);
    el.hidden = !(matchesSev && matchesQuery);
  }

  // Hide empty groups.
  const groups = Array.from(dialog.querySelectorAll("[data-diag-group]")) as HTMLElement[];
  for (const group of groups) {
    const groupItems = Array.from(group.querySelectorAll("[data-diag-item]")) as HTMLElement[];
    group.hidden = !groupItems.some((i) => !i.hidden);
  }

  const visible = items.filter((i) => !i.hidden).length;
  const total = items.length;
  const counter = dialog.querySelector("#config-diagnostics-count") as HTMLElement | null;
  if (counter) counter.textContent = `Showing ${visible} of ${total}`;
}

function getSectionIcon(key: string) {
  return sidebarIcons[key as keyof typeof sidebarIcons] ?? sidebarIcons.default;
}

function resolveSectionMeta(key: string, schema?: JsonSchema): {
  label: string;
  description?: string;
} {
  const meta = SECTION_META[key];
  if (meta) return meta;
  return {
    label: schema?.title ?? humanize(key),
    description: schema?.description ?? "",
  };
}

function resolveSubsections(params: {
  key: string;
  schema: JsonSchema | undefined;
  uiHints: ConfigUiHints;
}): SubsectionEntry[] {
  const { key, schema, uiHints } = params;
  if (!schema || schemaType(schema) !== "object" || !schema.properties) return [];
  const entries = Object.entries(schema.properties).map(([subKey, node]) => {
    const hint = hintForPath([key, subKey], uiHints);
    const label = hint?.label ?? node.title ?? humanize(subKey);
    const description = hint?.help ?? node.description ?? "";
    const order = hint?.order ?? 50;
    return { key: subKey, label, description, order };
  });
  entries.sort((a, b) => (a.order !== b.order ? a.order - b.order : a.key.localeCompare(b.key)));
  return entries;
}

function computeDiff(
  original: Record<string, unknown> | null,
  current: Record<string, unknown> | null
): Array<{ path: string; from: unknown; to: unknown }> {
  if (!original || !current) return [];
  const changes: Array<{ path: string; from: unknown; to: unknown }> = [];

  function compare(orig: unknown, curr: unknown, path: string) {
    if (orig === curr) return;
    if (typeof orig !== typeof curr) {
      changes.push({ path, from: orig, to: curr });
      return;
    }
    if (typeof orig !== "object" || orig === null || curr === null) {
      if (orig !== curr) {
        changes.push({ path, from: orig, to: curr });
      }
      return;
    }
    if (Array.isArray(orig) && Array.isArray(curr)) {
      if (JSON.stringify(orig) !== JSON.stringify(curr)) {
        changes.push({ path, from: orig, to: curr });
      }
      return;
    }
    const origObj = orig as Record<string, unknown>;
    const currObj = curr as Record<string, unknown>;
    const allKeys = new Set([...Object.keys(origObj), ...Object.keys(currObj)]);
    for (const key of allKeys) {
      compare(origObj[key], currObj[key], path ? `${path}.${key}` : key);
    }
  }

  compare(original, current, "");
  return changes;
}

function truncateValue(value: unknown, maxLen = 40): string {
  let str: string;
  try {
    const json = JSON.stringify(value);
    str = json ?? String(value);
  } catch {
    str = String(value);
  }
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

function copyText(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).then(() => {
      toast.success("Copied to clipboard");
    });
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-10000px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
  toast.success("Copied to clipboard");
}

type DiffChunk = { type: "equal" | "insert" | "delete"; lines: string[] };

// Minimal line diff (LCS). Good enough for config-sized documents.
function diffLines(aText: string, bText: string): DiffChunk[] {
  const a = aText.split("\n");
  const b = bText.split("\n");
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  );

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const chunks: DiffChunk[] = [];
  const push = (type: DiffChunk["type"], line: string) => {
    const last = chunks[chunks.length - 1];
    if (last && last.type === type) last.lines.push(line);
    else chunks.push({ type, lines: [line] });
  };

  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      push("equal", a[i]);
      i++;
      j++;
      continue;
    }
    if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("delete", a[i]);
      i++;
      continue;
    }
    push("insert", b[j]);
    j++;
  }
  while (i < m) {
    push("delete", a[i]);
    i++;
  }
  while (j < n) {
    push("insert", b[j]);
    j++;
  }

  return chunks;
}

function formatUnifiedDiff(params: {
  fromLabel: string;
  toLabel: string;
  fromText: string;
  toText: string;
}): string {
  const { fromLabel, toLabel, fromText, toText } = params;
  if (fromText === toText) return "";
  const chunks = diffLines(fromText, toText);
  const out: string[] = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  for (const chunk of chunks) {
    const prefix =
      chunk.type === "equal" ? " " : chunk.type === "delete" ? "-" : "+";
    for (const line of chunk.lines) out.push(prefix + line);
  }
  return out.join("\n");
}

export function setupConfigKeyboardShortcuts(props: {
  getFormMode: () => "form" | "raw";
  getSearchQuery: () => string;
  getCanSave: () => boolean;
  getIsDirty: () => boolean;
  onFocusSearch: () => void;
  onClearSearch: () => void;
  onSave: () => void;
}): () => void {
  const handler = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const isInput = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
    const isSearchInput =
      (target as HTMLElement | null)?.id === "config-search-input";

    if (isInput) {
      if (e.key === "Escape") {
        e.preventDefault();
        if (isSearchInput && props.getSearchQuery()) props.onClearSearch();
        (target as HTMLElement).blur();
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      if (props.getCanSave()) props.onSave();
      return;
    }

    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key === "/") {
      if (props.getFormMode() !== "form") return;
      e.preventDefault();
      props.onFocusSearch();
      return;
    }

    if (e.key === "Escape" && props.getSearchQuery()) {
      e.preventDefault();
      props.onClearSearch();
    }
  };

  const beforeUnload = (e: BeforeUnloadEvent) => {
    if (!props.getIsDirty()) return;
    e.preventDefault();
    // Per spec, browsers ignore custom strings but require returnValue to be set.
    e.returnValue = "";
  };

  document.addEventListener("keydown", handler);
  window.addEventListener("beforeunload", beforeUnload);
  return () => {
    document.removeEventListener("keydown", handler);
    window.removeEventListener("beforeunload", beforeUnload);
  };
}

export function renderConfig(props: ConfigProps) {
  const validity =
    props.valid == null ? "unknown" : props.valid ? "valid" : "invalid";
  const analysis = analyzeConfigSchema(props.schema);
  const formUnsafe = analysis.schema
    ? analysis.unsupportedPaths.length > 0
    : false;

  const normalizedIssues = (props.issues ?? []).map(normalizeIssue);
  const issueCounts = normalizedIssues.reduce(
    (acc, issue) => {
      acc.total += 1;
      if (issue.severity === "error") acc.errors += 1;
      else if (issue.severity === "warn") acc.warns += 1;
      else acc.infos += 1;
      return acc;
    },
    { total: 0, errors: 0, warns: 0, infos: 0 },
  );

  const validation: ConfigValidationMap = {};
  for (const issue of normalizedIssues) {
    if (!issue.path) continue;
    const key = pathKey(issue.path);
    if (!key) continue;
    const entry: ConfigValidationIssue = {
      severity: issue.severity,
      message: issue.message,
      raw: issue.raw,
    };
    (validation[key] ||= []).push(entry);
  }

  // Get available sections from schema
  const schemaProps = analysis.schema?.properties ?? {};
  const availableSections = SECTIONS.filter(s => s.key in schemaProps);

  // Add any sections in schema but not in our list
  const knownKeys = new Set(SECTIONS.map(s => s.key));
  const extraSections = Object.keys(schemaProps)
    .filter(k => !knownKeys.has(k))
    .map(k => ({ key: k, label: k.charAt(0).toUpperCase() + k.slice(1) }));

  const allSections = [...availableSections, ...extraSections];

  const activeSectionSchema =
    props.activeSection && analysis.schema && schemaType(analysis.schema) === "object"
      ? (analysis.schema.properties?.[props.activeSection] as JsonSchema | undefined)
      : undefined;
  const activeSectionMeta = props.activeSection
    ? resolveSectionMeta(props.activeSection, activeSectionSchema)
    : null;
  const subsections = props.activeSection
    ? resolveSubsections({
        key: props.activeSection,
        schema: activeSectionSchema,
        uiHints: props.uiHints,
      })
    : [];
  const allowSubnav =
    props.formMode === "form" &&
    Boolean(props.activeSection) &&
    subsections.length > 0;
  const isAllSubsection = props.activeSubsection === ALL_SUBSECTION;
  const effectiveSubsection = props.searchQuery
    ? null
    : isAllSubsection
      ? null
      : props.activeSubsection ?? (subsections[0]?.key ?? null);

  // Compute diff for showing changes (works for both form and raw modes)
  const diff = props.formMode === "form"
    ? computeDiff(props.originalValue, props.formValue)
    : [];
  const hasRawChanges = props.formMode === "raw" && props.raw !== props.originalRaw;
  const hasChanges = props.formMode === "form" ? diff.length > 0 : hasRawChanges;

  // Save/apply buttons require actual changes to be enabled.
  // Note: formUnsafe warns about unsupported schema paths but shouldn't block saving.
  const canSaveForm =
    Boolean(props.formValue) && !props.loading && Boolean(analysis.schema);
  const canSave =
    props.connected &&
    !props.saving &&
    hasChanges &&
    (props.formMode === "raw" ? true : canSaveForm);
  const canApply =
    props.connected &&
    !props.applying &&
    !props.updating &&
    hasChanges &&
    (props.formMode === "raw" ? true : canSaveForm);
  const canUpdate = props.connected && !props.applying && !props.updating;

  const unifiedDiff = hasChanges
    ? formatUnifiedDiff({
        fromLabel: "saved",
        toLabel: "pending",
        fromText: props.originalRaw,
        toText: props.raw,
      })
    : "";
  const pendingDialogId = "config-pending-changes-dialog";
  const diagnosticsDialogId = "config-diagnostics-dialog";

  const openDialog = (id: string) => {
    const dialog = document.getElementById(id) as HTMLDialogElement | null;
    dialog?.showModal?.();
    if (id === diagnosticsDialogId) {
      // Ensure counts/groups are correct on open (default filter/query is "all"/empty).
      setTimeout(() => {
        const el = document.getElementById(diagnosticsDialogId) as HTMLElement | null;
        if (el) applyDiagnosticsFilters(el);
      }, 0);
    }
  };

  const closeDialog = (event: Event) => {
    const dialog = (event.currentTarget as HTMLElement | null)?.closest(
      "dialog",
    ) as HTMLDialogElement | null;
    dialog?.close?.();
  };

  const setDiagnosticsStatus = (msg: string) => {
    const el = document.getElementById("config-diagnostics-status") as HTMLElement | null;
    if (el) el.textContent = msg;
  };

  const jumpToPath = (path: Array<string | number>) => {
    setDiagnosticsStatus("");
    if (props.formMode !== "form") {
      // Best-effort: allow jumping by switching to form if schema is available.
      if (props.schema && !props.schemaLoading) props.onFormModeChange("form");
    }

    const section =
      path.length > 0 && typeof path[0] === "string" ? String(path[0]) : null;
    if (section) props.onSectionChange(section);

    const key = pathKey(path);
    const tryFocus = (): boolean => {
      const escapedKey =
        typeof CSS !== "undefined" && typeof CSS.escape === "function"
          ? CSS.escape(key)
          : key;
      const el = document.querySelector(
        `[data-config-path="${escapedKey}"]`,
      ) as HTMLElement | null;
      if (!el) return false;

      // Expand any collapsed parent <details> so the field is visible.
      let parent: HTMLElement | null = el;
      while (parent) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
        parent = parent.parentElement;
      }

      el.scrollIntoView({ block: "center", behavior: "smooth" });
      const input = el.querySelector(
        "input, select, textarea, button",
      ) as HTMLElement | null;
      input?.focus?.();
      return true;
    };

    // Re-render + layout needs a beat.
    setTimeout(() => {
      if (tryFocus()) return;
      if (section) {
        const fallback = document.getElementById(`config-section-${section}`) as HTMLElement | null;
        fallback?.scrollIntoView({ block: "start", behavior: "smooth" });
      }
    }, 50);
    setTimeout(() => {
      if (tryFocus()) return;
      setDiagnosticsStatus(
        "Could not locate the exact field for this issue; jumped to the section instead.",
      );
    }, 250);
  };

  return html`
    <div class="config-layout">
      <!-- Sidebar -->
      <aside class="config-sidebar">
        <div class="config-sidebar__header">
          <div class="config-sidebar__title">Settings</div>
          <label class="config-jump">
            <span class="sr-only">Jump to section</span>
            <select
              class="config-jump__select"
              .value=${props.activeSection ?? ""}
              @change=${(e: Event) => {
                const value = (e.target as HTMLSelectElement).value;
                props.onSectionChange(value ? value : null);
              }}
            >
              <option value="">All</option>
              ${allSections.map(
                (section) => html`<option value=${section.key}>${section.label}</option>`,
              )}
            </select>
          </label>
          ${hasChanges
            ? html`<span class="pill pill--sm pill--warn" title="You have unsaved changes">unsaved</span>`
            : nothing}
          <span class="pill pill--sm ${validity === "valid" ? "pill--ok" : validity === "invalid" ? "pill--danger" : ""}">${validity}</span>
        </div>

        <!-- Search -->
        <div class="config-search">
          <svg class="config-search__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"></circle>
            <path d="M21 21l-4.35-4.35"></path>
          </svg>
          <input
            type="text"
            class="config-search__input"
            id="config-search-input"
            placeholder=${props.formMode === "form"
              ? "Search settings..."
              : "Search works in Form view"}
            .value=${props.searchQuery}
            ?disabled=${props.formMode !== "form"}
            @input=${(e: Event) => props.onSearchChange((e.target as HTMLInputElement).value)}
          />
          ${props.searchQuery ? html`
            <button
              class="config-search__clear"
              @click=${() => props.onSearchChange("")}
            >×</button>
          ` : nothing}
        </div>

        <!-- Section nav -->
        <nav class="config-nav">
          <button
            class="config-nav__item ${props.activeSection === null ? "active" : ""}"
            @click=${() => props.onSectionChange(null)}
          >
            <span class="config-nav__icon">${sidebarIcons.all}</span>
            <span class="config-nav__label">All Settings</span>
          </button>
          ${allSections.map(section => html`
            <button
              class="config-nav__item ${props.activeSection === section.key ? "active" : ""}"
              @click=${() => props.onSectionChange(section.key)}
            >
              <span class="config-nav__icon">${getSectionIcon(section.key)}</span>
              <span class="config-nav__label">${section.label}</span>
            </button>
          `)}
        </nav>

        <!-- Mode toggle at bottom -->
        <div class="config-sidebar__footer">
          <div class="config-mode-toggle">
            <button
              class="config-mode-toggle__btn ${props.formMode === "form" ? "active" : ""}"
              ?disabled=${props.schemaLoading || !props.schema}
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

      <!-- Main content -->
      <main class="config-main">
        <!-- Action bar -->
        <div class="config-actions">
          <div class="config-actions__left">
            ${hasChanges ? html`
              <span class="config-changes-badge">${props.formMode === "raw" ? "Unsaved changes" : `${diff.length} unsaved change${diff.length !== 1 ? "s" : ""}`}</span>
            ` : html`
              <span class="config-status muted">No changes</span>
            `}
          </div>
          <div class="config-actions__right">
            ${issueCounts.total > 0
              ? html`
                  <button
                    class="btn btn--sm danger"
                    type="button"
                    @click=${() => openDialog(diagnosticsDialogId)}
                    title="Diagnostics: view, filter, and jump to fixes"
                  >
                    Diagnostics (${issueCounts.total})
                  </button>
                `
              : nothing}
            ${hasChanges ? html`
              <button
                class="btn btn--sm"
                type="button"
                @click=${() => {
                  const payload =
                    props.formMode === "form"
                      ? JSON.stringify({ mode: "form", changes: diff }, null, 2)
                      : JSON.stringify({ mode: "raw", diff: unifiedDiff || "(no diff)" }, null, 2);
                  copyText(payload);
                }}
                title="Copy a JSON summary of pending changes"
              >
                Copy pending changes
              </button>
              <button
                class="btn btn--sm"
                type="button"
                @click=${() => {
                  const dialog = document.getElementById(
                    pendingDialogId,
                  ) as HTMLDialogElement | null;
                  dialog?.showModal?.();
                }}
                title="Open a full review panel with summary + unified diff"
              >
                View pending changes
              </button>
            ` : nothing}
            <button class="btn btn--sm" ?disabled=${props.loading} @click=${props.onReload} title="Reload config from the gateway">
              ${props.loading ? "Loading…" : "Reload"}
            </button>
            <button
              class="btn btn--sm primary"
              ?disabled=${!canSave}
              @click=${props.onSave}
              title="Save: write config to the gateway (does not necessarily apply/restart)"
            >
              ${props.saving ? "Saving…" : "Save"}
            </button>
            <button
              class="btn btn--sm"
              ?disabled=${!canApply}
              @click=${props.onApply}
              title="Apply: apply the saved config to the active session"
            >
              ${props.applying ? "Applying…" : "Apply"}
            </button>
            <button
              class="btn btn--sm"
              ?disabled=${!canUpdate}
              @click=${props.onUpdate}
              title="Update: run gateway update (may take time)"
            >
              ${props.updating ? "Updating…" : "Update"}
            </button>
          </div>
        </div>
        <div class="config-actions__hint muted">
          Save writes config; Apply activates it; Update updates the gateway binary. (Tip: Cmd/Ctrl+S saves.)
        </div>

        <!-- Quick Setup Card (shown when no section is selected) -->
        ${props.activeSection === null && props.showQuickSetup ? html`
          <div class="config-quick-setup">
            <div class="config-quick-setup__header">
              <div class="config-quick-setup__icon">${icon("zap", { size: 24 })}</div>
              <div>
                <div class="config-quick-setup__title">Quick Setup</div>
                <div class="config-quick-setup__desc">Configure the most common settings</div>
              </div>
              <button
                class="config-quick-setup__close"
                @click=${() => props.onToggleQuickSetup?.()}
                title="Hide quick setup"
              >
                ${icon("x", { size: 16 })}
              </button>
            </div>
            <div class="config-quick-setup__content">
              <div class="config-quick-setup__tip">
                ${icon("lightbulb", { size: 16 })}
                <span>New here? Start with the basics below, or explore all settings.</span>
              </div>
              <div class="config-quick-setup__actions">
                <button
                  class="config-quick-setup__action"
                  @click=${() => props.onSectionChange("gateway")}
                >
                  ${icon("sliders", { size: 18 })}
                  <span>Gateway Settings</span>
                  <span class="muted">Mode, ports, bindings</span>
                </button>
                <button
                  class="config-quick-setup__action"
                  @click=${() => props.onSectionChange("agents")}
                >
                  ${icon("users", { size: 18 })}
                  <span>Agent Defaults</span>
                  <span class="muted">Model, context, thinking</span>
                </button>
                <button
                  class="config-quick-setup__action"
                  @click=${() => props.onSectionChange("auth")}
                >
                  ${icon("lock", { size: 18 })}
                  <span>Authentication</span>
                  <span class="muted">Tokens, passwords</span>
                </button>
              </div>
            </div>
          </div>
        ` : nothing}

        <!-- Diff panel (form mode only - raw mode doesn't have granular diff) -->
        ${hasChanges && props.formMode === "form" ? html`
          <details class="config-diff">
            <summary class="config-diff__summary">
              <span>Quick preview: ${diff.length} change${diff.length !== 1 ? "s" : ""}</span>
              <svg class="config-diff__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
            </summary>
            <div class="config-diff__content">
              <div class="config-diff__actions">
                <button
                  class="btn btn--sm"
                  type="button"
                  @click=${() =>
                    copyText(
                      JSON.stringify(
                        {
                          mode: "form",
                          changes: diff,
                        },
                        null,
                        2,
                      ),
                    )}
                >
                  Copy pending changes
                </button>
                <button
                  class="btn btn--sm"
                  type="button"
                  @click=${() => {
                    const dialog = document.getElementById(
                      pendingDialogId,
                    ) as HTMLDialogElement | null;
                    dialog?.showModal?.();
                  }}
                >
                  View pending changes
                </button>
              </div>
              ${diff.map(change => html`
                <div class="config-diff__item">
                  <div class="config-diff__path">${change.path}</div>
                  <div class="config-diff__values">
                    <span class="config-diff__from">${truncateValue(change.from)}</span>
                    <span class="config-diff__arrow">→</span>
                    <span class="config-diff__to">${truncateValue(change.to)}</span>
                  </div>
                </div>
              `)}
            </div>
          </details>
        ` : nothing}

        ${activeSectionMeta && props.formMode === "form"
          ? html`
              <div class="config-section-hero">
                <div class="config-section-hero__icon">${getSectionIcon(props.activeSection ?? "")}</div>
                <div class="config-section-hero__text">
                  <div class="config-section-hero__title">${activeSectionMeta.label}</div>
                  ${activeSectionMeta.description
                    ? html`<div class="config-section-hero__desc">${activeSectionMeta.description}</div>`
                    : nothing}
                </div>
              </div>
            `
          : nothing}

        ${allowSubnav
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
                      class="config-subnav__item ${
                        effectiveSubsection === entry.key ? "active" : ""
                      }"
                      title=${entry.description || entry.label}
                      @click=${() => props.onSubsectionChange(entry.key)}
                    >
                      ${entry.label}
                    </button>
                  `,
                )}
              </div>
            `
          : nothing}

        <!-- Form content -->
        <div class="config-content">
          ${props.formMode === "form"
            ? html`
                ${props.schemaLoading
                  ? html`<div class="config-loading">
                      <div class="config-loading__spinner"></div>
                      <span>Loading schema…</span>
                    </div>`
                  : renderConfigForm({
                      schema: analysis.schema,
                      uiHints: props.uiHints,
                      value: props.formValue,
                      disabled: props.loading || !props.formValue,
                      unsupportedPaths: analysis.unsupportedPaths,
                      validation,
                      onPatch: props.onFormPatch,
                      searchQuery: props.searchQuery,
                      activeSection: props.activeSection,
                      activeSubsection: effectiveSubsection,
                    })}
                ${formUnsafe
                  ? html`<div class="callout danger" style="margin-top: 12px;">
                      Form view can't safely edit some fields.
                      Use Raw to avoid losing config entries.
                    </div>`
                  : nothing}
              `
            : html`
                <div class="callout info" style="margin-bottom: 12px;">
                  Raw mode is powerful, but Search and diagnostics “Jump to fix” work best in Form view.
                  ${props.schema && !props.schemaLoading
                    ? html`
                        <button
                          class="btn btn--sm"
                          type="button"
                          style="margin-left: 10px;"
                          @click=${() => props.onFormModeChange("form")}
                        >
                          Switch to Form
                        </button>
                      `
                    : nothing}
                </div>
                <label class="field config-raw-field">
                  <span>Raw JSON5</span>
                  <textarea
                    .value=${props.raw}
                    @input=${(e: Event) =>
                      props.onRawChange((e.target as HTMLTextAreaElement).value)}
                  ></textarea>
                </label>
              `}
        </div>

        ${issueCounts.total > 0
          ? html`
              <div class="config-issues" role="region" aria-label="Config diagnostics">
                <div class="config-issues__summary">
                  <div class="config-issues__title">
                    Diagnostics
                    <span class="config-issues__counts">
                      ${issueCounts.errors ? html`<span class="config-issues__count config-issues__count--error">${issueCounts.errors} error${issueCounts.errors !== 1 ? "s" : ""}</span>` : nothing}
                      ${issueCounts.warns ? html`<span class="config-issues__count config-issues__count--warn">${issueCounts.warns} warning${issueCounts.warns !== 1 ? "s" : ""}</span>` : nothing}
                      ${issueCounts.infos ? html`<span class="config-issues__count config-issues__count--info">${issueCounts.infos} info</span>` : nothing}
                    </span>
                  </div>
                  <div class="config-issues__actions">
                    <button class="btn btn--sm danger" type="button" @click=${() => openDialog(diagnosticsDialogId)}>
                      Open diagnostics
                    </button>
                    <button
                      class="btn btn--sm"
                      type="button"
                      @click=${() =>
                        copyText(
                          JSON.stringify(
                            {
                              valid: props.valid,
                              counts: issueCounts,
                              issues: props.issues,
                              pending: hasChanges
                                ? {
                                    mode: props.formMode,
                                    diff: props.formMode === "form" ? diff : undefined,
                                    unifiedDiff,
                                  }
                                : null,
                            },
                            null,
                            2,
                          ),
                        )}
                    >
                      Copy diagnostics
                    </button>
                  </div>
                </div>

                <details class="config-issues__raw">
                  <summary>Raw issues (JSON)</summary>
                  <pre class="code-block">${JSON.stringify(props.issues, null, 2)}</pre>
                </details>
              </div>
            `
          : nothing}
      </main>

      <dialog id=${pendingDialogId} class="config-pending-dialog">
        <div class="config-pending-dialog__header">
          <div class="config-pending-dialog__title">Pending changes</div>
          <div class="config-pending-dialog__actions">
            <button
              class="btn btn--sm"
              type="button"
              @click=${() => copyText(unifiedDiff || "(no diff)")}
            >
              Copy diff
            </button>
            <button
              class="btn btn--sm"
              type="button"
              @click=${() =>
                copyText(
                  JSON.stringify(
                    {
                      mode: props.formMode,
                      raw: props.raw,
                    },
                    null,
                    2,
                  ),
                )}
            >
              Copy effective config
            </button>
            <button
              class="btn btn--sm"
              type="button"
              @click=${(e: Event) => {
                const dialog = (e.currentTarget as HTMLElement | null)?.closest(
                  "dialog",
                ) as HTMLDialogElement | null;
                dialog?.close?.();
              }}
            >
              Close
            </button>
          </div>
        </div>

        <div class="config-pending-dialog__body">
          ${props.formMode === "form"
            ? html`
                <div class="config-pending-dialog__panel">
                  <div class="config-pending-dialog__panel-title">Summary</div>
                  <div class="config-pending-dialog__summary">
                    ${diff.length === 0
                      ? html`<div class="muted">No changes.</div>`
                      : diff.map(
                          (change) => html`
                            <div class="config-diff__item">
                              <div class="config-diff__path">${change.path}</div>
                              <div class="config-diff__values">
                                <span class="config-diff__from">${truncateValue(change.from, 80)}</span>
                                <span class="config-diff__arrow">→</span>
                                <span class="config-diff__to">${truncateValue(change.to, 80)}</span>
                              </div>
                            </div>
                          `,
                        )}
                  </div>
                </div>
              `
            : html`
                <div class="config-pending-dialog__panel">
                  <div class="config-pending-dialog__panel-title">Summary</div>
                  <div class="muted">
                    Raw edits are tracked as a full-document change. Use the diff panel to review the exact text changes.
                  </div>
                </div>
              `}

          <div class="config-pending-dialog__panel">
            <div class="config-pending-dialog__panel-title">Diff (saved → pending)</div>
            <pre class="code-block config-pending-dialog__diff">${unifiedDiff || "(no diff)"}</pre>
          </div>
        </div>
      </dialog>

      <dialog
        id=${diagnosticsDialogId}
        class="config-diagnostics-dialog"
        data-diag-filter="all"
        data-diag-query=""
      >
        <div class="config-diagnostics-dialog__header">
          <div class="config-diagnostics-dialog__title">
            Diagnostics
            <span class="config-diagnostics-dialog__subtitle" title="Issue totals">
              ${issueCounts.errors ? `${issueCounts.errors} error${issueCounts.errors !== 1 ? "s" : ""}` : "0 errors"}
              ${issueCounts.warns ? ` · ${issueCounts.warns} warning${issueCounts.warns !== 1 ? "s" : ""}` : ""}
              ${issueCounts.infos ? ` · ${issueCounts.infos} info` : ""}
            </span>
            <span id="config-diagnostics-count" class="config-diagnostics-dialog__subtitle" title="Visible items after filtering">
              Showing ${issueCounts.total} of ${issueCounts.total}
            </span>
          </div>
          <div class="config-diagnostics-dialog__actions">
            <button
              class="btn btn--sm"
              type="button"
              @click=${() =>
                copyText(
                  JSON.stringify(
                    {
                      valid: props.valid,
                      counts: issueCounts,
                      issues: props.issues,
                    },
                    null,
                    2,
                  ),
                )}
            >
              Copy diagnostics
            </button>
            <button class="btn btn--sm" type="button" @click=${closeDialog}>Close</button>
          </div>
        </div>

        <div class="config-diagnostics-dialog__body">
          <div class="config-diagnostics-dialog__controls">
            <label class="config-diagnostics-dialog__search">
              <span class="sr-only">Filter diagnostics</span>
              <input
                class="config-diagnostics-dialog__search-input"
                type="text"
                placeholder="Filter diagnostics…"
                @input=${(e: Event) => {
                  const dialog = document.getElementById(diagnosticsDialogId) as HTMLElement | null;
                  if (!dialog) return;
                  const q = (e.target as HTMLInputElement).value.trim();
                  dialog.setAttribute("data-diag-query", q);
                  applyDiagnosticsFilters(dialog);
                }}
              />
              <button
                type="button"
                class="config-diagnostics-dialog__search-clear"
                aria-label="Clear filter"
                @click=${(e: Event) => {
                  const dialog = document.getElementById(diagnosticsDialogId) as HTMLElement | null;
                  const input = (e.currentTarget as HTMLElement).previousElementSibling as HTMLInputElement | null;
                  if (!dialog || !input) return;
                  input.value = "";
                  dialog.setAttribute("data-diag-query", "");
                  applyDiagnosticsFilters(dialog);
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
              </button>
            </label>
            <div class="config-diagnostics-dialog__filters" role="group" aria-label="Severity filter">
              <button
                class="btn btn--sm active"
                type="button"
                @click=${(e: Event) => {
                  const dialog = document.getElementById(diagnosticsDialogId) as HTMLElement | null;
                  if (!dialog) return;
                  dialog.setAttribute("data-diag-filter", "all");
                  applyDiagnosticsFilters(dialog);
                  (e.currentTarget as HTMLElement | null)?.parentElement?.querySelectorAll("button")?.forEach((b) => b.classList.remove("active"));
                  (e.currentTarget as HTMLElement | null)?.classList.add("active");
                }}
              >
                All
              </button>
              <button
                class="btn btn--sm"
                type="button"
                @click=${(e: Event) => {
                  const dialog = document.getElementById(diagnosticsDialogId) as HTMLElement | null;
                  if (!dialog) return;
                  dialog.setAttribute("data-diag-filter", "error");
                  applyDiagnosticsFilters(dialog);
                  (e.currentTarget as HTMLElement | null)?.parentElement?.querySelectorAll("button")?.forEach((b) => b.classList.remove("active"));
                  (e.currentTarget as HTMLElement | null)?.classList.add("active");
                }}
              >
                Errors
              </button>
              <button
                class="btn btn--sm"
                type="button"
                @click=${(e: Event) => {
                  const dialog = document.getElementById(diagnosticsDialogId) as HTMLElement | null;
                  if (!dialog) return;
                  dialog.setAttribute("data-diag-filter", "warn");
                  applyDiagnosticsFilters(dialog);
                  (e.currentTarget as HTMLElement | null)?.parentElement?.querySelectorAll("button")?.forEach((b) => b.classList.remove("active"));
                  (e.currentTarget as HTMLElement | null)?.classList.add("active");
                }}
              >
                Warnings
              </button>
              <button
                class="btn btn--sm"
                type="button"
                @click=${(e: Event) => {
                  const dialog = document.getElementById(diagnosticsDialogId) as HTMLElement | null;
                  if (!dialog) return;
                  dialog.setAttribute("data-diag-filter", "info");
                  applyDiagnosticsFilters(dialog);
                  (e.currentTarget as HTMLElement | null)?.parentElement?.querySelectorAll("button")?.forEach((b) => b.classList.remove("active"));
                  (e.currentTarget as HTMLElement | null)?.classList.add("active");
                }}
              >
                Info
              </button>
            </div>
          </div>

          <div id="config-diagnostics-status" class="config-diagnostics-dialog__status muted"></div>

          <div class="config-diagnostics-dialog__content">
            ${(() => {
              const order: ConfigIssueSeverity[] = ["error", "warn", "info"];
              const groups = new Map<string, NormalizedConfigIssue[]>();
              for (const issue of normalizedIssues) {
                const groupKey = issue.sectionKey ?? "general";
                const arr = groups.get(groupKey) ?? [];
                arr.push(issue);
                groups.set(groupKey, arr);
              }
              const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b));

              return keys.map((groupKey) => {
                const groupIssues = groups.get(groupKey) ?? [];
                groupIssues.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));

                const meta =
                  groupKey !== "general" ? resolveSectionMeta(groupKey, undefined) : null;
                const title = meta?.label ?? (groupKey === "general" ? "General" : humanize(groupKey));

                return html`
                  <div class="config-diagnostics-group" data-diag-group>
                    <div class="config-diagnostics-group__header">
                      <div class="config-diagnostics-group__title">${title}</div>
                      <div class="config-diagnostics-group__count">${groupIssues.length}</div>
                    </div>
                    <div class="config-diagnostics-group__list">
                      ${groupIssues.map((issue, idx) => {
                        const pathText = issue.path ? pathKey(issue.path) : "";
                        const text = `${issue.severity} ${issue.message} ${pathText} ${title}`;
                        return html`
                          <details
                            class="config-diagnostics-item config-diagnostics-item--${issue.severity}"
                            data-diag-item
                            data-diag-sev=${issue.severity}
                            data-diag-text=${text}
                          >
                            <summary class="config-diagnostics-item__summary">
                              <span class="config-diagnostics-item__sev">${issue.severity}</span>
                              <span class="config-diagnostics-item__msg">${issue.message}</span>
                              ${pathText ? html`<span class="config-diagnostics-item__path">${pathText}</span>` : nothing}
                            </summary>
                            <div class="config-diagnostics-item__body">
                              <div class="config-diagnostics-item__actions">
                                ${issue.path ? html`
                                  <button
                                    class="btn btn--sm"
                                    type="button"
                                    @click=${() => jumpToPath(issue.path!)}
                                  >
                                    Jump to fix
                                  </button>
                                ` : nothing}
                                <button
                                  class="btn btn--sm"
                                  type="button"
                                  @click=${() => copyText(JSON.stringify(issue.raw, null, 2))}
                                >
                                  Copy raw issue
                                </button>
                              </div>
                              <details class="config-diagnostics-item__raw">
                                <summary>Raw details</summary>
                                <pre class="code-block">${JSON.stringify(issue.raw, null, 2)}</pre>
                              </details>
                            </div>
                          </details>
                        `;
                      })}
                    </div>
                  </div>
                `;
              });
            })()}

            <details class="config-diagnostics-rawall">
              <summary>All raw issues (JSON)</summary>
              <pre class="code-block">${JSON.stringify(props.issues, null, 2)}</pre>
            </details>
          </div>
        </div>
      </dialog>
    </div>
  `;
}
