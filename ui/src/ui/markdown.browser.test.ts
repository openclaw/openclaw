import { describe, it, expect } from "vitest";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

describe("Mermaid rendering", () => {
  it("emits mermaid placeholder for mermaid code blocks", () => {
    const input = "```mermaid\ngraph TD\n  A --> B\n```";
    const result = toSanitizedMarkdownHtml(input);

    // toSanitizedMarkdownHtml returns a placeholder — the actual SVG
    // rendering happens in the DOM via the MutationObserver.
    expect(result).toContain("mermaid-placeholder");
    expect(result).toContain("data-mermaid-code");
    expect(result).not.toContain("<svg");
  });

  it("preserves mermaid code in the data attribute", () => {
    const input = "```mermaid\ngraph TD\n  A --> B\n```";
    const result = toSanitizedMarkdownHtml(input);

    // The code is URI-encoded in the attribute to avoid DOMPurify mutation-XSS
    // stripping (DOMPurify 3.x strips attributes containing `-->`).
    expect(result).toContain("graph%20TD");
    expect(result).toContain("A%20--%3E%20B");
  });

  it("does not affect non-mermaid code blocks", () => {
    const input = '```javascript\nconsole.log("hi")\n```';
    const result = toSanitizedMarkdownHtml(input);

    expect(result).not.toContain("mermaid-placeholder");
    expect(result).toContain("<code");
  });

  it("strips raw SVG injected outside mermaid", () => {
    const input = '<svg onload="alert(1)"><circle cx="50" cy="50" r="40"/></svg>';
    const result = toSanitizedMarkdownHtml(input);

    // SVG must not be rendered as an actual element — only as escaped text.
    expect(result).not.toContain("<svg");
    expect(result).toContain("&lt;svg");
  });
});
