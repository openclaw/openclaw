import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMermaidInteractions, sanitizeMermaidSvg } from "./mermaid.ts";

describe("sanitizeMermaidSvg", () => {
  it("keeps safe HTML labels inside foreignObject", () => {
    const sanitized = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="100" height="50"><div xmlns="http://www.w3.org/1999/xhtml">hello<br/>world</div></foreignObject></svg>',
    );

    expect(sanitized).toContain("foreignObject");
    expect(sanitized).toContain("<div");
    expect(sanitized).toContain("hello");
    expect(sanitized).toContain("<br>");
  });

  it("strips unsafe HTML labels inside foreignObject", () => {
    const sanitized = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="100" height="50"><div xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script>hello</div></foreignObject></svg>',
    );

    expect(sanitized).toContain("foreignObject");
    expect(sanitized).toContain("hello");
    expect(sanitized).not.toContain("<script");
  });
});

describe("installMermaidInteractions", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("opens the mermaid preview dialog when the rendered diagram is clicked", () => {
    installMermaidInteractions(document);

    document.body.innerHTML = `
      <div class="mermaid-block" data-mermaid-status="ready">
        <div class="mermaid-block__render" role="button" tabindex="0">
          <svg><text>Diagram</text></svg>
        </div>
        <dialog class="mermaid-block__dialog">
          <div class="mermaid-block__dialog-body"></div>
        </dialog>
      </div>
    `;

    const dialog = document.querySelector<HTMLDialogElement>(".mermaid-block__dialog");
    const showModal = vi.fn();
    Object.defineProperty(dialog!, "showModal", {
      configurable: true,
      value: showModal,
    });

    document.querySelector<HTMLElement>(".mermaid-block__render")?.click();

    expect(showModal).toHaveBeenCalledOnce();
    expect(dialog?.querySelector(".mermaid-block__dialog-body")?.innerHTML).toContain("<svg");
  });
});
