import DOMPurify from "dompurify";
import katex from "katex";
import { marked } from "marked";
import { truncateText } from "./format.ts";

marked.setOptions({
  gfm: true,
  breaks: true,
});

const allowedTags = [
  "a",
  "annotation",
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
  "math",
  "menclose",
  "merror",
  "mfrac",
  "mi",
  "mn",
  "mo",
  "mover",
  "mpadded",
  "mphantom",
  "mprescripts",
  "mroot",
  "mrow",
  "ms",
  "mspace",
  "msqrt",
  "mstyle",
  "msub",
  "msubsup",
  "msup",
  "mtable",
  "mtd",
  "mtext",
  "mtr",
  "munder",
  "munderover",
  "none",
  "ol",
  "p",
  "pre",
  "semantics",
  "span",
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

const allowedAttrs = [
  "alt",
  "aria-hidden",
  "class",
  "height",
  "href",
  "id",
  "mathvariant",
  "minsize",
  "maxsize",
  "rel",
  "rspace",
  "scriptlevel",
  "src",
  "start",
  "stretchy",
  "style",
  "target",
  "title",
  "viewbox",
  "width",
  "xmlns",
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

/**
 * Process LaTeX math expressions in markdown.
 * Supports both display math ($$...$$) and inline math ($...$).
 */

export function toSanitizedMarkdownHtml(
  markdown: string,
  options?: { skipLatex?: boolean },
): string {
  const skipLatex = options?.skipLatex ?? false;
  const input = markdown.trim();
  if (!input) {
    return "";
  }
  installHooks();
  // Cache key includes skipLatex flag so tool output and regular output cache separately
  const cacheKey = skipLatex ? `\x00nolx\x00${input}` : input;
  if (cacheKey.length <= MARKDOWN_CACHE_MAX_CHARS) {
    const cached = getCachedMarkdown(cacheKey);
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
    if (cacheKey.length <= MARKDOWN_CACHE_MAX_CHARS) {
      setCachedMarkdown(cacheKey, sanitized);
    }
    return sanitized;
  }

  const rawText = `${truncated.text}${suffix}`;
  let withPlaceholders: string;
  const latexMap = new Map<string, string>();

  if (skipLatex) {
    // Tool output: skip LaTeX processing so $ signs are left as-is
    withPlaceholders = rawText;
  } else {
    // LaTeX pipeline: extract $..$ and $$..$$, replace with placeholders,
    // run markdown, then restore rendered KaTeX HTML after sanitization.
    let placeholderIdx = 0;
    withPlaceholders = rawText
      // Display math first ($$...$$)
      .replace(/\$\$([^$]+)\$\$/g, (_match, latex) => {
        const key = `%%KATEX_D${placeholderIdx++}%%`;
        try {
          latexMap.set(
            key,
            katex.renderToString(latex.trim(), { displayMode: true, throwOnError: false }),
          );
        } catch {
          latexMap.set(key, `<code>${escapeHtml(latex)}</code>`);
        }
        return key;
      })
      // Inline math ($...$) — skip currency like $50
      .replace(/(?<!\$)\$(?!\$)([^$\n]+)\$(?!\$)/g, (_match, latex) => {
        if (!/[\\^_{}]/.test(latex)) {
          return _match;
        }
        const key = `%%KATEX_I${placeholderIdx++}%%`;
        try {
          latexMap.set(
            key,
            katex.renderToString(latex.trim(), { displayMode: false, throwOnError: false }),
          );
        } catch {
          latexMap.set(key, `<code>${escapeHtml(latex)}</code>`);
        }
        return key;
      });
  }

  const rendered = marked.parse(withPlaceholders, {
    renderer: htmlEscapeRenderer,
  }) as string;
  const sanitized = DOMPurify.sanitize(rendered, sanitizeOptions);

  // Restore KaTeX HTML (these are safe - we generated them ourselves)
  let final = sanitized;
  for (const [key, html] of latexMap) {
    final = final.replaceAll(key, html);
  }

  if (cacheKey.length <= MARKDOWN_CACHE_MAX_CHARS) {
    setCachedMarkdown(cacheKey, final);
  }
  return final;
}

// Prevent raw HTML in chat messages from being rendered as formatted HTML.
// Display it as escaped text so users see the literal markup.
// Security is handled by DOMPurify, but rendering pasted HTML (e.g. error
// pages) as formatted output is confusing UX (#13937).
const htmlEscapeRenderer = new marked.Renderer();
htmlEscapeRenderer.html = ({ text }: { text: string }) => escapeHtml(text);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
