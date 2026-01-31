import { describe, expect, it } from "vitest";

import { toSanitizedMarkdownHtml } from "./markdown";

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


  it("handles massive strings without freezing", () => {
    // Create a massive string (> 140k chars)
    const longString = "a".repeat(150_000);
    // Add a path at the beginning (should be processed)
    const start = "/Users/test/image.png";
    // Add a path at the end (should be truncated and ignored)
    const end = "/Users/test/ignored.png";

    const input = `${start}\n${longString}\n${end}`;
    const startState = Date.now();
    const html = toSanitizedMarkdownHtml(input);
    const duration = Date.now() - startState;

    // Should be fast (under 100ms usually, but let's say 500ms to be safe in CI)
    expect(duration).toBeLessThan(500);

    // The first image should be converted
    expect(html).toContain("![Image](/api/workspace/files/Users/test/image.png)");

    // The body should be truncated
    expect(html).toContain("… truncated");

    // The end image should NOT be present (it was truncated)
    expect(html).not.toContain("ignored.png");
  });
});
