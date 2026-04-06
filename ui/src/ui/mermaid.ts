import DOMPurify from "dompurify";

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, definition: string) => Promise<{ svg: string }>;
};

let mermaidApiPromise: Promise<MermaidApi> | null = null;
let renderScheduled = false;
let renderCounter = 0;
const interactionDocs = new WeakSet<Document>();
const mermaidSanitizeOptions = {
  ADD_TAGS: ["foreignObject", "foreignobject", "div", "span", "p", "br"],
  ADD_ATTR: ["xmlns", "style", "class", "width", "height", "x", "y", "transform"],
  HTML_INTEGRATION_POINTS: { foreignobject: true },
};

function setMermaidRenderError(renderTarget: HTMLElement, message: string) {
  renderTarget.removeAttribute("role");
  renderTarget.removeAttribute("aria-label");
  renderTarget.removeAttribute("tabindex");
  renderTarget.removeAttribute("title");
  renderTarget.setAttribute("aria-live", "polite");
  renderTarget.textContent = message;
}

async function loadMermaidApi(): Promise<MermaidApi> {
  if (!mermaidApiPromise) {
    mermaidApiPromise = import("mermaid")
      .then((mod) => {
        const api = (mod.default ?? mod) as MermaidApi;
        api.initialize({
          startOnLoad: false,
          securityLevel: "strict",
        });
        return api;
      })
      .catch((err) => {
        // If the dynamic import fails (e.g. chunk mismatch after deploy),
        // allow subsequent render attempts to retry without a full reload.
        mermaidApiPromise = null;
        throw err;
      });
  }
  return mermaidApiPromise;
}

export function installMermaidInteractions(root: ParentNode = document): void {
  const doc = root instanceof Document ? root : root.ownerDocument;
  if (!doc || interactionDocs.has(doc)) {
    return;
  }
  interactionDocs.add(doc);

  doc.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof Element)) {
      return;
    }

    const closeButton = target.closest<HTMLButtonElement>(".mermaid-block__dialog-close");
    if (closeButton) {
      closeMermaidDialog(closeButton.closest(".mermaid-block__dialog"));
      return;
    }

    const dialog = target.closest<HTMLDialogElement>(".mermaid-block__dialog");
    if (dialog && target === dialog) {
      closeMermaidDialog(dialog);
      return;
    }

    const renderTarget = target.closest<HTMLElement>(".mermaid-block__render");
    if (!renderTarget) {
      return;
    }

    const block = renderTarget.closest<HTMLElement>(".mermaid-block");
    if (!block || block.dataset.mermaidStatus !== "ready") {
      return;
    }

    openMermaidDialog(block);
  });

  doc.addEventListener("keydown", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement) || !target.classList.contains("mermaid-block__render")) {
      return;
    }
    if (e.key !== "Enter" && e.key !== " ") {
      return;
    }
    const block = target.closest<HTMLElement>(".mermaid-block");
    if (!block || block.dataset.mermaidStatus !== "ready") {
      return;
    }
    e.preventDefault();
    openMermaidDialog(block);
  });
}

function openMermaidDialog(block: HTMLElement): void {
  const dialog = block.querySelector<HTMLDialogElement>(".mermaid-block__dialog");
  const body = block.querySelector<HTMLElement>(".mermaid-block__dialog-body");
  const renderTarget = block.querySelector<HTMLElement>(".mermaid-block__render");
  if (!dialog || !body || !renderTarget) {
    return;
  }

  body.innerHTML = renderTarget.innerHTML;
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
    return;
  }
  dialog.setAttribute("open", "");
}

function closeMermaidDialog(dialog: HTMLDialogElement | null): void {
  if (!dialog) {
    return;
  }
  if (typeof dialog.close === "function") {
    dialog.close();
    return;
  }
  dialog.removeAttribute("open");
}

export function sanitizeMermaidSvg(svg: string): string {
  return DOMPurify.sanitize(svg, mermaidSanitizeOptions);
}

export function scheduleMermaidRender(root: ParentNode = document): void {
  installMermaidInteractions(root);
  if (renderScheduled) {
    return;
  }
  renderScheduled = true;
  queueMicrotask(() => {
    requestAnimationFrame(() => {
      renderScheduled = false;
      void renderMermaidBlocks(root);
    });
  });
}

async function renderMermaidBlocks(root: ParentNode): Promise<void> {
  const blocks = Array.from(
    root.querySelectorAll<HTMLElement>(".mermaid-block:not([data-mermaid-status])"),
  );
  if (blocks.length === 0) {
    return;
  }

  let api: MermaidApi;
  try {
    api = await loadMermaidApi();
  } catch (err) {
    console.warn("[markdown] mermaid module load failed", err);
    for (const block of blocks) {
      const renderTarget = block.querySelector<HTMLElement>(".mermaid-block__render");
      if (renderTarget) {
        setMermaidRenderError(
          renderTarget,
          "Mermaid render failed to load. Reload the page or expand source to inspect diagram text.",
        );
      }
      block.dataset.mermaidStatus = "error";
    }
    return;
  }

  for (const block of blocks) {
    const definition =
      block.querySelector<HTMLElement>("code.language-mermaid")?.textContent?.trim() ?? "";
    const renderTarget = block.querySelector<HTMLElement>(".mermaid-block__render");
    if (!definition || !renderTarget) {
      block.dataset.mermaidStatus = "error";
      continue;
    }

    block.dataset.mermaidStatus = "rendering";
    try {
      const id = `openclaw-mermaid-${++renderCounter}`;
      const { svg } = await api.render(id, definition);
      renderTarget.innerHTML = sanitizeMermaidSvg(svg);
      block.dataset.mermaidStatus = "ready";
    } catch (err) {
      console.warn("[markdown] mermaid render failed", err);
      setMermaidRenderError(
        renderTarget,
        "Mermaid render failed. Expand source to inspect diagram text.",
      );
      block.dataset.mermaidStatus = "error";
    }
  }
}
