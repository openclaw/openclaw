type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, definition: string) => Promise<{ svg: string }>;
};

let mermaidApiPromise: Promise<MermaidApi> | null = null;
let renderScheduled = false;
let renderCounter = 0;

async function loadMermaidApi(): Promise<MermaidApi> {
  if (!mermaidApiPromise) {
    mermaidApiPromise = import("mermaid").then((mod) => {
      const api = (mod.default ?? mod) as MermaidApi;
      api.initialize({
        startOnLoad: false,
        securityLevel: "strict",
      });
      return api;
    });
  }
  return mermaidApiPromise;
}

export function scheduleMermaidRender(root: ParentNode = document): void {
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

  const api = await loadMermaidApi();

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
      renderTarget.innerHTML = svg;
      block.dataset.mermaidStatus = "ready";
    } catch (err) {
      console.warn("[markdown] mermaid render failed", err);
      renderTarget.textContent = "Mermaid render failed. Expand source to inspect diagram text.";
      block.dataset.mermaidStatus = "error";
    }
  }
}
