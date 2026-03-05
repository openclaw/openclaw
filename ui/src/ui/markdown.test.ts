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

  it("preserves img tags with src and alt from markdown images (#15437)", () => {
    const html = toSanitizedMarkdownHtml("![Alt text](https://example.com/image.png)");
    expect(html).toContain("<img");
    expect(html).toContain('src="https://example.com/image.png"');
    expect(html).toContain('alt="Alt text"');
  });

  it("preserves base64 data URI images (#15437)", () => {
    const html = toSanitizedMarkdownHtml("![Chart](data:image/png;base64,iVBORw0KGgo=)");
    expect(html).toContain("<img");
    expect(html).toContain("data:image/png;base64,");
  });

  it("strips javascript image urls", () => {
    const html = toSanitizedMarkdownHtml("![X](javascript:alert(1))");
    expect(html).toContain("<img");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("src=");
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

  it("falls back to escaped text when marked.parse throws", () => {
    const parseSpy = vi.spyOn(marked, "parse").mockImplementationOnce(() => {
      throw new Error("too much recursion");
    });
    const html = toSanitizedMarkdownHtml("plain <script>alert(1)</script> **text**");
    expect(html).toContain("<pre");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("**text**");
    expect(html).not.toContain("<script>");
    expect(parseSpy).toHaveBeenCalledOnce();
  });
});
