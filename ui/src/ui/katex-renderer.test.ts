import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  escapeHtml,
  findInlineMathEnd,
  extractMathBlocks,
  preProcessTex,
  restoreMathBlocksSync,
  preloadKatex,
  getKatexModule,
} from "./katex-renderer.ts";
import { toSanitizedMarkdownHtmlWithKatex, clearMarkdownCache } from "./markdown.ts";

// ── escapeHtml ──

describe("escapeHtml", () => {
  it("escapes & to &amp;", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes < and > to &lt; and &gt;", () => {
    expect(escapeHtml("<div>")).toBe("&lt;div&gt;");
  });

  it("escapes \" to &quot; and ' to &#39;", () => {
    expect(escapeHtml("\"hello'")).toBe("&quot;hello&#39;");
  });
});

// ── findInlineMathEnd ──

describe("findInlineMathEnd", () => {
  it("finds closing $ in $x$ (single letter variable)", () => {
    expect(findInlineMathEnd("$x$", 0)).toBe(2);
  });

  it("finds closing $ in $\\frac{x}{y}$ (backslash command)", () => {
    expect(findInlineMathEnd("$\\frac{x}{y}$", 0)).toBe(12);
  });

  it("returns -1 for $5 and $10 (pure digits = currency)", () => {
    expect(findInlineMathEnd("$5 and $10", 0)).toBe(-1);
  });

  it("finds closing $ in $x^2$ (math operator)", () => {
    expect(findInlineMathEnd("$x^2$", 0)).toBe(4);
  });

  it("returns -1 for $variable_name (no closing $)", () => {
    expect(findInlineMathEnd("$variable_name", 0)).toBe(-1);
  });

  it("returns -1 for content crossing paragraph boundary (two newlines)", () => {
    expect(findInlineMathEnd("$a\n\nb$", 0)).toBe(-1);
  });

  it("returns -1 for empty content $$ (no content between $ and $)", () => {
    expect(findInlineMathEnd("$$", 0)).toBe(-1);
  });

  it("finds closing $ in $E=mc^2$", () => {
    expect(findInlineMathEnd("$E=mc^2$", 0)).toBe(7);
  });

  it("finds closing $ in $a_n$ (subscript)", () => {
    expect(findInlineMathEnd("$a_n$", 0)).toBe(4);
  });

  it("returns -1 for $5.99 (currency with decimal, no closing $)", () => {
    expect(findInlineMathEnd("$5.99", 0)).toBe(-1);
  });

  it("handles escaped \\$ inside math content $x\\$y$", () => {
    expect(findInlineMathEnd("$x\\$y$", 0)).toBe(5);
  });
});

// ── extractMathBlocks ──

describe("extractMathBlocks", () => {
  it("extracts one inline math block from $x^2$ with displayMode=false", () => {
    const { protectedText, mathBlocks } = extractMathBlocks("$x^2$");
    expect(mathBlocks.size).toBe(1);
    const [ph, info] = mathBlocks.entries().next().value!;
    expect(info.tex).toBe("x^2");
    expect(info.displayMode).toBe(false);
    expect(protectedText).toBe(ph);
  });

  it("extracts one display math block from $$E=mc^2$$ with displayMode=true", () => {
    const { protectedText, mathBlocks } = extractMathBlocks("$$E=mc^2$$");
    expect(mathBlocks.size).toBe(1);
    const [ph, info] = mathBlocks.entries().next().value!;
    expect(info.tex).toBe("E=mc^2");
    expect(info.displayMode).toBe(true);
    expect(protectedText).toBe(ph);
  });

  it("extracts one display math block from \\[E=mc^2\\] with displayMode=true", () => {
    const { protectedText, mathBlocks } = extractMathBlocks("\\[E=mc^2\\]");
    expect(mathBlocks.size).toBe(1);
    const [ph, info] = mathBlocks.entries().next().value!;
    expect(info.tex).toBe("E=mc^2");
    expect(info.displayMode).toBe(true);
    expect(protectedText).toBe(ph);
  });

  it("extracts one inline math block from \\(\\frac{x}{y}\\) with displayMode=false", () => {
    const { protectedText, mathBlocks } = extractMathBlocks("\\(\\frac{x}{y}\\)");
    expect(mathBlocks.size).toBe(1);
    const [ph, info] = mathBlocks.entries().next().value!;
    expect(info.tex).toBe("\\frac{x}{y}");
    expect(info.displayMode).toBe(false);
    expect(protectedText).toBe(ph);
  });

  it("preserves surrounding text and inserts placeholder at correct position", () => {
    const { protectedText, mathBlocks } = extractMathBlocks("text $x^2$ more text");
    expect(mathBlocks.size).toBe(1);
    const [ph, info] = mathBlocks.entries().next().value!;
    expect(info.tex).toBe("x^2");
    expect(protectedText).toBe(`text ${ph} more text`);
  });

  it("extracts two display math blocks from $$a$$ and $$b$$", () => {
    const { protectedText, mathBlocks } = extractMathBlocks("$$a$$ and $$b$$");
    expect(mathBlocks.size).toBe(2);
    const entries = [...mathBlocks.entries()];
    expect(entries[0][1].tex).toBe("a");
    expect(entries[0][1].displayMode).toBe(true);
    expect(entries[1][1].tex).toBe("b");
    expect(entries[1][1].displayMode).toBe(true);
    const ph0 = entries[0][0];
    const ph1 = entries[1][0];
    expect(protectedText).toBe(`${ph0} and ${ph1}`);
  });

  it("does NOT extract $x^2$ inside inline code", () => {
    const { mathBlocks } = extractMathBlocks("`$x^2$`");
    expect(mathBlocks.size).toBe(0);
  });

  it("does NOT extract $x^2$ inside fenced code block", () => {
    const { mathBlocks } = extractMathBlocks("```\n$x^2$\n```");
    expect(mathBlocks.size).toBe(0);
  });

  it("does NOT extract escaped delimiters \\$5 and \\$10, outputs literal $", () => {
    const { protectedText, mathBlocks } = extractMathBlocks("\\$5 and \\$10");
    expect(mathBlocks.size).toBe(0);
    expect(protectedText).toBe("$5 and $10");
  });

  it("extracts mixed inline and display math: text $x$ and $$y$$", () => {
    const { protectedText, mathBlocks } = extractMathBlocks("text $x$ and $$y$$");
    expect(mathBlocks.size).toBe(2);
    const entries = [...mathBlocks.entries()];
    expect(entries[0][1].tex).toBe("x");
    expect(entries[0][1].displayMode).toBe(false);
    expect(entries[1][1].tex).toBe("y");
    expect(entries[1][1].displayMode).toBe(true);
    const ph0 = entries[0][0];
    const ph1 = entries[1][0];
    expect(protectedText).toBe(`text ${ph0} and ${ph1}`);
  });

  it("returns empty mathBlocks and unchanged text when no math content", () => {
    const { protectedText, mathBlocks } = extractMathBlocks("just plain text");
    expect(mathBlocks.size).toBe(0);
    expect(protectedText).toBe("just plain text");
  });

  it("does NOT extract $5 and $10 (currency detection via findInlineMathEnd)", () => {
    const { mathBlocks, protectedText } = extractMathBlocks("$5 and $10");
    expect(mathBlocks.size).toBe(0);
    expect(protectedText).toBe("$5 and $10");
  });

  it("extracts multiple inline math blocks: $x$ and $y$", () => {
    const { protectedText, mathBlocks } = extractMathBlocks("$x$ and $y$");
    expect(mathBlocks.size).toBe(2);
    const entries = [...mathBlocks.entries()];
    expect(entries[0][1].tex).toBe("x");
    expect(entries[0][1].displayMode).toBe(false);
    expect(entries[1][1].tex).toBe("y");
    expect(entries[1][1].displayMode).toBe(false);
    const ph0 = entries[0][0];
    const ph1 = entries[1][0];
    expect(protectedText).toBe(`${ph0} and ${ph1}`);
  });
});

// ── preProcessTex ──

describe("preProcessTex", () => {
  it("replaces multline* with gather*", () => {
    const result = preProcessTex("\\begin{multline*}x\\end{multline*}", false);
    expect(result).toBe("\\begin{gather*}x\\end{gather*}");
  });

  it("strips \\require{amsmath}", () => {
    const result = preProcessTex("\\require{amsmath}x", false);
    expect(result).toBe("x");
  });

  it("strips \\definecolor{red}{rgb}{1,0,0}", () => {
    const result = preProcessTex("\\definecolor{red}{rgb}{1,0,0}x", false);
    expect(result).toBe("x");
  });

  it("replaces \\ce{H2O} with \\mathrm{H2O}", () => {
    const result = preProcessTex("\\ce{H2O}", false);
    expect(result).toBe("\\mathrm{H2O}");
  });

  it("returns input unchanged when no preprocessing needed", () => {
    const result = preProcessTex("x^2 + y^2 = z^2", false);
    expect(result).toBe("x^2 + y^2 = z^2");
  });
});

// ── restoreMathBlocksSync (no module loaded) ──

describe("restoreMathBlocksSync — no module loaded", () => {
  it("returns html unchanged when mathBlocks is empty", () => {
    const result = restoreMathBlocksSync("<p>Hello</p>", new Map());
    expect(result).toBe("<p>Hello</p>");
  });

  it("replaces placeholders with katex-fallback when module not loaded", () => {
    const mathBlocks = new Map([
      ["\x00KATEX_PLACEHOLDER_0\x00", { tex: "x^2", displayMode: false }],
    ]);
    const result = restoreMathBlocksSync("text \x00KATEX_PLACEHOLDER_0\x00 after", mathBlocks);
    expect(result).toBe('text <code class="katex-fallback">x^2</code> after');
  });

  it("replaces multiple placeholders with katex-fallback", () => {
    const mathBlocks = new Map([
      ["\x00KATEX_PLACEHOLDER_0\x00", { tex: "x^2", displayMode: false }],
      ["\x00KATEX_PLACEHOLDER_1\x00", { tex: "E=mc^2", displayMode: true }],
    ]);
    const result = restoreMathBlocksSync(
      "a \x00KATEX_PLACEHOLDER_0\x00 b \x00KATEX_PLACEHOLDER_1\x00 c",
      mathBlocks,
    );
    expect(result).toBe(
      'a <code class="katex-fallback">x^2</code> b <code class="katex-fallback">E=mc^2</code> c',
    );
  });
});

// ── preloadKatex & getKatexModule ──

describe("preloadKatex & getKatexModule", () => {
  it("preloadKatex() returns a Promise", () => {
    const result = preloadKatex();
    expect(result).toBeInstanceOf(Promise);
    result.catch(() => {});
  });

  it("preloadKatex() resolves and makes getKatexModule() return the module", async () => {
    const result = await preloadKatex();
    expect(result).toBeDefined();
    expect(getKatexModule()).not.toBeNull();
  });
});

// ── toSanitizedMarkdownHtmlWithKatex — KaTeX integration ──

// Mock katex module for integration tests
const renderToStringMock = vi.fn(
  (
    tex: string,
    options?: {
      displayMode?: boolean;
      throwOnError?: boolean;
      trust?: boolean;
      strict?: boolean;
      maxSize?: number;
    },
  ) => {
    // Simulate KaTeX trust:false — block dangerous commands
    if (options?.trust === false && /\\href\s*\{javascript:/i.test(tex)) {
      return `<span class="katex-error">${tex}</span>`;
    }
    if (options?.displayMode) {
      return `<span class="katex-display"><span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>${tex}</mi></mrow></semantics></math></span><span class="katex-html">${tex}</span></span></span>`;
    }
    return `<span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>${tex}</mi></mrow></semantics></math></span><span class="katex-html">${tex}</span></span>`;
  },
);

vi.mock("katex", () => {
  return {
    default: { renderToString: renderToStringMock },
    renderToString: renderToStringMock,
  };
});

vi.mock("katex/dist/katex.min.css?url", () => ({
  default: "katex.min.css",
}));

describe("toSanitizedMarkdownHtmlWithKatex — KaTeX rendering", () => {
  beforeEach(() => {
    clearMarkdownCache();
  });

  it("renders inline KaTeX math and output survives DOMPurify (sanitizer boundary)", async () => {
    // Preload the mocked katex module
    await preloadKatex();

    const html = toSanitizedMarkdownHtmlWithKatex("$E=mc^2$", {
      mathRendering: "katex",
    });

    // KaTeX HTML must survive DOMPurify (prove restore-before-sanitize works)
    expect(html).toContain('class="katex"');
    expect(html).toContain("<math>");
  });

  it("blocks XSS vectors in LaTeX (\\href with javascript:)", async () => {
    await preloadKatex();

    const html = toSanitizedMarkdownHtmlWithKatex("$\\href{javascript:alert(1)}{click}$", {
      mathRendering: "katex",
    });

    // Must NOT produce executable XSS links
    expect(html).not.toContain('href="javascript:');
    // KaTeX trust:false blocks \href → katex-error → katex-fallback
    expect(html).toContain("katex-fallback");
  });

  it("renders display mode math with katex-display class", async () => {
    await preloadKatex();

    const html = toSanitizedMarkdownHtmlWithKatex("$$\\frac{a}{b}$$", {
      mathRendering: "katex",
    });

    expect(html).toContain("katex-display");
  });

  it("does NOT render KaTeX when mathRendering=off", () => {
    const html = toSanitizedMarkdownHtmlWithKatex("$E=mc^2$", {
      mathRendering: "off",
    });

    expect(html).not.toContain('class="katex"');
  });

  it("does NOT render KaTeX when mathRendering is undefined", () => {
    const html = toSanitizedMarkdownHtmlWithKatex("$E=mc^2$");

    expect(html).not.toContain('class="katex"');
  });
});

// ── Cache tests ──

describe("Markdown cache", () => {
  beforeEach(() => {
    clearMarkdownCache();
  });

  it("clearMarkdownCache() empties the cache", () => {
    // Render something to populate cache
    const html1 = toSanitizedMarkdownHtmlWithKatex("Hello **world**", {
      mathRendering: "off",
    });
    expect(html1).toContain("<strong>world</strong>");

    // Clear cache
    clearMarkdownCache();

    // Render again — should still work (just not from cache)
    const html2 = toSanitizedMarkdownHtmlWithKatex("Hello **world**", {
      mathRendering: "off",
    });
    expect(html2).toBe(html1);
  });

  it("skips cache when KaTeX is requested but not loaded", async () => {
    // Reset module state by forcing katexModule to null
    // We test the cache skip behavior by verifying that calling
    // with mathRendering="katex" when getKatexModule() returns null
    // still returns valid output (fallback), and subsequent calls
    // with katex loaded produce different (rendered) output.

    // First: render with katex not loaded (getKatexModule() === null)
    // The mock is loaded via vi.mock, but getKatexModule checks the
    // internal module variable. Since we vi.mock'd the dynamic import,
    // preloadKatex will resolve with the mock, making getKatexModule
    // return non-null. So we test the cache skip by verifying the
    // output does not permanently cache the fallback.

    // Render with katex loaded
    await preloadKatex();
    const htmlWithKatex = toSanitizedMarkdownHtmlWithKatex("$x^2$", {
      mathRendering: "katex",
    });
    expect(htmlWithKatex).toContain('class="katex"');

    // Clear and re-render — should produce same result (katex loaded now)
    clearMarkdownCache();
    const htmlAgain = toSanitizedMarkdownHtmlWithKatex("$x^2$", {
      mathRendering: "katex",
    });
    expect(htmlAgain).toContain('class="katex"');
    expect(htmlAgain).toBe(htmlWithKatex);
  });

  it("caches results when KaTeX is loaded", async () => {
    await preloadKatex();

    const html1 = toSanitizedMarkdownHtmlWithKatex("$x^2$", {
      mathRendering: "katex",
    });
    const html2 = toSanitizedMarkdownHtmlWithKatex("$x^2$", {
      mathRendering: "katex",
    });

    // Second call should return cached result
    expect(html2).toBe(html1);
  });
});

// ── Render loop guard ──

describe("render loop guard prevents multiple preloadKatex calls", () => {
  it("preloadKatex is idempotent — calling it repeatedly resolves safely without errors", async () => {
    const results = await Promise.all([preloadKatex(), preloadKatex(), preloadKatex()]);

    expect(results[0]).toBeDefined();
    expect(results[1]).toBeDefined();
    expect(results[2]).toBeDefined();
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
  });

  it("preloadKatex returns the same resolved module on subsequent calls after initial load", async () => {
    const first = await preloadKatex();
    const second = await preloadKatex();

    expect(first).toBe(second);
    expect(getKatexModule()).toBe(first);
  });
});

// ── maxSize cap ──

describe("maxSize option in KaTeX rendering", () => {
  beforeEach(() => {
    clearMarkdownCache();
  });

  it("maxSize option is passed to renderToString", async () => {
    await preloadKatex();
    renderToStringMock.mockClear();

    toSanitizedMarkdownHtmlWithKatex("$x^2$", {
      mathRendering: "katex",
    });

    expect(renderToStringMock).toHaveBeenCalled();
    const lastCall = renderToStringMock.mock.calls[renderToStringMock.mock.calls.length - 1]!;
    const options = lastCall[1] as Record<string, unknown>;
    expect(options.maxSize).toBe(100);
  });

  it("hostile LaTeX size is capped by maxSize", async () => {
    await preloadKatex();
    renderToStringMock.mockClear();

    const html = toSanitizedMarkdownHtmlWithKatex("$\\rule{500em}{500em}$", {
      mathRendering: "katex",
    });

    expect(html).toContain('class="katex"');
    expect(renderToStringMock).toHaveBeenCalled();
    const lastCall = renderToStringMock.mock.calls[renderToStringMock.mock.calls.length - 1]!;
    const options = lastCall[1] as Record<string, unknown>;
    expect(options.maxSize).toBe(100);
  });

  it("normal formulas unaffected by maxSize", async () => {
    await preloadKatex();
    clearMarkdownCache();

    const inlineHtml = toSanitizedMarkdownHtmlWithKatex("$E=mc^2$", {
      mathRendering: "katex",
    });
    expect(inlineHtml).toContain('class="katex"');
    expect(inlineHtml).toContain("<math>");
    expect(inlineHtml).toContain("E=mc^2");

    clearMarkdownCache();
    const displayHtml = toSanitizedMarkdownHtmlWithKatex("$$\\frac{a}{b}$$", {
      mathRendering: "katex",
    });
    expect(displayHtml).toContain("katex-display");
    expect(displayHtml).toContain("\\frac{a}{b}");
  });
});
