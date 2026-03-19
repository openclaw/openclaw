import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMermaidInteractions } from "./mermaid.ts";

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
