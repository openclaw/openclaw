// ── KaTeX Rendering Core Module ──

let katexModule: typeof import("katex") | null = null;
let katexLoading: Promise<typeof import("katex")> | null = null;
let cssLoaded = false;

// ── Helpers ──

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function looksLikeMath(content: string): boolean {
  if (content.length === 0) {
    return false;
  }
  if (/\\[a-zA-Z]+/.test(content)) {
    return true;
  }
  if (/[\^_{}]/.test(content)) {
    return true;
  }
  return false;
}

function isSingleLetterVariable(content: string): boolean {
  if (content.length !== 1) {
    return false;
  }
  const ch = content.charCodeAt(0);
  return (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122);
}

/**
 * Check if a character following a closing `$` is a CJK punctuation
 * or ideograph that should count as a valid boundary for inline math.
 * This covers fullwidth punctuation (U+FF00–FFEF), CJK punctuation
 * (U+3000–303F), and CJK ideographs (U+4E00–9FFF, U+3400–4DBF).
 */
function isCJKBoundary(nextChar: string): boolean {
  const cp = nextChar.codePointAt(0);
  if (cp === undefined) {
    return false;
  }
  // Fullwidth punctuation: ，．！？）：；、
  if (cp >= 0xff01 && cp <= 0xff60) {
    return true;
  }
  // CJK punctuation: 。、「」【】
  if (cp >= 0x3001 && cp <= 0x303f) {
    return true;
  }
  // CJK ideographs — a closing $ before a CJK character is a valid boundary
  if (cp >= 0x4e00 && cp <= 0x9fff) {
    return true;
  }
  if (cp >= 0x3400 && cp <= 0x4dbf) {
    return true;
  }
  // Korean Hangul
  if (cp >= 0xac00 && cp <= 0xd7af) {
    return true;
  }
  // Katakana / Hiragana
  if (cp >= 0x3040 && cp <= 0x30ff) {
    return true;
  }
  return false;
}

// ── findInlineMathEnd ──

/**
 * Find the closing `$` for an inline math block starting at `start`
 * (position of the opening `$`). Returns the index of the closing `$`,
 * or -1 if none found or the content is not valid math.
 */
export function findInlineMathEnd(text: string, start: number): number {
  let hasBackslashCommand = false;
  let content = "";

  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];

    if (ch === "\n" && i + 1 < text.length && text[i + 1] === "\n") {
      return -1;
    }

    if (ch === "\\" && i + 1 < text.length && text[i + 1] === "$") {
      content += "\\$";
      i++;
      continue;
    }

    if (ch === "\\" && i + 1 < text.length && /[a-zA-Z]/.test(text[i + 1])) {
      hasBackslashCommand = true;
    }

    if (ch === "$") {
      const nextChar = i + 1 < text.length ? text[i + 1] : null;
      const isBoundary =
        nextChar === null ||
        /[\s.,;:!?)\]}"'`-]/.test(nextChar) ||
        nextChar === "$" ||
        nextChar === "\n" ||
        isCJKBoundary(nextChar);

      if (isBoundary) {
        if (content.length === 0) {
          return -1;
        }
        if (hasBackslashCommand) {
          return i;
        }
        if (looksLikeMath(content)) {
          return i;
        }
        if (isSingleLetterVariable(content)) {
          return i;
        }
        if (/^[\d., ]+$/.test(content)) {
          return -1;
        }
        return i;
      }
    }

    content += ch;
  }

  return -1;
}

// ── extractMathBlocks ──

/**
 * Scan a markdown string, extract all math blocks (display and inline),
 * and replace them with null-byte-delimited placeholder tokens.
 *
 * Placeholder format: \x00KATEX_PLACEHOLDER_N\x00
 *
 * Returns the protected text and a Map from placeholder → { tex, displayMode }.
 */
export function extractMathBlocks(markdown: string): {
  protectedText: string;
  mathBlocks: Map<string, { tex: string; displayMode: boolean }>;
} {
  const mathBlocks = new Map<string, { tex: string; displayMode: boolean }>();
  let placeholderId = 0;

  const result: string[] = [];
  let i = 0;
  const len = markdown.length;

  while (i < len) {
    // Fenced code blocks: markdown-it accepts 3+ backticks or 3+ tildes as fence openers.
    // The closing fence must use the same character and have length >= opener length.
    const ch = markdown[i];
    if ((ch === "`" || ch === "~") && markdown[i + 1] === ch && markdown[i + 2] === ch) {
      let fenceLen = 3;
      while (i + fenceLen < len && markdown[i + fenceLen] === ch) {
        fenceLen++;
      }
      const fenceStart = i;
      i += fenceLen;
      // Skip the info string (rest of the opening line)
      while (i < len && markdown[i] !== "\n") {
        i++;
      }
      if (i < len) {
        i++;
      }
      // Find closing fence: same char, length >= fenceLen, on its own line
      while (i < len) {
        const lineStart = i;
        // Skip leading spaces (markdown-it allows up to 3 spaces before closing fence)
        while (i < len && markdown[i] === " " && i - lineStart < 3) {
          i++;
        }
        if (markdown[i] === ch) {
          let closeLen = 0;
          while (i + closeLen < len && markdown[i + closeLen] === ch) {
            closeLen++;
          }
          if (closeLen >= fenceLen) {
            // Closing fence must be followed by whitespace or newline only
            const afterFence = i + closeLen;
            if (
              afterFence >= len ||
              markdown[afterFence] === "\n" ||
              markdown[afterFence] === " "
            ) {
              i = afterFence;
              while (i < len && markdown[i] !== "\n") {
                i++;
              }
              if (i < len) {
                i++;
              }
              break;
            }
          }
        }
        while (i < len && markdown[i] !== "\n") {
          i++;
        }
        if (i < len) {
          i++;
        }
      }
      result.push(markdown.slice(fenceStart, i));
      continue;
    }

    if (markdown[i] === "`") {
      let tickCount = 0;
      while (i + tickCount < len && markdown[i + tickCount] === "`") {
        tickCount++;
      }
      // 1-2 backticks: inline code (not a fence)
      if (tickCount < 3) {
        const closingStart = findClosingBackticks(markdown, i + tickCount, tickCount);
        if (closingStart !== -1) {
          result.push(markdown.slice(i, closingStart + tickCount));
          i = closingStart + tickCount;
          continue;
        }
        result.push("`");
        i++;
        continue;
      }
      // 3+ backticks without a newline after → treat as inline code (not a fence)
      // This path is rare; the fence block above already handled the normal case
      const closingStart = findClosingBackticks(markdown, i + tickCount, tickCount);
      if (closingStart !== -1) {
        result.push(markdown.slice(i, closingStart + tickCount));
        i = closingStart + tickCount;
        continue;
      }
      result.push(markdown.slice(i, i + tickCount));
      i += tickCount;
      continue;
    }

    if (markdown[i] === "\\" && i + 1 < len && markdown[i + 1] === "$") {
      result.push("$");
      i += 2;
      continue;
    }

    if (markdown[i] === "\\" && i + 1 < len && markdown[i + 1] === "[" && i + 2 < len) {
      const contentStart = i + 2;
      let j = contentStart;
      while (j < len) {
        if (markdown[j] === "\\" && j + 1 < len && markdown[j + 1] === "]") {
          const tex = markdown.slice(contentStart, j).trim();
          const ph = `\x00KATEX_PLACEHOLDER_${placeholderId++}\x00`;
          mathBlocks.set(ph, { tex, displayMode: true });
          result.push(ph);
          i = j + 2;
          break;
        }
        j++;
      }
      if (j >= len) {
        result.push("\\[");
        i += 2;
      }
      continue;
    }

    if (markdown[i] === "\\" && i + 1 < len && markdown[i + 1] === "(" && i + 2 < len) {
      const contentStart = i + 2;
      let j = contentStart;
      while (j < len) {
        if (markdown[j] === "\\" && j + 1 < len && markdown[j + 1] === ")") {
          const tex = markdown.slice(contentStart, j).trim();
          const ph = `\x00KATEX_PLACEHOLDER_${placeholderId++}\x00`;
          mathBlocks.set(ph, { tex, displayMode: false });
          result.push(ph);
          i = j + 2;
          break;
        }
        j++;
      }
      if (j >= len) {
        result.push("\\(");
        i += 2;
      }
      continue;
    }

    if (markdown[i] === "$" && i + 1 < len && markdown[i + 1] === "$") {
      const contentStart = i + 2;
      let j = contentStart;
      while (j < len) {
        if (markdown[j] === "$" && j + 1 < len && markdown[j + 1] === "$") {
          const tex = markdown.slice(contentStart, j).trim();
          const ph = `\x00KATEX_PLACEHOLDER_${placeholderId++}\x00`;
          mathBlocks.set(ph, { tex, displayMode: true });
          result.push(ph);
          i = j + 2;
          break;
        }
        j++;
      }
      if (j >= len) {
        result.push("$$");
        i += 2;
      }
      continue;
    }

    if (markdown[i] === "$") {
      const end = findInlineMathEnd(markdown, i);
      if (end !== -1) {
        const tex = markdown.slice(i + 1, end).trim();
        const ph = `\x00KATEX_PLACEHOLDER_${placeholderId++}\x00`;
        mathBlocks.set(ph, { tex, displayMode: false });
        result.push(ph);
        i = end + 1;
        continue;
      }
      result.push("$");
      i++;
      continue;
    }

    result.push(markdown[i]);
    i++;
  }

  return {
    protectedText: result.join(""),
    mathBlocks,
  };
}

function findClosingBackticks(text: string, start: number, count: number): number {
  for (let i = start; i < text.length; i++) {
    if (text[i] === "`") {
      let tickCount = 0;
      while (i + tickCount < text.length && text[i + tickCount] === "`") {
        tickCount++;
      }
      if (tickCount === count) {
        if (i + tickCount < text.length && text[i + tickCount] === "`") {
          i += tickCount - 1;
          continue;
        }
        return i;
      }
      i += tickCount - 1;
    }
  }
  return -1;
}

// ── preProcessTex ──

/**
 * Preprocess LaTeX source before rendering. Normalizes constructs
 * that KaTeX does not support:
 * - multline* → gather*
 * - Strips \require{...} and \definecolor{...}
 * - \ce{...} → \mathrm{...}
 */
export function preProcessTex(tex: string, _displayMode: boolean): string {
  let result = tex;
  result = result.replace(/\\begin\{multline\*?\}/g, "\\begin{gather*}");
  result = result.replace(/\\end\{multline\*?\}/g, "\\end{gather*}");
  result = result.replace(/\\require\{[^}]*\}/g, "");
  result = result.replace(/\\definecolor\{[^}]*\}\{[^}]*\}\{[^}]*\}/g, "");
  result = result.replace(/\\ce\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g, "\\mathrm{$1}");
  return result;
}

// ── restoreMathBlocksSync ──

/**
 * Replace math placeholders in rendered HTML with KaTeX output.
 * Must be called synchronously during rendering — katexModule must
 * be preloaded first via preloadKatex().
 *
 * Falls back to <code class="katex-fallback"> when katex is not yet
 * loaded or rendering produces an error.
 */
/** Handle both \x00 and \ufffd variants — markdown-it converts \x00 → \ufffd. */
function replacePlaceholder(html: string, ph: string, replacement: string): string {
  let result = html.replaceAll(ph, replacement);
  if (ph.includes("\x00")) {
    result = result.replaceAll(ph.replaceAll("\x00", "\ufffd"), replacement);
  }
  return result;
}

export function restoreMathBlocksSync(
  html: string,
  mathBlocks: Map<string, { tex: string; displayMode: boolean }>,
): string {
  if (mathBlocks.size === 0) {
    return html;
  }

  if (!katexModule) {
    let result = html;
    for (const [ph, { tex }] of mathBlocks) {
      result = replacePlaceholder(
        result,
        ph,
        `<code class="katex-fallback">${escapeHtml(tex)}</code>`,
      );
    }
    return result;
  }

  let result = html;
  for (const [ph, { tex, displayMode }] of mathBlocks) {
    const processedTex = preProcessTex(tex, displayMode);
    let rendered: string;
    try {
      rendered = katexModule.renderToString(processedTex, {
        displayMode,
        throwOnError: false,
        trust: false,
        strict: false,
        maxSize: 100,
      });
    } catch {
      rendered = `<code class="katex-fallback">${escapeHtml(tex)}</code>`;
    }
    if (rendered.includes("katex-error")) {
      rendered = `<code class="katex-fallback">${escapeHtml(tex)}</code>`;
    }
    result = replacePlaceholder(result, ph, rendered);
  }
  return result;
}

// ── Module loading ──

/**
 * Preload the KaTeX module asynchronously. Once loaded, the module
 * is available synchronously via getKatexModule(). Safe to call
 * multiple times.
 */
export function preloadKatex(): Promise<typeof import("katex")> {
  if (katexModule) {
    return Promise.resolve(katexModule);
  }
  if (katexLoading) {
    return katexLoading;
  }
  katexLoading = import("katex").then((mod) => {
    katexModule = mod;
    return mod;
  });
  katexLoading.catch(() => {
    katexLoading = null;
  });
  return katexLoading;
}

/**
 * Return the loaded KaTeX module, or null if not yet loaded.
 */
export function getKatexModule(): typeof import("katex") | null {
  return katexModule;
}

// ── CSS loading ──

/**
 * Dynamically load the KaTeX CSS stylesheet. Does nothing in SSR
 * environments (where `document` is undefined). Safe to call
 * multiple times.
 */
export function loadKatexCss(): void {
  if (cssLoaded) {
    return;
  }
  if (typeof document === "undefined") {
    return;
  }
  // Mark pending so loadKatexCss() is not re-entered while the <link> is loading
  cssLoaded = true;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  import("katex/dist/katex.min.css?url")
    .then((url) => {
      link.href = url.default;
      // The ?url import resolves once the bundler emits the asset URL,
      // but the browser may still fail to fetch the stylesheet itself.
      // Attach load/error handlers so failures reset cssLoaded for retry.
      link.addEventListener("load", () => {});
      link.addEventListener("error", () => {
        console.warn("[katex] Browser failed to load stylesheet from", url.default);
        cssLoaded = false;
        link.remove();
      });
      document.head.appendChild(link);
    })
    .catch((err) => {
      console.warn("[katex] Failed to resolve CSS URL:", err);
      cssLoaded = false;
    });
}
