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

  it("renders fenced code blocks with copy button", () => {
    const html = toSanitizedMarkdownHtml(["```ts", "console.log(1)", "```"].join("\n"));
    expect(html).toContain("code-block-wrapper");
    expect(html).toContain("code-block-copy-btn");
    expect(html).toContain("<pre>");
    expect(html).toContain("<code");
    expect(html).toContain("console.log(1)");
  });

  it("includes language class in code element", () => {
    const html = toSanitizedMarkdownHtml(["```javascript", "const x = 1;", "```"].join("\n"));
    expect(html).toContain("language-javascript");
  });

  it("renders code blocks without language", () => {
    const html = toSanitizedMarkdownHtml(["```", "plain code", "```"].join("\n"));
    expect(html).toContain("code-block-wrapper");
    expect(html).toContain("plain code");
  });
});
