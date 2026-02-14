import DOMPurify from "dompurify";
import { marked } from "marked";
import { truncateText } from "./format.ts";

// Lazy-loaded Mermaid instance
let mermaidInstance: typeof import("mermaid").default | null = null;
let mermaidLoading: Promise<void> | null = null;

// Mermaid render cache - separate from markdown cache
const mermaidCache = new Map<string, string>();
const MERMAID_CACHE_LIMIT = 100; // Cache up to 100 diagrams

// Performance metrics
interface MermaidMetrics {
  cacheHits: number;
  cacheMisses: number;
  totalRenders: number;
  avgRenderTime: number;
  renderTimes: number[];
}

const metrics: MermaidMetrics = {
  cacheHits: 0,
  cacheMisses: 0,
  totalRenders: 0,
  avgRenderTime: 0,
  renderTimes: [],
};

/**
 * Lazy load Mermaid library only when needed
 * Uses singleton pattern with promise caching to prevent multiple loads
 */
async function ensureMermaidLoaded(): Promise<typeof import("mermaid").default> {
  if (mermaidInstance) {
    return mermaidInstance;
  }

  // Prevent parallel loads
  if (mermaidLoading) {
    await mermaidLoading;
    return mermaidInstance!;
  }

  mermaidLoading = (async () => {
    try {
      const mermaidModule = await import("mermaid");
      mermaidInstance = mermaidModule.default;

      // Initialize on first load
      mermaidInstance.initialize({
        startOnLoad: false,
        theme: "default",
        securityLevel: "strict",
        fontFamily: "inherit",
      });

      console.log("✅ Mermaid lazy-loaded and initialized");
    } catch (error) {
      console.error("❌ Mermaid lazy load failed:", error);
      throw error;
    }
  })();

  await mermaidLoading;
  return mermaidInstance!;
}

/**
 * Get cached Mermaid SVG or return null
 */
function getCachedMermaidSVG(code: string): string | null {
  const cached = mermaidCache.get(code);
  if (cached) {
    metrics.cacheHits++;
    // LRU: move to end
    mermaidCache.delete(code);
    mermaidCache.set(code, cached);
  }
  return cached || null;
}

/**
 * Cache rendered Mermaid SVG with LRU eviction
 */
function setCachedMermaidSVG(code: string, svg: string): void {
  mermaidCache.set(code, svg);

  // LRU eviction
  if (mermaidCache.size > MERMAID_CACHE_LIMIT) {
    const oldest = mermaidCache.keys().next().value;
    if (oldest) {
      mermaidCache.delete(oldest);
    }
  }
}

/**
 * Render Mermaid diagram with caching and performance tracking
 */
async function renderMermaidDiagram(code: string): Promise<string> {
  // Check cache first
  const cached = getCachedMermaidSVG(code);
  if (cached) {
    return cached;
  }

  metrics.cacheMisses++;
  metrics.totalRenders++;

  // Lazy load Mermaid
  const startTime = performance.now();
  const mermaid = await ensureMermaidLoaded();

  try {
    const id = `mermaid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const { svg } = await mermaid.render(id, code);

    // Track performance
    const renderTime = performance.now() - startTime;
    metrics.renderTimes.push(renderTime);
    if (metrics.renderTimes.length > 100) {
      metrics.renderTimes.shift(); // Keep last 100 samples
    }
    metrics.avgRenderTime =
      metrics.renderTimes.reduce((a, b) => a + b, 0) / metrics.renderTimes.length;

    // Cache the result
    setCachedMermaidSVG(code, svg);

    return svg;
  } catch (error) {
    console.error("❌ Mermaid rendering failed:", error);
    throw error;
  }
}

/**
 * Get current performance metrics
 */
export function getMermaidMetrics(): MermaidMetrics & { cacheHitRate: number } {
  const total = metrics.cacheHits + metrics.cacheMisses;
  const cacheHitRate = total > 0 ? (metrics.cacheHits / total) * 100 : 0;

  return {
    ...metrics,
    cacheHitRate,
  };
}

/**
 * Reset performance metrics (for testing)
 */
export function resetMermaidMetrics(): void {
  metrics.cacheHits = 0;
  metrics.cacheMisses = 0;
  metrics.totalRenders = 0;
  metrics.avgRenderTime = 0;
  metrics.renderTimes = [];
}

/**
 * Clear Mermaid cache (for memory management)
 */
export function clearMermaidCache(): void {
  mermaidCache.clear();
  console.log("🧹 Mermaid cache cleared");
}

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
  // Mermaid SVG tags
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "defs",
  "marker",
  "foreignObject",
  "style",
  "div",
];

const allowedAttrs = [
  "class",
  "href",
  "rel",
  "target",
  "title",
  "start",
  // SVG attributes for Mermaid
  "viewBox",
  "width",
  "height",
  "xmlns",
  "fill",
  "stroke",
  "stroke-width",
  "d",
  "x",
  "y",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "transform",
  "id",
  "style",
  "font-size",
  "font-family",
  "text-anchor",
  "dominant-baseline",
];

let hooksInstalled = false;
const MARKDOWN_CHAR_LIMIT = 140_000;
const MARKDOWN_PARSE_LIMIT = 40_000;
const MARKDOWN_CACHE_LIMIT = 200;
const MARKDOWN_CACHE_MAX_CHARS = 50_000;
const markdownCache = new Map<string, string>();

// Custom renderer for Mermaid diagrams with async support
const renderer = new marked.Renderer();
const originalCodeRenderer = renderer.code.bind(renderer);

// Note: marked's renderer.code must be synchronous, so we use a placeholder approach
// The actual async rendering happens in toSanitizedMarkdownHtml
renderer.code = function ({
  text: code,
  lang: language,
  escaped,
}: {
  text: string;
  lang?: string;
  escaped?: boolean;
  type: string;
  raw: string;
  codeBlockStyle?: string;
}) {
  if (language === "mermaid") {
    // Return a placeholder that will be replaced by the async renderer
    const placeholder = `__MERMAID_PLACEHOLDER__${Buffer.from(code).toString("base64")}__END__`;
    return placeholder;
  }
  return originalCodeRenderer.call(this, {
    text: code,
    lang: language,
    escaped,
    type: "code",
    raw: code,
    codeBlockStyle: undefined,
  });
};

// Use custom renderer
marked.use({ renderer });

marked.setOptions({
  gfm: true,
  breaks: true,
});

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
 * Convert markdown to sanitized HTML with optimized Mermaid rendering
 * Now supports async Mermaid rendering with lazy loading
 */
export async function toSanitizedMarkdownHtml(markdown: string): Promise<string> {
  const input = markdown.trim();
  if (!input) {
    return "";
  }
  installHooks();

  // Check cache first
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

  // Fast path for very large content
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

  // Parse markdown
  let rendered = marked.parse(`${truncated.text}${suffix}`) as string;

  // Replace Mermaid placeholders with actual rendered diagrams
  const mermaidPlaceholderRegex = /__MERMAID_PLACEHOLDER__([A-Za-z0-9+/=]+)__END__/g;
  const mermaidMatches = Array.from(rendered.matchAll(mermaidPlaceholderRegex));

  if (mermaidMatches.length > 0) {
    // Render all Mermaid diagrams in parallel
    const renderPromises = mermaidMatches.map(async (match) => {
      const base64Code = match[1];
      const code = Buffer.from(base64Code, "base64").toString("utf-8");

      try {
        const svg = await renderMermaidDiagram(code);
        return {
          placeholder: match[0],
          replacement: `<div class="mermaid-diagram">${svg}</div>`,
        };
      } catch (error) {
        console.error("Mermaid rendering error:", error);
        return {
          placeholder: match[0],
          replacement: `<pre class="mermaid-error"><code>${escapeHtml(code)}</code></pre>`,
        };
      }
    });

    const results = await Promise.all(renderPromises);

    // Replace all placeholders
    for (const { placeholder, replacement } of results) {
      rendered = rendered.replace(placeholder, replacement);
    }
  }

  // Sanitize
  const sanitized = DOMPurify.sanitize(rendered, {
    ALLOWED_TAGS: allowedTags,
    ALLOWED_ATTR: allowedAttrs,
  });

  // Cache result
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
