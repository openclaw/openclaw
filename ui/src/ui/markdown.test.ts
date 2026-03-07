import { marked } from "marked";
import { describe, expect, it, vi } from "vitest";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

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
    expect(html).not.toContain("javascript:");
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
    expect(html).toContain("data:image/png;base64,");
  });

  it("flattens non-data markdown image urls", () => {
    const html = toSanitizedMarkdownHtml("![X](javascript:alert(1))");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
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

  it("falls back to escaped plain text if marked.parse throws (#36213)", () => {
    const parseSpy = vi.spyOn(marked, "parse").mockImplementation(() => {
      throw new Error("forced parse failure");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = `Fallback **probe** ${Date.now()}`;
    try {
      const html = toSanitizedMarkdownHtml(input);
      expect(html).toContain('<pre class="code-block">');
      expect(html).toContain("Fallback **probe**");
      expect(warnSpy).toHaveBeenCalledOnce();
    } finally {
      parseSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
