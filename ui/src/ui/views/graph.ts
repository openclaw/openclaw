import { html } from "lit";

export type GraphProps = {
    basePath: string;
};

export function renderGraph(props: GraphProps) {
    const graphUrl = `${props.basePath}/api/knowledge-graph/graph_view.html`;

    return html`
    <section class="card" style="height: calc(100vh - 160px); display: flex; flex-direction: column; padding: 0; overflow: hidden;">
      <div style="padding: 16px; border-bottom: 1px solid var(--border-color);">
        <div class="card-title">Knowledge Graph</div>
        <div class="card-sub">Visualizing relationships between knowledge items and agents.</div>
      </div>
      <iframe 
        src="${graphUrl}" 
        style="flex: 1; border: none; width: 100%; height: 100%;"
        title="Knowledge Graph"
      ></iframe>
    </section>
  `;
}
