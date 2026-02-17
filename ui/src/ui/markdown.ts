import DOMPurify from "dompurify";
import { marked } from "marked";
import { truncateText } from "./format.ts";

marked.setOptions({
  gfm: true,
  breaks: true,
});

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
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
  "img",
];

const allowedAttrs = ["class", "href", "rel", "target", "title", "start", "src", "alt"];
const sanitizeOptions = {
  ALLOWED_TAGS: allowedTags,
  ALLOWED_ATTR: allowedAttrs,
  ALLOW_DATA_ATTR: true,
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
    renderer: htmlEscapeRenderer,
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

// Emit mermaid code blocks as inert placeholders. The actual rendering is
// performed asynchronously by a MutationObserver installed via
// initMermaidRenderer().
const originalCode = htmlEscapeRenderer.code.bind(htmlEscapeRenderer);
htmlEscapeRenderer.code = function (token: Parameters<typeof originalCode>[0]) {
  if (token.lang === "mermaid") {
    const encoded = encodeMermaidAttr(token.text);
    return `<div class="mermaid-placeholder" data-mermaid-code="${encoded}"></div>`;
  }
  return originalCode(token);
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Encode mermaid source for use in an HTML data-attribute value.
 *  We use URI-encoding (encodeURIComponent) because DOMPurify 3.x strips
 *  attributes whose decoded value contains `-->` (mutation-XSS guard).
 *  URI-encoding avoids this entirely since `>` becomes `%3E`. */
function encodeMermaidAttr(value: string): string {
  return encodeURIComponent(value);
}

/* ── Mermaid DOM renderer ────────────────────────────── */

function decodeMermaidAttr(value: string): string {
  return decodeURIComponent(value);
}

// Lazy-loaded mermaid instance. The library is optional — when it is not
// installed the placeholders simply stay inert.
let mermaidPromise: Promise<{
  default: {
    initialize: (cfg: object) => void;
    render: (id: string, code: string) => Promise<{ svg: string }>;
  };
}> | null = null;

function loadMermaid() {
  if (!mermaidPromise) {
    // Wrap in a variable so Rollup/Vite does not attempt static resolution.
    const specifier = "mermaid";
    mermaidPromise = import(/* @vite-ignore */ specifier);
  }
  return mermaidPromise;
}

let mermaidInitialised = false;

async function renderMermaidPlaceholder(el: Element): Promise<void> {
  const code = el.getAttribute("data-mermaid-code");
  if (!code) {
    return;
  }
  const decoded = decodeMermaidAttr(code);
  try {
    const mermaidModule = await loadMermaid();
    const mermaid = mermaidModule.default;
    if (!mermaidInitialised) {
      mermaidInitialised = true;
      mermaid.initialize({
        startOnLoad: false,
        theme: "default",
        securityLevel: "strict",
        fontFamily: "inherit",
      });
    }
    const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const { svg } = await mermaid.render(id, decoded);
    el.classList.remove("mermaid-placeholder");
    el.classList.add("mermaid-diagram");
    el.removeAttribute("data-mermaid-code");
    el.innerHTML = svg;
  } catch {
    el.classList.remove("mermaid-placeholder");
    el.classList.add("mermaid-error");
    el.textContent = decoded;
  }
}

function processMermaidPlaceholders(root: ParentNode = document): void {
  const placeholders = root.querySelectorAll(".mermaid-placeholder[data-mermaid-code]");
  for (const el of placeholders) {
    void renderMermaidPlaceholder(el);
  }
}

/**
 * Watch the DOM for `<pre class="mermaid">` placeholders and render them.
 * Mermaid is loaded lazily on first match to avoid bloating the initial bundle.
 * If the mermaid package is not installed, this is a no-op.
 */
export function initMermaidRenderer(): void {
  // Render any placeholders already in the DOM.
  processMermaidPlaceholders();

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) {
          continue;
        }
        if (
          node.classList.contains("mermaid-placeholder") &&
          node.hasAttribute("data-mermaid-code")
        ) {
          void renderMermaidPlaceholder(node);
        }
        processMermaidPlaceholders(node);
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}
