import { html, nothing } from "lit";
import type { MemoryProviderStatusUI, MemoryStatusResult } from "../controllers/memory.ts";

export type MemoryProps = {
  loading: boolean;
  result: MemoryStatusResult | null;
  error: string | null;
  onRefresh: () => void;
};

export function renderMemory(props: MemoryProps) {
  const status = props.result?.status ?? null;
  const agentId = props.result?.agentId ?? null;

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Memory</div>
          <div class="card-sub">Embedding index, search engines, and cache status.</div>
        </div>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      ${
        props.error
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
          : nothing
      }

      ${status ? renderStatus(status, agentId) : renderEmpty(props.loading)}
    </section>
  `;
}

function renderEmpty(loading: boolean) {
  if (loading) {
    return html`
      <div class="muted" style="margin-top: 16px">Loading memory status…</div>
    `;
  }
  return html`
    <div class="muted" style="margin-top: 16px">Memory search is not configured or unavailable.</div>
  `;
}

function renderStatus(status: MemoryProviderStatusUI, agentId: string | null) {
  return html`
    <div style="margin-top: 16px; display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));">
      ${renderProviderCard(status, agentId)}
      ${renderIndexCard(status)}
      ${renderEngineCard(status)}
      ${status.cache ? renderCacheCard(status.cache) : nothing}
      ${status.batch ? renderBatchCard(status.batch) : nothing}
    </div>
  `;
}

function renderProviderCard(status: MemoryProviderStatusUI, agentId: string | null) {
  return html`
    <div class="card" style="padding: 14px 16px;">
      <div style="font-weight: 600; font-size: 13px; margin-bottom: 10px;">Provider</div>
      ${agentId ? kvRow("Agent", agentId) : nothing}
      ${kvRow("Backend", status.backend)}
      ${kvRow("Provider", status.provider)}
      ${status.model ? kvRow("Model", status.model) : nothing}
      ${
        status.requestedProvider && status.requestedProvider !== status.provider
          ? kvRow("Requested", status.requestedProvider)
          : nothing
      }
      ${
        status.fallback
          ? kvRow(
              "Fallback",
              html`From <strong>${status.fallback.from}</strong>${status.fallback.reason ? html` — ${status.fallback.reason}` : nothing}`,
            )
          : nothing
      }
      ${status.workspaceDir ? kvRow("Workspace", status.workspaceDir) : nothing}
    </div>
  `;
}

function renderIndexCard(status: MemoryProviderStatusUI) {
  const sourceCounts = status.sourceCounts ?? [];
  return html`
    <div class="card" style="padding: 14px 16px;">
      <div style="font-weight: 600; font-size: 13px; margin-bottom: 10px;">Index</div>
      ${kvRow("Files", String(status.files ?? 0))}
      ${kvRow("Chunks", String(status.chunks ?? 0))}
      ${kvRow("Dirty", status.dirty ? "Yes" : "No")}
      ${sourceCounts.map((sc) =>
        kvRow(`Source: ${sc.source}`, `${sc.files} files, ${sc.chunks} chunks`),
      )}
      ${
        status.extraPaths && status.extraPaths.length > 0
          ? kvRow("Extra paths", status.extraPaths.join(", "))
          : nothing
      }
    </div>
  `;
}

function renderEngineCard(status: MemoryProviderStatusUI) {
  const vector = status.vector;
  const fts = status.fts;
  return html`
    <div class="card" style="padding: 14px 16px;">
      <div style="font-weight: 600; font-size: 13px; margin-bottom: 10px;">Search Engines</div>
      ${
        vector
          ? html`
              ${kvRow("Vector", renderStatusChip(vector.enabled, vector.available ?? null))}
              ${vector.dims ? kvRow("Dimensions", String(vector.dims)) : nothing}
              ${vector.loadError ? kvRow("Vector error", html`<span style="color: var(--danger);">${vector.loadError}</span>`) : nothing}
            `
          : kvRow("Vector", "n/a")
      }
      ${
        fts
          ? html`
              ${kvRow("FTS", renderStatusChip(fts.enabled, fts.available))}
              ${fts.error ? kvRow("FTS error", html`<span style="color: var(--danger);">${fts.error}</span>`) : nothing}
            `
          : kvRow("FTS", "n/a")
      }
    </div>
  `;
}

function renderCacheCard(cache: { enabled: boolean; entries?: number; maxEntries?: number }) {
  return html`
    <div class="card" style="padding: 14px 16px;">
      <div style="font-weight: 600; font-size: 13px; margin-bottom: 10px;">Embedding Cache</div>
      ${kvRow("Enabled", cache.enabled ? "Yes" : "No")}
      ${typeof cache.entries === "number" ? kvRow("Entries", String(cache.entries)) : nothing}
      ${typeof cache.maxEntries === "number" ? kvRow("Max entries", String(cache.maxEntries)) : nothing}
    </div>
  `;
}

function renderBatchCard(batch: {
  enabled: boolean;
  failures: number;
  limit: number;
  wait: boolean;
  concurrency: number;
  pollIntervalMs: number;
  timeoutMs: number;
  lastError?: string;
  lastProvider?: string;
}) {
  return html`
    <div class="card" style="padding: 14px 16px;">
      <div style="font-weight: 600; font-size: 13px; margin-bottom: 10px;">Batch Embedding</div>
      ${kvRow("Enabled", batch.enabled ? "Yes" : "No")}
      ${kvRow("Failures", `${batch.failures} / ${batch.limit}`)}
      ${kvRow("Concurrency", String(batch.concurrency))}
      ${kvRow("Poll interval", `${batch.pollIntervalMs}ms`)}
      ${kvRow("Timeout", `${batch.timeoutMs}ms`)}
      ${batch.lastError ? kvRow("Last error", html`<span style="color: var(--danger);">${batch.lastError}</span>`) : nothing}
      ${batch.lastProvider ? kvRow("Last provider", batch.lastProvider) : nothing}
    </div>
  `;
}

function renderStatusChip(enabled: boolean, available: boolean | null) {
  if (!enabled) {
    return html`
      <span class="chip" style="display: inline-block">Disabled</span>
    `;
  }
  if (available === true) {
    return html`
      <span class="chip chip-ok" style="display: inline-block">Ready</span>
    `;
  }
  if (available === false) {
    return html`
      <span class="chip chip-warn" style="display: inline-block">Unavailable</span>
    `;
  }
  return html`
    <span class="chip" style="display: inline-block">Unknown</span>
  `;
}

function kvRow(label: string, value: unknown) {
  return html`
    <div style="display: flex; justify-content: space-between; align-items: baseline; padding: 4px 0; font-size: 13px;">
      <span class="muted" style="flex-shrink: 0; margin-right: 12px;">${label}</span>
      <span style="text-align: right; word-break: break-all;">${value}</span>
    </div>
  `;
}
