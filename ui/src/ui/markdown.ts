import DOMPurify from "dompurify";
import { marked } from "marked";
import katex from "katex";
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
function processLatex(text: string): string {
  // Track positions to avoid processing LaTeX inside code blocks
  const codeBlockPattern = /```[\s\S]*?```|`[^`]+`/g;
  const codeBlocks: Array<{ start: number; end: number }> = [];
  let match;
  
  while ((match = codeBlockPattern.exec(text)) !== null) {
    codeBlocks.push({ start: match.index, end: match.index + match[0].length });
  }

  function isInCodeBlock(index: number): boolean {
    return codeBlocks.some(block => index >= block.start && index < block.end);
  }

  // Process display math ($$...$$) first
  let result = text;
  const displayMathPattern = /\$\$([^\$]+)\$\$/g;
  const displayMatches: Array<{ match: string; latex: string; index: number }> = [];
  
  while ((match = displayMathPattern.exec(text)) !== null) {
    if (!isInCodeBlock(match.index)) {
      displayMatches.push({
        match: match[0],
        latex: match[1].trim(),
        index: match.index,
      });
    }
  }

  // Replace display math from end to start to preserve indices
  for (let i = displayMatches.length - 1; i >= 0; i--) {
    const { match, latex, index } = displayMatches[i];
    try {
      const rendered = katex.renderToString(latex, {
        displayMode: true,
        throwOnError: false,
        trust: false,
      });
      result = result.substring(0, index) + rendered + result.substring(index + match.length);
    } catch (error) {
      console.warn("KaTeX display math rendering error:", error);
    }
  }

  // Process inline math ($...$)
  // Use a more careful pattern to avoid matching $$ from display math
  const inlineMathPattern = /(?<!\$)\$(?!\$)([^\$\n]+)\$(?!\$)/g;
  const inlineMatches: Array<{ match: string; latex: string; index: number }> = [];
  
  while ((match = inlineMathPattern.exec(result)) !== null) {
    if (!isInCodeBlock(match.index)) {
      inlineMatches.push({
        match: match[0],
        latex: match[1].trim(),
        index: match.index,
      });
    }
  }

  // Replace inline math from end to start to preserve indices
  for (let i = inlineMatches.length - 1; i >= 0; i--) {
    const { match, latex, index } = inlineMatches[i];
    try {
      const rendered = katex.renderToString(latex, {
        displayMode: false,
        throwOnError: false,
        trust: false,
      });
      result = result.substring(0, index) + rendered + result.substring(index + match.length);
    } catch (error) {
      console.warn("KaTeX inline math rendering error:", error);
    }
  }

  return result;
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
  // Process LaTeX before markdown rendering
  const withLatex = processLatex(`${truncated.text}${suffix}`);
  const rendered = marked.parse(withLatex, {
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
