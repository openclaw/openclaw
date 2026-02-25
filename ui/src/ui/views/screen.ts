import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";

export type ScreenNode = {
  nodeId: string;
  displayName: string;
};

export type ScreenProps = {
  connected: boolean;
  gatewayUrl: string;
  token: string;
  nodes: ScreenNode[];
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
};

/**
 * Resolves the VNC viewer URL from the gateway WebSocket URL.
 * Converts ws:// → http:// or wss:// → https:// and appends /vnc-viewer.
 * Adds token and optional nodeId query parameters.
 */
function resolveVncViewerUrl(gatewayUrl: string, token: string, nodeId: string | null): string {
  const trimmed = gatewayUrl.trim();
  let base: string;
  if (!trimmed) {
    base = "/vnc-viewer";
  } else {
    const httpUrl = trimmed.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
    base = httpUrl.replace(/\/+$/, "") + "/vnc-viewer";
  }
  const params = new URLSearchParams();
  if (token) {
    params.set("token", token);
  }
  if (nodeId) {
    params.set("nodeId", nodeId);
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export function renderScreen(props: ScreenProps) {
  if (!props.connected) {
    return html`
      <div class="callout" style="margin-top: 16px;">
        ${t("screen.disconnected")}
      </div>
    `;
  }

  const viewerUrl = resolveVncViewerUrl(props.gatewayUrl, props.token, props.selectedNodeId);

  const nodeSelector =
    props.nodes.length > 0
      ? html`
          <select
            class="select select--sm"
            .value=${props.selectedNodeId ?? ""}
            @change=${(e: Event) => {
              const val = (e.target as HTMLSelectElement).value;
              props.onSelectNode(val || null);
            }}
          >
            <option value="">Gateway (local)</option>
            ${props.nodes.map(
              (n) => html`
                <option value=${n.nodeId} ?selected=${n.nodeId === props.selectedNodeId}>
                  ${n.displayName}
                </option>
              `,
            )}
          </select>
        `
      : nothing;

  return html`
    <section style="display: flex; flex-direction: column; height: calc(100vh - 120px); gap: 12px;">
      <div class="row" style="gap: 8px; align-items: center; flex-shrink: 0;">
        ${nodeSelector}
        <a
          class="btn btn--outline"
          href=${viewerUrl}
          target="_blank"
          rel="noreferrer"
          title="${t("screen.openNewTab")}"
        >${t("screen.openNewTab")}</a>
        <span class="muted">${t("screen.hint")}</span>
      </div>
      <iframe
        src=${viewerUrl}
        style="flex: 1; width: 100%; border: 1px solid var(--border, #333); border-radius: 8px; background: #0a0a0a;"
        allow="clipboard-read; clipboard-write"
        title="Remote Desktop"
      ></iframe>
    </section>
  `;
}
