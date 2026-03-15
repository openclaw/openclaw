import { describe, expect, it, vi } from "vitest";
import { md, toSanitizedMarkdownHtml } from "./markdown.ts";

describe("toSanitizedMarkdownHtml", () => {
  it("renders basic markdown", () => {
    const html = toSanitizedMarkdownHtml("Hello **world**");
    expect(html).toContain("<strong>world</strong>");
  });

  it("strips scripts and unsafe links", () => {
    const html = toSanitizedMarkdownHtml(
      [
        "<script>alert(1)</script>",
        "",
        "[x](javascript:alert(1))",
        "",
        "[ok](https://example.com)",
      ].join("\n"),
    );
    expect(html).not.toContain("<script");
    // markdown-it blocks javascript: from becoming a live link; the literal
    // text may still appear as escaped content which is safe.
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("https://example.com");
  });

  it("renders fenced code blocks", () => {
    const html = toSanitizedMarkdownHtml(["```ts", "console.log(1)", "```"].join("\n"));
    expect(html).toContain("<pre>");
    expect(html).toContain("<code");
    expect(html).toContain("console.log(1)");
  });

  it("flattens remote markdown images into alt text", () => {
    const html = toSanitizedMarkdownHtml("![Alt text](https://example.com/image.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain("Alt text");
  });

  it("preserves base64 data URI images (#15437)", () => {
    const html = toSanitizedMarkdownHtml("![Chart](data:image/png;base64,iVBORw0KGgo=)");
    expect(html).toContain("<img");
    expect(html).toContain('class="markdown-inline-image"');
    expect(html).toContain("data:image/png;base64,");
  });

  it("flattens non-data markdown image urls", () => {
    const html = toSanitizedMarkdownHtml("![X](javascript:alert(1))");
    expect(html).not.toContain("<img");
    // markdown-it blocks javascript: from becoming a live element; the literal
    // text may still appear as escaped content which is safe.
    expect(html).not.toContain('src="javascript:');
    expect(html).toContain("X");
  });

  it("uses a plain fallback label for unlabeled markdown images", () => {
    const html = toSanitizedMarkdownHtml("![](https://example.com/image.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain("image");
  });

  it("renders GFM markdown tables (#20410)", () => {
    const md = [
      "| Feature | Status |",
      "|---------|--------|",
      "| Tables  | ✅     |",
      "| Borders | ✅     |",
    ].join("\n");
    const html = toSanitizedMarkdownHtml(md);
    expect(html).toContain("<table");
    expect(html).toContain("<thead");
    expect(html).toContain("<th>");
    expect(html).toContain("Feature");
    expect(html).toContain("Tables");
    expect(html).not.toContain("|---------|");
  });

  it("renders GFM tables surrounded by text (#20410)", () => {
    const md = [
      "Text before.",
      "",
      "| Col1 | Col2 |",
      "|------|------|",
      "| A    | B    |",
      "",
      "Text after.",
    ].join("\n");
    const html = toSanitizedMarkdownHtml(md);
    expect(html).toContain("<table");
    expect(html).toContain("Col1");
    expect(html).toContain("Col2");
    // Pipes from table delimiters must not appear as raw text
    expect(html).not.toContain("|------|");
  });

  it("does not throw on deeply nested emphasis markers (#36213)", () => {
    // Pathological patterns that can trigger catastrophic backtracking / recursion
    const nested = "*".repeat(500) + "text" + "*".repeat(500);
    expect(() => toSanitizedMarkdownHtml(nested)).not.toThrow();
    const html = toSanitizedMarkdownHtml(nested);
    expect(html).toContain("text");
  });

  it("does not throw on deeply nested brackets (#36213)", () => {
    const nested = "[".repeat(200) + "link" + "]".repeat(200) + "(" + "x".repeat(200) + ")";
    expect(() => toSanitizedMarkdownHtml(nested)).not.toThrow();
    const html = toSanitizedMarkdownHtml(nested);
    expect(html).toContain("link");
  });

  // Regression test for marked.js ReDoS that caused UI freeze.
  //
  // Background (old code — marked.js):
  //   When a toolResult message contained a nested session transcript (JSONL),
  //   the text passed to marked.parse() included double-escaped newlines (\\n)
  //   that prevented ``` from forming fenced code blocks. marked's regex-based
  //   inline tokenizer then saw many unmatched backticks interleaved with []
  //   brackets and entered catastrophic backtracking — e.g. 8 repeats → 781ms,
  //   10 repeats → 31s, real sessions → infinite hang freezing the UI.
  //
  // No minimal synthetic pattern was found that reliably triggers the issue;
  // the structure below is extracted and desensitized from a real session that
  // caused the hang. The HEADER provides the nested JSONL context, and each
  // RECORD_UNIT adds 6 backticks + 4 brackets via ``` fences and [link](url).
  //
  // Fix: replaced marked.js (regex engine) with markdown-it (state machine),
  // which is immune to ReDoS. markdown-it handles 20 repeats in ~9ms.
  //
  // If a future refactor reintroduces a regex-based markdown parser:
  //   - { timeout: 2_000 } lets vitest kill the test from outside the blocked
  //     event loop (CPU-bound marked.parse blocks setTimeout/setInterval too)
  //   - expect(elapsed).toBeLessThan(500) catches the exponential growth even
  //     if the parser eventually returns
  it("does not hang on backtick + bracket ReDoS pattern", { timeout: 2_000 }, () => {
    // Nested JSONL structure that sets up the context for inline backtick chaos
    const HEADER =
      '{"type":"message","id":"aaa","parentId":"bbb",' +
      '"timestamp":"2000-01-01T00:00:00.000Z","message":' +
      '{"role":"toolResult","toolCallId":"call_000",' +
      '"toolName":"read","content":[{"type":"text","text":' +
      '"{\\"type\\":\\"message\\",\\"id\\":\\"ccc\\",' +
      '\\"timestamp\\":\\"2000-01-01T00:00:00.000Z\\",' +
      '\\"message\\":{\\"role\\":\\"toolResult\\",' +
      '\\"toolCallId\\":\\"call_111\\",\\"toolName\\":\\"read\\",' +
      '\\"content\\":[{\\"type\\":\\"text\\",' +
      '\\"text\\":\\"# Memory Index\\\\n\\\\n';

    // Each unit: 6 backticks (``` x2) + 4 brackets ([tag] + [link](url))
    // Double-escaped \\n keeps everything on one "line" for the parser
    const RECORD_UNIT =
      "## 2000-01-01 00:00:00 done [tag]\\\\n" +
      "**question**:\\\\n```\\\\nsome question text here\\\\n```\\\\n" +
      "**details**: [see details](./2000.01.01/00000000/INFO.md)\\\\n\\\\n";

    const poison = HEADER + RECORD_UNIT.repeat(9);

    const start = performance.now();
    const html = toSanitizedMarkdownHtml(poison);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(500);
    expect(html.length).toBeGreaterThan(0);
  });

  it("keeps oversized plain-text replies readable instead of forcing code-block chrome", () => {
    const input =
      Array.from(
        { length: 320 },
        (_, i) => `Paragraph ${i + 1}: ${"Long plain-text reply. ".repeat(8)}`,
      ).join("\n\n") + "\n";

    const html = toSanitizedMarkdownHtml(input);

    expect(html).not.toContain('<pre class="code-block">');
    expect(html).toContain('class="markdown-plain-text-fallback"');
    expect(html).toContain("Paragraph 1:");
    expect(html).toContain("Paragraph 320:");
  });

  it("preserves indentation in oversized plain-text replies", () => {
    const input = `${"Header line\n".repeat(5000)}\n    indented log line\n        deeper indent`;
    const html = toSanitizedMarkdownHtml(input);

    expect(html).toContain('class="markdown-plain-text-fallback"');
    expect(html).toContain("    indented log line");
    expect(html).toContain("        deeper indent");
  });

  it("exercises the cached oversized fallback branch", () => {
    const input =
      Array.from(
        { length: 240 },
        (_, i) => `Paragraph ${i + 1}: ${"Cacheable long reply. ".repeat(8)}`,
      ).join("\n\n") + "\n";

    expect(input.length).toBeGreaterThan(40_000);
    expect(input.length).toBeLessThan(50_000);

    const first = toSanitizedMarkdownHtml(input);
    const second = toSanitizedMarkdownHtml(input);

    expect(first).toContain('class="markdown-plain-text-fallback"');
    expect(second).toBe(first);
  });

  it("falls back to escaped plain text if md.render throws (#36213)", () => {
    const renderSpy = vi.spyOn(md, "render").mockImplementation(() => {
      throw new Error("forced render failure");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = `Fallback **probe** ${Date.now()}`;
    try {
      const html = toSanitizedMarkdownHtml(input);
      expect(html).toContain('<pre class="code-block">');
      expect(html).toContain("Fallback **probe**");
      expect(warnSpy).toHaveBeenCalledOnce();
    } finally {
      renderSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
