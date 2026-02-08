import DOMPurify from "dompurify";
import { marked, type Tokens } from "marked";
import { truncateText } from "./format.ts";

marked.setOptions({
  gfm: true,
  breaks: true,
});

// Custom renderer to add copy button to code blocks
const renderer = new marked.Renderer();
let codeBlockId = 0;

renderer.code = ({ text, lang }: Tokens.Code) => {
  const id = `code-block-${++codeBlockId}`;
  const language = lang ? escapeHtml(lang) : "";
  const escaped = escapeHtml(text);
  const codeClass = language ? ` class="language-${language}"` : "";
  // GitHub style: floating button, no header bar
  return `<div class="code-block-wrapper" data-code-id="${id}">
    <button class="code-block-copy-btn" type="button" title="Copy code" aria-label="Copy code" data-code-id="${id}">
      <svg class="code-block-copy-icon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
      <svg class="code-block-check-icon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
    </button>
    <pre><code${codeClass}>${escaped}</code></pre>
  </div>`;
};

marked.use({ renderer });

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
  "path",
  "polyline",
  "pre",
  "rect",
  "span",
  "strong",
  "svg",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
];

const allowedAttrs = [
  "aria-label",
  "class",
  "d",
  "data-code-id",
  "fill",
  "height",
  "href",
  "points",
  "rel",
  "rx",
  "ry",
  "start",
  "stroke",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-width",
  "target",
  "title",
  "type",
  "viewBox",
  "width",
  "x",
  "y",
];

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
    const sanitized = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: allowedTags,
      ALLOWED_ATTR: allowedAttrs,
    });
    if (input.length <= MARKDOWN_CACHE_MAX_CHARS) {
      setCachedMarkdown(input, sanitized);
    }
    return sanitized;
  }
  const rendered = marked.parse(`${truncated.text}${suffix}`) as string;
  const sanitized = DOMPurify.sanitize(rendered, {
    ALLOWED_TAGS: allowedTags,
    ALLOWED_ATTR: allowedAttrs,
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

// Initialize code block copy functionality via event delegation
let codeBlockCopyInitialized = false;

export function initCodeBlockCopy() {
  if (codeBlockCopyInitialized) {
    return;
  }
  codeBlockCopyInitialized = true;

  document.addEventListener("click", async (e) => {
    const target = e.target as HTMLElement;
    const closest = target.closest(".code-block-copy-btn");
    if (!closest || !(closest instanceof HTMLButtonElement)) {
      return;
    }
    const button = closest;

    const codeId = button.dataset.codeId;
    if (!codeId) {
      return;
    }

    const wrapper = button.closest(".code-block-wrapper");
    if (!wrapper) {
      return;
    }

    const codeElement = wrapper.querySelector("pre code");
    if (!codeElement) {
      return;
    }

    const text = codeElement.textContent ?? "";
    if (!text) {
      return;
    }

    // Prevent double-click
    if (button.dataset.copying === "1") {
      return;
    }

    button.dataset.copying = "1";
    button.disabled = true;

    try {
      await navigator.clipboard.writeText(text);
      button.dataset.copied = "1";
      button.title = "Copied";
      button.setAttribute("aria-label", "Copied");

      setTimeout(() => {
        delete button.dataset.copied;
        button.title = "Copy code";
        button.setAttribute("aria-label", "Copy code");
      }, 1500);
    } catch {
      button.dataset.error = "1";
      button.title = "Copy failed";
      button.setAttribute("aria-label", "Copy failed");

      setTimeout(() => {
        delete button.dataset.error;
        button.title = "Copy code";
        button.setAttribute("aria-label", "Copy code");
      }, 2000);
    } finally {
      delete button.dataset.copying;
      button.disabled = false;
    }
  });
}
