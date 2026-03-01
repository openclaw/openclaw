import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import type { TranslationMap } from "./src/i18n/lib/types.ts";
import { en } from "./src/i18n/locales/en.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const AUTO_LITERAL_PREFIX = "auto";
const MAX_LITERAL_LENGTH = 360;
const EXTERNAL_LITERAL_SOURCE_FILES = [
  path.resolve(here, "../src/config/schema.labels.ts"),
  path.resolve(here, "../src/config/schema.help.ts"),
  path.resolve(here, "../src/config/schema.hints.ts"),
  path.resolve(here, "../src/config/schema.irc.ts"),
];

type ExtractedTemplate = {
  template: string;
  expressions: Array<{
    source: string;
    context: { kind: "text" } | { kind: "attr"; name: string | null } | { kind: "other" };
  }>;
};

function normalizeBase(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "/";
  }
  if (trimmed === "./") {
    return "./";
  }
  if (trimmed.endsWith("/")) {
    return trimmed;
  }
  return `${trimmed}/`;
}

function flattenTranslationMap(
  input: TranslationMap,
  prefix = "",
  out: Record<string, string> = {},
): Record<string, string> {
  for (const [key, value] of Object.entries(input)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      out[nextKey] = value;
      continue;
    }
    flattenTranslationMap(value, nextKey, out);
  }
  return out;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeLiteralCandidate(value: string): string {
  const unescaped = value
    .replace(/\\n/g, " ")
    .replace(/\\t/g, " ")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
  return decodeHtmlEntities(unescaped).replace(/\s+/g, " ").trim();
}

function isLikelyUiLiteral(value: string): boolean {
  if (!value || value.length < 2 || value.length > MAX_LITERAL_LENGTH) {
    return false;
  }
  if (!/\p{L}/u.test(value)) {
    return false;
  }
  if (value.includes("{") || value.includes("}") || value.includes("${")) {
    return false;
  }
  if (value.includes("`")) {
    return false;
  }
  const lower = value.toLowerCase();
  if (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("ws://") ||
    lower.startsWith("wss://")
  ) {
    return false;
  }
  if (value.endsWith(".ts") || value.endsWith(".js") || value.includes("src/")) {
    return false;
  }
  if (/^[a-z]+(?:\.[A-Za-z0-9_-]+)+$/.test(value)) {
    return false;
  }
  if (value.includes(":") && value.includes(";")) {
    return false;
  }
  if (/^[a-z-]+\([^)]*\)$/.test(lower)) {
    return false;
  }
  if (!value.includes(" ") && /^[a-z][A-Za-z0-9]+$/.test(value) && /[A-Z]/.test(value)) {
    return false;
  }
  if (/^[a-z-]+\s*:\s*[^;]+;?$/.test(lower)) {
    return false;
  }
  if ((value.includes("--") || value.includes("__")) && value === lower) {
    return false;
  }
  if (/^[-\w./:@]+$/.test(value) && value === lower && !value.includes(" ")) {
    if (/[/.:@_-]/.test(value)) {
      return false;
    }
  }
  return true;
}

function extractStringLiterals(source: string): string[] {
  const out: string[] = [];
  const stringLiteralRe = /(['"])((?:\\.|(?!\1)[^\\\n]){1,600})\1/g;
  let match: RegExpExecArray | null;
  while ((match = stringLiteralRe.exec(source)) !== null) {
    out.push(match[2]);
  }
  return out;
}

function listControlUiSourceFiles(rootDir: string): string[] {
  const out: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
        continue;
      }
      out.push(full);
    }
  }
  return out;
}

function readQuotedString(source: string, start: number, quote: "'" | '"'): number {
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) {
      return i + 1;
    }
    i += 1;
  }
  return source.length;
}

function readTemplateLiteral(source: string, start: number): number {
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      return i + 1;
    }
    if (ch === "$" && source[i + 1] === "{") {
      i = readJsExpression(source, i + 2);
      continue;
    }
    i += 1;
  }
  return source.length;
}

function readJsExpression(source: string, start: number): number {
  let i = start;
  let depth = 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "'" || ch === '"') {
      i = readQuotedString(source, i, ch);
      continue;
    }
    if (ch === "`") {
      i = readTemplateLiteral(source, i);
      continue;
    }
    if (ch === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return i;
}

function extractTemplates(source: string): ExtractedTemplate[] {
  const out: ExtractedTemplate[] = [];
  let index = 0;
  while (index < source.length) {
    const start = source.indexOf("html`", index);
    if (start < 0) {
      break;
    }
    let i = start + "html`".length;
    let template = "";
    const expressions: ExtractedTemplate["expressions"] = [];
    while (i < source.length) {
      const ch = source[i];
      if (ch === "\\") {
        template += source.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === "`") {
        i += 1;
        break;
      }
      if (ch === "$" && source[i + 1] === "{") {
        const exprStart = i + 2;
        const exprEnd = readJsExpression(source, exprStart);
        const expressionSource = source.slice(exprStart, Math.max(exprStart, exprEnd - 1));
        const lastOpenTag = template.lastIndexOf("<");
        const lastCloseTag = template.lastIndexOf(">");
        if (lastOpenTag > lastCloseTag) {
          const tagTail = template.slice(lastOpenTag + 1);
          const attrMatch = /([A-Za-z_][\w:-]*)\s*=\s*(?:"[^"]*|'[^']*|[^\s>]*)?$/.exec(tagTail);
          expressions.push({
            source: expressionSource,
            context: { kind: "attr", name: attrMatch?.[1] ?? null },
          });
        } else {
          expressions.push({
            source: expressionSource,
            context: { kind: "text" },
          });
        }
        template += " ";
        i = exprEnd;
        continue;
      }
      template += ch;
      i += 1;
    }
    out.push({ template, expressions });
    index = i;
  }
  return out;
}

function extractLiteralsFromTemplate(input: ExtractedTemplate): string[] {
  const out: string[] = [];
  const { template, expressions } = input;
  const textNodeRe = />([^<>]+)</g;
  let match: RegExpExecArray | null;
  while ((match = textNodeRe.exec(template)) !== null) {
    out.push(match[1]);
  }

  const attrRe = /\b(?:title|placeholder|aria-label)\s*=\s*(['"])([^"'{}]+)\1/g;
  while ((match = attrRe.exec(template)) !== null) {
    out.push(match[2]);
  }

  const stringLiteralRe = /(['"])((?:\\.|(?!\1)[^\\\n]){1,220})\1/g;
  for (const expr of expressions) {
    const isTextContext = expr.context.kind === "text";
    const isI18nAttrContext =
      expr.context.kind === "attr" &&
      (expr.context.name === "title" ||
        expr.context.name === "placeholder" ||
        expr.context.name === "aria-label");
    if (!isTextContext && !isI18nAttrContext) {
      continue;
    }
    let literalMatch: RegExpExecArray | null;
    while ((literalMatch = stringLiteralRe.exec(expr.source)) !== null) {
      const candidate = literalMatch[2].trim();
      out.push(candidate);
    }
  }

  return out;
}

function encodeLiteralKey(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function collectControlUiLiteralMap(existingValues: Set<string>): Record<string, string> {
  const rootDir = path.resolve(here, "src/ui");
  const files = listControlUiSourceFiles(rootDir);
  const candidates = new Set<string>();
  for (const filePath of files) {
    const source = fs.readFileSync(filePath, "utf8");
    for (const template of extractTemplates(source)) {
      for (const rawCandidate of extractLiteralsFromTemplate(template)) {
        const candidate = normalizeLiteralCandidate(rawCandidate);
        if (!isLikelyUiLiteral(candidate)) {
          continue;
        }
        if (existingValues.has(candidate)) {
          continue;
        }
        candidates.add(candidate);
      }
    }
  }

  for (const filePath of EXTERNAL_LITERAL_SOURCE_FILES) {
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const source = fs.readFileSync(filePath, "utf8");
    for (const rawCandidate of extractStringLiterals(source)) {
      const candidate = normalizeLiteralCandidate(rawCandidate);
      if (!isLikelyUiLiteral(candidate)) {
        continue;
      }
      if (existingValues.has(candidate)) {
        continue;
      }
      candidates.add(candidate);
    }
  }

  const out: Record<string, string> = {};
  const sortedCandidates = [...candidates].toSorted((a, b) => a.localeCompare(b));
  for (const literal of sortedCandidates) {
    const key = `${AUTO_LITERAL_PREFIX}.${encodeLiteralKey(literal)}`;
    out[key] = literal;
  }
  return out;
}

function buildEnglishSourceManifest() {
  const baseFlat = flattenTranslationMap(en);
  const existingValues = new Set(Object.values(baseFlat));
  const autoLiteralFlat = collectControlUiLiteralMap(existingValues);
  const flat = {
    ...baseFlat,
    ...autoLiteralFlat,
  };
  const normalized = Object.fromEntries(
    Object.entries(flat).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  const sourceHash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  return {
    schemaVersion: 1,
    sourceLocale: "en" as const,
    sourceHash,
    keyCount: Object.keys(normalized).length,
    flat: normalized,
  };
}

function controlUiEnglishSourceManifestPlugin(): Plugin {
  return {
    name: "openclaw-control-ui-en-source-manifest",
    apply: "build",
    generateBundle() {
      const manifest = buildEnglishSourceManifest();
      this.emitFile({
        type: "asset",
        fileName: "i18n/en-source-manifest.json",
        source: `${JSON.stringify(manifest, null, 2)}\n`,
      });
    },
  };
}

export default defineConfig(() => {
  const envBase = process.env.OPENCLAW_CONTROL_UI_BASE_PATH?.trim();
  const base = envBase ? normalizeBase(envBase) : "./";
  return {
    base,
    publicDir: path.resolve(here, "public"),
    optimizeDeps: {
      include: ["lit/directives/repeat.js"],
    },
    build: {
      outDir: path.resolve(here, "../dist/control-ui"),
      emptyOutDir: true,
      sourcemap: true,
      // Keep CI/onboard logs clean; current control UI chunking is intentionally above 500 kB.
      chunkSizeWarningLimit: 1024,
    },
    plugins: [controlUiEnglishSourceManifestPlugin()],
    server: {
      host: true,
      port: 5173,
      strictPort: true,
    },
  };
});
