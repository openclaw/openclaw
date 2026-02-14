import { describe, expect, it } from "vitest";
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

  it("renders display math ($$...$$) with KaTeX", () => {
    const html = toSanitizedMarkdownHtml("$$x^2 + y^2 = z^2$$");
    expect(html).toContain("katex");
    expect(html).not.toContain("$$");
  });

  it("renders inline math ($...$) with KaTeX", () => {
    const html = toSanitizedMarkdownHtml("The formula $E = mc^2$ is famous.");
    expect(html).toContain("katex");
    expect(html).not.toContain("$E");
  });

  it("does not render dollar amounts as math", () => {
    const html = toSanitizedMarkdownHtml("The price is $100.");
    expect(html).not.toContain("katex");
    expect(html).toContain("$100");
  });

  it("does not render math inside code blocks", () => {
    const html = toSanitizedMarkdownHtml(["```", "$$x^2$$", "```"].join("\n"));
    expect(html).not.toContain("katex");
  });

  it("renders complex LaTeX display math", () => {
    const input = "$$\\mathbb{I}\\left[ \\frac{\\partial \\mathcal{L}}{\\partial t} \\right]$$";
    const html = toSanitizedMarkdownHtml(input);
    expect(html).toContain("katex");
    expect(html).not.toContain("$$");
  });

  it("renders display math with \\\\[...\\\\] delimiters", () => {
    const html = toSanitizedMarkdownHtml("\\[x^2 + y^2 = z^2\\]");
    expect(html).toContain("katex");
  });

  it("renders inline math with \\\\(...\\\\) delimiters", () => {
    const html = toSanitizedMarkdownHtml("The formula \\(E = mc^2\\) is famous.");
    expect(html).toContain("katex");
  });

  it("renders mixed LaTeX-style and dollar-style math", () => {
    const input = "Display: \\[x^2\\] and inline \\(y^2\\) plus $z^2$ here.";
    const html = toSanitizedMarkdownHtml(input);
    expect(html).toContain("katex");
  });
});
