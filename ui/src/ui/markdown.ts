import DOMPurify from "dompurify";
import { marked } from "marked";
import mermaid from "mermaid";
import { truncateText } from "./format.ts";
import { normalizeLowercaseStringOrEmpty } from "./string-coerce.ts";

// Initialize mermaid
mermaid.initialize({
  startOnLoad: false,
  theme: "default",
  securityLevel: "strict",
});

// Extend Window interface for mermaid copy handler
declare global {
  interface Window {
    __copyMermaid?: (btn: HTMLElement) => void;
  }
}

// Global mermaid copy handler (uses event delegation via click on .mermaid-copy)
window.__copyMermaid = (btn: HTMLElement) => {
  const code = btn.dataset.code ?? "";
  navigator.clipboard.writeText(code).then(
    () => {
      // Show feedback
      const icon = btn.querySelector(".copy-icon");
      if (icon) {
        const original = icon.textContent;
        icon.textContent = "✅";
        setTimeout(() => (icon.textContent = original), 1500);
      }
    },
    (err) => {
      console.error("[mermaid-copy] copy failed:", err);
    },
  );
};

// Global mermaid handlers - use event delegation (browser only)
if (typeof window !== "undefined" && typeof document !== "undefined") {
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;

    // Handle copy button click
    const copyBtn = target.closest(".mermaid-copy");
    if (copyBtn) {
      window.__copyMermaid?.(copyBtn as HTMLButtonElement);
      return;
    }

    // Handle fullscreen click
    const container = target.closest(".mermaid-container");
    if (!container) {
      return;
    }
    const svg = container.querySelector("svg");
    if (!svg) {
      return;
    }

    // Create fullscreen container
    let fullscreenContainer = document.querySelector(".mermaid-fullscreen") as HTMLDivElement;
    if (!fullscreenContainer) {
      fullscreenContainer = document.createElement("div");
      fullscreenContainer.className = "mermaid-fullscreen";
      fullscreenContainer.addEventListener("click", () => {
        fullscreenContainer.classList.remove("active");
      });
      document.body.appendChild(fullscreenContainer);
    }

    // Clone and append SVG
    fullscreenContainer.innerHTML = "";
    const clonedSvg = svg.cloneNode(true) as SVGElement;
    clonedSvg.style.background = "white";
    clonedSvg.style.borderRadius = "8px";
    fullscreenContainer.appendChild(clonedSvg);

    // Add hint text without re-serializing SVG
    const hint = document.createElement("span");
    hint.className = "mermaid-fullscreen-hint";
    hint.textContent = "点击任意位置关闭";
    fullscreenContainer.appendChild(hint);

    fullscreenContainer.classList.add("active");
  });
}

const allowedTags = [
  "a",
  "b",
  "blockquote",
  "br",
  "button",
  "code",
  "del",
  "details",
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
  "summary",
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
  "aria-label",
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
const INLINE_DATA_IMAGE_RE = /^data:image\/[a-z0-9.+-]+;base64,/i;
const markdownCache = new Map<string, string>();
const TAIL_LINK_BLUR_CLASS = "chat-link-tail-blur";

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
    if (normalizeLowercaseStringOrEmpty(href).includes("tail")) {
      node.classList.add(TAIL_LINK_BLUR_CLASS);
    }
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
    // Large plain-text replies should stay readable without inheriting the
    // capped code-block chrome, while still preserving whitespace for logs
    // and other structured text that commonly trips the parse guard.
    const html = renderEscapedPlainTextHtml(`${truncated.text}${suffix}`);
    const sanitized = DOMPurify.sanitize(html, sanitizeOptions);
    if (input.length <= MARKDOWN_CACHE_MAX_CHARS) {
      setCachedMarkdown(input, sanitized);
    }
    return sanitized;
  }
  let rendered: string;
  try {
    rendered = marked.parse(`${truncated.text}${suffix}`, {
      renderer: htmlEscapeRenderer,
      gfm: true,
      breaks: true,
    }) as string;
  } catch (err) {
    // Fall back to escaped plain text when marked.parse() throws (e.g.
    // infinite recursion on pathological markdown patterns — #36213).
    console.warn("[markdown] marked.parse failed, falling back to plain text:", err);
    const escaped = escapeHtml(`${truncated.text}${suffix}`);
    rendered = `<pre class="code-block">${escaped}</pre>`;
  }
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
htmlEscapeRenderer.image = (token: { href?: string | null; text?: string | null }) => {
  const label = normalizeMarkdownImageLabel(token.text);
  const href = token.href?.trim() ?? "";
  if (!INLINE_DATA_IMAGE_RE.test(href)) {
    return escapeHtml(label);
  }
  return `<img class="markdown-inline-image" src="${escapeHtml(href)}" alt="${escapeHtml(label)}">`;
};

function normalizeMarkdownImageLabel(text?: string | null): string {
  const trimmed = text?.trim();
  return trimmed ? trimmed : "image";
}

htmlEscapeRenderer.code = ({
  text,
  lang,
  escaped,
}: {
  text: string;
  lang?: string;
  escaped?: boolean;
}) => {
  // Handle mermaid code blocks
  if (lang === "mermaid") {
    const trimmed = text.trim();
    const escapedCode = escapeHtml(trimmed);
    // Create enhanced container with source code and copy button
    const copyBtn = `<button type="button" class="mermaid-copy" data-code="${escapedCode}" aria-label="Copy mermaid code">
      <span class="copy-icon">📋</span>
    </button>`;
    const header = `<div class="mermaid-header">
      <span class="mermaid-label">mermaid</span>
      ${copyBtn}
    </div>`;
    const sourceCode = `<pre class="mermaid-source"><code>${escapedCode}</code></pre>`;
    // Container with mermaid graph placeholder and source code
    return `<div class="mermaid-wrapper">
      ${header}
      <div class="mermaid-container">
        <div class="mermaid">${escapedCode}</div>
      </div>
      <details class="mermaid-source-details">
        <summary>显示源码</summary>
        ${sourceCode}
      </details>
    </div>`;
  }

  const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : "";
  const safeText = escaped ? text : escapeHtml(text);
  const codeBlock = `<pre><code${langClass}>${safeText}</code></pre>`;
  const langLabel = lang ? `<span class="code-block-lang">${escapeHtml(lang)}</span>` : "";
  const attrSafe = text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const copyBtn = `<button type="button" class="code-block-copy" data-code="${attrSafe}" aria-label="Copy code"><span class="code-block-copy__idle">Copy</span><span class="code-block-copy__done">Copied!</span></button>`;
  const header = `<div class="code-block-header">${langLabel}${copyBtn}</div>`;

  const trimmed = text.trim();
  const isJson =
    lang === "json" ||
    (!lang &&
      ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))));

  if (isJson) {
    const lineCount = text.split("\n").length;
    const label = lineCount > 1 ? `JSON &middot; ${lineCount} lines` : "JSON";
    return `<details class="json-collapse"><summary>${label}</summary><div class="code-block-wrapper">${header}${codeBlock}</div></details>`;
  }

  return `<div class="code-block-wrapper">${header}${codeBlock}</div>`;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderEscapedPlainTextHtml(value: string): string {
  return `<div class="markdown-plain-text-fallback">${escapeHtml(value.replace(/\r\n?/g, "\n"))}</div>`;
}

// Render mermaid diagrams in a given container element
export async function renderMermaidInContainer(container: HTMLElement): Promise<void> {
  const mermaidElements = container.querySelectorAll(".mermaid");
  if (mermaidElements.length === 0) {
    return;
  }

  for (const element of mermaidElements) {
    // Skip elements that have already been rendered (contain SVG)
    if (element.querySelector("svg")) {
      continue;
    }

    const graphDefinition = element.textContent?.trim() || "";
    if (!graphDefinition) {
      continue;
    }

    try {
      // Use a unique temp id for mermaid.render to avoid DOM conflicts
      const tempId = `mermaid-render-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const { svg } = await mermaid.render(tempId, graphDefinition);
      element.innerHTML = svg;
    } catch (err) {
      console.error("[mermaid] render failed:", err);
      element.innerHTML = `<span class="mermaid-error">Mermaid 渲染失败: ${escapeHtml(String(err))}</span>`;
    }
  }
}
