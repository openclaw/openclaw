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
  ADD_DATA_URI_TAGS: ["img"],
};

const MATH_PLACEHOLDER_PREFIX = "KATEXPLACEHOLDER";

function extractAndRenderMath(text: string): { text: string; replacements: Map<string, string> } {
  const replacements = new Map<string, string>();
  let counter = 0;

  const parts = text.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  const processed = parts.map((part, i) => {
    if (i % 2 === 1) {
      return part;
    }

    let result = part.replace(/\$\$([\s\S]+?)\$\$/g, (_match, expr: string) => {
      const placeholder = `${MATH_PLACEHOLDER_PREFIX}${counter++}END`;
      try {
        replacements.set(
          placeholder,
          katex.renderToString(expr.trim(), { displayMode: true, throwOnError: false }),
        );
      } catch {
        replacements.set(placeholder, `<pre>${escapeHtml(expr)}</pre>`);
      }
      return placeholder;
    });

    result = result.replace(/\\\[([\s\S]+?)\\\]/g, (_match, expr: string) => {
      const placeholder = `${MATH_PLACEHOLDER_PREFIX}${counter++}END`;
      try {
        replacements.set(
          placeholder,
          katex.renderToString(expr.trim(), { displayMode: true, throwOnError: false }),
        );
      } catch {
        replacements.set(placeholder, `<pre>${escapeHtml(expr)}</pre>`);
      }
      return placeholder;
    });

    result = result.replace(
      /(?<!\$)\$(?!\$)(?!\d)((?:[^$\\]|\\[\s\S])+?)\$(?!\$)/g,
      (_match, expr: string) => {
        const placeholder = `${MATH_PLACEHOLDER_PREFIX}${counter++}END`;
        try {
          replacements.set(
            placeholder,
            katex.renderToString(expr.trim(), { displayMode: false, throwOnError: false }),
          );
        } catch {
          replacements.set(placeholder, `<code>${escapeHtml(expr)}</code>`);
        }
        return placeholder;
      },
    );

    result = result.replace(/\\\(([\s\S]+?)\\\)/g, (_match, expr: string) => {
      const placeholder = `${MATH_PLACEHOLDER_PREFIX}${counter++}END`;
      try {
        replacements.set(
          placeholder,
          katex.renderToString(expr.trim(), { displayMode: false, throwOnError: false }),
        );
      } catch {
        replacements.set(placeholder, `<code>${escapeHtml(expr)}</code>`);
      }
      return placeholder;
    });

    return result;
  });

  return { text: processed.join(""), replacements };
}

function restoreMath(html: string, replacements: Map<string, string>): string {
  if (replacements.size === 0) {
    return html;
  }
  let result = html;
  for (const [placeholder, rendered] of replacements) {
    const escaped = escapeHtml(placeholder);
    result = result.replaceAll(escaped, rendered);
    result = result.replaceAll(placeholder, rendered);
  }
  return result;
}

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
  const { text: mathProcessed, replacements } = extractAndRenderMath(`${truncated.text}${suffix}`);
  const rendered = marked.parse(mathProcessed, {
    renderer: htmlEscapeRenderer,
  }) as string;
  const sanitized = DOMPurify.sanitize(rendered, sanitizeOptions);
  const final = restoreMath(sanitized, replacements);
  if (input.length <= MARKDOWN_CACHE_MAX_CHARS) {
    setCachedMarkdown(input, final);
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
