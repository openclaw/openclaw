import DOMPurify from "dompurify";
import { marked } from "marked";
import { truncateText } from "./format.ts";

// SVG icons for code block copy button (must be strings for HTML output)
const COPY_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
const CHECK_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;

// Custom renderer for code blocks with copy button
const codeBlockRenderer = new marked.Renderer();
codeBlockRenderer.code = ({ text, lang }: { text: string; lang?: string }): string => {
  const langClass = lang ? ` language-${lang}` : "";
  const escapedCode = escapeHtml(text);
  // Use a wrapper div with relative positioning for the copy button
  return `<div class="code-block-wrapper"><pre class="code-block${langClass}"><code>${escapedCode}</code></pre><button class="code-block-copy-btn" type="button" data-code="${encodeURIComponent(text)}" title="Copy code">${COPY_ICON_SVG}<span class="code-block-copy-btn__check">${CHECK_ICON_SVG}</span></button></div>`;
};

marked.setOptions({
  gfm: true,
  breaks: true,
});

const allowedTags = [
  "a",
  "b",
  "blockquote",
  "br",
  "button",
  "code",
  "del",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "hr",
  "i",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "svg",
  "path",
  "rect",
  "circle",
  "line",
  "polyline",
  "polygon",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
  "img",
];

const allowedAttrs = [
  "class",
  "href",
  "rel",
  "target",
  "title",
  "start",
  "src",
  "alt",
  "data-code",
  "type",
  "viewBox",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "rx",
  "ry",
  "d",
  "cx",
  "cy",
  "r",
  "points",
];
const sanitizeOptions = {
  ALLOWED_TAGS: allowedTags,
  ALLOWED_ATTR: allowedAttrs,
  ADD_DATA_URI_TAGS: ["img"],
};

let hooksInstalled = false;
const MARKDOWN_CHAR_LIMIT = 140_000;
const MARKDOWN_PARSE_LIMIT = 40_000;
const MARKDOWN_CACHE_LIMIT = 200;
const MARKDOWN_CACHE_MAX_CHARS = 50_000;
const markdownCache = new Map<string, string>();

function getCachedMarkdown(key: string): string | null {
  const cached = markdownCache.get(key);
  if (cached === undefined) {
    return null;
  }
  markdownCache.delete(key);
  markdownCache.set(key, cached);
  return cached;
}

function setCachedMarkdown(key: string, value: string) {
  markdownCache.set(key, value);
  if (markdownCache.size <= MARKDOWN_CACHE_LIMIT) {
    return;
  }
  const oldest = markdownCache.keys().next().value;
  if (oldest) {
    markdownCache.delete(oldest);
  }
}

function installHooks() {
  if (hooksInstalled) {
    return;
  }
  hooksInstalled = true;

  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (!(node instanceof HTMLAnchorElement)) {
      return;
    }
    const href = node.getAttribute("href");
    if (!href) {
      return;
    }
    node.setAttribute("rel", "noreferrer noopener");
    node.setAttribute("target", "_blank");
  });
}

export function toSanitizedMarkdownHtml(markdown: string): string {
  const input = markdown.trim();
  if (!input) {
    return "";
  }
  installHooks();
  if (input.length <= MARKDOWN_CACHE_MAX_CHARS) {
    const cached = getCachedMarkdown(input);
    if (cached !== null) {
      return cached;
    }
  }
  const truncated = truncateText(input, MARKDOWN_CHAR_LIMIT);
  const suffix = truncated.truncated
    ? `\n\n… truncated (${truncated.total} chars, showing first ${truncated.text.length}).`
    : "";
  if (truncated.text.length > MARKDOWN_PARSE_LIMIT) {
    const escaped = escapeHtml(`${truncated.text}${suffix}`);
    const html = `<pre class="code-block">${escaped}</pre>`;
    const sanitized = DOMPurify.sanitize(html, sanitizeOptions);
    if (input.length <= MARKDOWN_CACHE_MAX_CHARS) {
      setCachedMarkdown(input, sanitized);
    }
    return sanitized;
  }
  const rendered = marked.parse(`${truncated.text}${suffix}`, {
    renderer: combinedRenderer,
  }) as string;
  const sanitized = DOMPurify.sanitize(rendered, sanitizeOptions);
  if (input.length <= MARKDOWN_CACHE_MAX_CHARS) {
    setCachedMarkdown(input, sanitized);
  }
  return sanitized;
}

// Prevent raw HTML in chat messages from being rendered as formatted HTML.
// Display it as escaped text so users see the literal markup.
// Security is handled by DOMPurify, but rendering pasted HTML (e.g. error
// pages) as formatted output is confusing UX (#13937).
const htmlEscapeRenderer = new marked.Renderer();
htmlEscapeRenderer.html = ({ text }: { text: string }) => escapeHtml(text);

// Combined renderer: code blocks with copy button + escaped raw HTML
const combinedRenderer = new marked.Renderer();
combinedRenderer.code = codeBlockRenderer.code.bind(codeBlockRenderer);
combinedRenderer.html = htmlEscapeRenderer.html.bind(htmlEscapeRenderer);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
