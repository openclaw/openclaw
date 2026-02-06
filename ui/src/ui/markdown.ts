import DOMPurify from "dompurify";
import { Lexer, marked } from "marked";
import { truncateText } from "./format";

marked.setOptions({
  gfm: true,
  breaks: true,
  mangle: false,
});

// Guard against infinite recursion in marked's tokenizer.
// The actual recursion cycle is: inlineTokens → link → outputLink → inlineTokens (never
// re-enters lex()). V8 (Chrome) may optimize deep recursion so it never throws a stack
// overflow, causing a permanent hang. We patch inlineTokens to force a throw at a safe depth
// that the try-catch in toSanitizedMarkdownHtml can reliably catch.
const INLINE_DEPTH_LIMIT = 200;
let inlineDepth = 0;
const originalInlineTokens = Lexer.prototype.inlineTokens;
Lexer.prototype.inlineTokens = function (...args: Parameters<typeof originalInlineTokens>) {
  inlineDepth++;
  if (inlineDepth > INLINE_DEPTH_LIMIT) {
    inlineDepth = 0;
    throw new Error("marked: inlineTokens recursion limit exceeded");
  }
  try {
    return originalInlineTokens.apply(this, args);
  } finally {
    inlineDepth--;
  }
};

const allowedTags = [
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
];

const allowedAttrs = ["class", "href", "rel", "target", "title", "start", "src", "alt", "width", "height"];

let hooksInstalled = false;
const MARKDOWN_CHAR_LIMIT = 140_000;
const MARKDOWN_PARSE_LIMIT = 40_000;
const MARKDOWN_CACHE_LIMIT = 200;
const MARKDOWN_CACHE_MAX_CHARS = 50_000;
const markdownCache = new Map<string, string>();

function getCachedMarkdown(key: string): string | null {
  const cached = markdownCache.get(key);
  if (cached === undefined) return null;
  markdownCache.delete(key);
  markdownCache.set(key, cached);
  return cached;
}

function setCachedMarkdown(key: string, value: string) {
  markdownCache.set(key, value);
  if (markdownCache.size <= MARKDOWN_CACHE_LIMIT) return;
  const oldest = markdownCache.keys().next().value;
  if (oldest) markdownCache.delete(oldest);
}

function installHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;

  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (!(node instanceof HTMLAnchorElement)) return;
    const href = node.getAttribute("href");
    if (!href) return;
    node.setAttribute("rel", "noreferrer noopener");
    node.setAttribute("target", "_blank");
  });
}

export function toSanitizedMarkdownHtml(markdown: string): string {
  const input = markdown.trim();
  if (!input) return "";
  installHooks();
  if (input.length <= MARKDOWN_CACHE_MAX_CHARS) {
    const cached = getCachedMarkdown(input);
    if (cached !== null) return cached;
  }
  const truncated = truncateText(input, MARKDOWN_CHAR_LIMIT);
  const suffix = truncated.truncated
    ? `\n\n… truncated (${truncated.total} chars, showing first ${truncated.text.length}).`
    : "";
  if (truncated.text.length > MARKDOWN_PARSE_LIMIT) {
    const escaped = escapeHtml(`${truncated.text}${suffix}`);
    const html = `<pre class="code-block">${escaped}</pre>`;
    const sanitized = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: allowedTags,
      ALLOWED_ATTR: allowedAttrs,
    });
    if (input.length <= MARKDOWN_CACHE_MAX_CHARS) {
      setCachedMarkdown(input, sanitized);
    }
    return sanitized;
  }
  let rendered: string;
  try {
    rendered = marked.parse(`${truncated.text}${suffix}`) as string;
  } catch {
    // marked can hit infinite recursion on certain input patterns (e.g. malformed links).
    // Fall back to escaped plaintext so the UI doesn't freeze.
    const escaped = escapeHtml(`${truncated.text}${suffix}`);
    rendered = `<pre class="code-block">${escaped}</pre>`;
  }
  const sanitized = DOMPurify.sanitize(rendered, {
    ALLOWED_TAGS: allowedTags,
    ALLOWED_ATTR: allowedAttrs,
    ADD_DATA_URI_TAGS: ["img"],
  });
  if (input.length <= MARKDOWN_CACHE_MAX_CHARS) {
    setCachedMarkdown(input, sanitized);
  }
  return sanitized;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
