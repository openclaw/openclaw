import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type {
  MemoryIndexJob,
  MemorySearchCorpus,
  MemorySearchResult,
  MemorySourceOpenResult,
  MemorySourcesResult,
  MemoryStatusResult,
} from "../controllers/memory.ts";

type MemoryProps = {
  connected: boolean;
  statusLoading: boolean;
  statusError: string | null;
  status: MemoryStatusResult | null;
  sourcesLoading: boolean;
  sourcesError: string | null;
  sources: MemorySourcesResult | null;
  searchQuery: string;
  searchCorpus: MemorySearchCorpus;
  searchMaxResults: number;
  searchMinScore: string;
  searchLoading: boolean;
  searchError: string | null;
  searchResults: MemorySearchResult[];
  searchDebug: unknown;
  indexLoading: boolean;
  indexError: string | null;
  indexMessage: string | null;
  jobsLoading: boolean;
  jobsError: string | null;
  jobs: MemoryIndexJob[];
  sourceOpenLoading: boolean;
  sourceOpenError: string | null;
  sourceOpen: MemorySourceOpenResult | null;
  onRefresh: () => void;
  onProbe: () => void;
  onSearchQueryChange: (next: string) => void;
  onSearchCorpusChange: (next: MemorySearchCorpus) => void;
  onSearchMaxResultsChange: (next: number) => void;
  onSearchMinScoreChange: (next: string) => void;
  onSearch: () => void;
  onClearSearch: () => void;
  onRunIndex: (force: boolean) => void;
  onRefreshJobs: () => void;
  onOpenSource: (sourceRef: string) => void;
  onCloseSource: () => void;
};

type ProviderStatus = Record<string, unknown>;

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatCount(value: unknown): string {
  const count = asNumber(value);
  return count == null ? t("common.na") : count.toLocaleString();
}

function formatBoolean(value: unknown): string {
  return typeof value === "boolean" ? (value ? t("common.yes") : t("common.no")) : t("common.na");
}

function formatTime(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return t("common.na");
  }
  return new Date(value).toLocaleString();
}

function agentStatuses(status: MemoryStatusResult | null) {
  return Array.isArray(status?.agents) ? status.agents : [];
}

function firstStatus(status: MemoryStatusResult | null): ProviderStatus {
  return (agentStatuses(status)[0]?.status ?? {}) as ProviderStatus;
}

function summarizeStatus(status: MemoryStatusResult | null) {
  const agents = agentStatuses(status);
  let files = 0;
  let chunks = 0;
  let dirty = 0;
  for (const agent of agents) {
    const current = (agent.status ?? {}) as ProviderStatus;
    files += asNumber(current.files) ?? 0;
    chunks += asNumber(current.chunks) ?? 0;
    dirty += current.dirty === true ? 1 : 0;
  }
  return { agents: agents.length, files, chunks, dirty };
}

function renderMetric(label: string, value: unknown, hint?: string) {
  return html`
    <div class="stat-card">
      <div class="stat-label">${label}</div>
      <div class="stat-value">${String(value)}</div>
      ${hint ? html`<div class="stat-hint">${hint}</div>` : nothing}
    </div>
  `;
}

function renderOverview(props: MemoryProps) {
  const summary = summarizeStatus(props.status);
  const scope = props.status?.scope;
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; gap: 12px; align-items: flex-start;">
        <div>
          <div class="card-title">Memory Overview</div>
          <div class="card-sub">
            Gateway-scoped memory status for the current session. Permissions are enforced by the
            backend.
          </div>
        </div>
        <div class="row">
          <button
            class="btn"
            ?disabled=${props.statusLoading || !props.connected}
            @click=${props.onRefresh}
          >
            ${props.statusLoading ? t("common.refreshing") : t("common.refresh")}
          </button>
          <button
            class="btn"
            ?disabled=${props.statusLoading || !props.connected}
            @click=${props.onProbe}
          >
            ${t("common.probe")}
          </button>
        </div>
      </div>
      ${props.statusError
        ? html`<div class="callout danger" style="margin-top: 12px;">${props.statusError}</div>`
        : nothing}
      <div class="stats-grid" style="margin-top: 14px;">
        ${renderMetric("Requester", props.status?.requesterAgentId ?? t("common.na"))}
        ${renderMetric("Visible agents", summary.agents)} ${renderMetric("Files", summary.files)}
        ${renderMetric("Chunks", summary.chunks)} ${renderMetric("Dirty agents", summary.dirty)}
        ${renderMetric("Cross-agent scope", formatBoolean(scope?.crossAgent))}
      </div>
      ${scope?.allowedAgentIds?.length
        ? html`<div class="muted" style="margin-top: 12px;">
            Scope: ${scope.allowedAgentIds.join(", ")}
          </div>`
        : nothing}
    </section>
  `;
}

function renderProviderCards(props: MemoryProps) {
  const status = firstStatus(props.status);
  const fts = (status.fts ?? {}) as ProviderStatus;
  const vector = (status.vector ?? {}) as ProviderStatus;
  const cache = (status.cache ?? {}) as ProviderStatus;
  const fallback = (status.fallback ?? {}) as ProviderStatus;
  return html`
    <section class="grid" style="margin-top: 18px;">
      <div class="card">
        <div class="card-title">Provider</div>
        <div class="card-sub">Backend status, model and source counts.</div>
        <div class="kv-list" style="margin-top: 12px;">
          <div>
            <span>Backend</span><strong>${String(status.backend ?? t("common.na"))}</strong>
          </div>
          <div>
            <span>Provider</span><strong>${String(status.provider ?? t("common.na"))}</strong>
          </div>
          <div><span>Model</span><strong>${String(status.model ?? t("common.na"))}</strong></div>
          <div>
            <span>Sources</span
            ><strong
              >${Array.isArray(status.sources) ? status.sources.join(", ") : t("common.na")}</strong
            >
          </div>
          <div>
            <span>Fallback</span
            ><strong
              >${fallback.reason
                ? `${String(fallback.from ?? "")}: ${String(fallback.reason)}`
                : t("common.na")}</strong
            >
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">FTS</div>
        <div class="card-sub">Full-text search availability.</div>
        <div class="kv-list" style="margin-top: 12px;">
          <div><span>Enabled</span><strong>${formatBoolean(fts.enabled)}</strong></div>
          <div><span>Available</span><strong>${formatBoolean(fts.available)}</strong></div>
          <div><span>Error</span><strong>${String(fts.error ?? t("common.na"))}</strong></div>
          <div><span>Cache</span><strong>${JSON.stringify(cache)}</strong></div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Vector</div>
        <div class="card-sub">Vector index and embedding availability.</div>
        <div class="kv-list" style="margin-top: 12px;">
          <div><span>Enabled</span><strong>${formatBoolean(vector.enabled)}</strong></div>
          <div><span>Available</span><strong>${formatBoolean(vector.available)}</strong></div>
          <div><span>Dims</span><strong>${formatCount(vector.dims)}</strong></div>
          <div><span>Batch</span><strong>${JSON.stringify(status.batch ?? {})}</strong></div>
        </div>
      </div>
    </section>
  `;
}

function renderSources(props: MemoryProps) {
  const agents = Array.isArray(props.sources?.agents) ? props.sources.agents : [];
  return html`
    <section class="card" style="margin-top: 18px;">
      <div class="row" style="justify-content: space-between; gap: 12px;">
        <div>
          <div class="card-title">Sources / dirty state</div>
          <div class="card-sub">Source summaries returned by memory.sources.list.</div>
        </div>
        <button
          class="btn"
          ?disabled=${props.sourcesLoading || !props.connected}
          @click=${props.onRefresh}
        >
          ${props.sourcesLoading ? t("common.refreshing") : t("common.refresh")}
        </button>
      </div>
      ${props.sourcesError
        ? html`<div class="callout danger" style="margin-top: 12px;">${props.sourcesError}</div>`
        : nothing}
      ${agents.length === 0
        ? html`<div class="muted" style="margin-top: 12px;">No sources returned yet.</div>`
        : html`
            <div class="table-wrap" style="margin-top: 12px;">
              <table>
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Source</th>
                    <th>Files</th>
                    <th>Chunks</th>
                  </tr>
                </thead>
                <tbody>
                  ${agents.flatMap((agent) =>
                    (agent.sources ?? []).map(
                      (source) => html`
                        <tr>
                          <td class="mono">${agent.agentId}</td>
                          <td>${source.source ?? t("common.na")}</td>
                          <td>${formatCount(source.files)}</td>
                          <td>${formatCount(source.chunks)}</td>
                        </tr>
                      `,
                    ),
                  )}
                </tbody>
              </table>
            </div>
          `}
    </section>
  `;
}

function renderIndexJobs(props: MemoryProps) {
  return html`
    <section class="card" style="margin-top: 18px;">
      <div class="row" style="justify-content: space-between; gap: 12px; align-items: flex-start;">
        <div>
          <div class="card-title">Index jobs</div>
          <div class="card-sub">
            Trigger visible-scope indexing and inspect recent in-memory jobs.
          </div>
        </div>
        <div class="row">
          <button
            class="btn"
            ?disabled=${props.jobsLoading || !props.connected}
            @click=${props.onRefreshJobs}
          >
            ${props.jobsLoading ? t("common.refreshing") : t("common.refresh")}
          </button>
          <button
            class="btn"
            ?disabled=${props.indexLoading || !props.connected}
            @click=${() => props.onRunIndex(false)}
          >
            ${props.indexLoading ? t("common.working") : "Run index"}
          </button>
          <button
            class="btn danger"
            ?disabled=${props.indexLoading || !props.connected}
            @click=${() => {
              if (
                confirm(
                  "Force re-index visible memory sources? This will not delete or rewrite source files.",
                )
              ) {
                props.onRunIndex(true);
              }
            }}
          >
            Force re-index
          </button>
        </div>
      </div>
      <div class="callout info" style="margin-top: 12px;">
        Index actions operate only on backend-resolved visible scope. This UI never sends agent
        override or path params.
      </div>
      ${props.indexMessage
        ? html`<div class="callout success" style="margin-top: 12px;">${props.indexMessage}</div>`
        : nothing}
      ${props.indexError
        ? html`<div class="callout danger" style="margin-top: 12px;">${props.indexError}</div>`
        : nothing}
      ${props.jobsError
        ? html`<div class="callout danger" style="margin-top: 12px;">${props.jobsError}</div>`
        : nothing}
      ${props.jobs.length === 0
        ? html`<div class="muted" style="margin-top: 12px;">No index jobs yet.</div>`
        : html`
            <div class="table-wrap" style="margin-top: 12px;">
              <table>
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Status</th>
                    <th>Force</th>
                    <th>Progress</th>
                    <th>Agents</th>
                    <th>Updated</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  ${props.jobs.map(
                    (job) => html`
                      <tr>
                        <td class="mono">${job.jobId ?? job.id ?? t("common.na")}</td>
                        <td>${job.status ?? t("common.na")}</td>
                        <td>${formatBoolean(job.force)}</td>
                        <td>
                          ${job.progress
                            ? `${job.progress.completed ?? 0}/${job.progress.total ?? 0} ${job.progress.label ?? ""}`
                            : t("common.na")}
                        </td>
                        <td class="mono">${job.agentIds?.join(", ") ?? t("common.na")}</td>
                        <td>${formatTime(job.updatedAtMs)}</td>
                        <td>${job.error ?? ""}</td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            </div>
          `}
    </section>
  `;
}

function resultLineRange(result: MemorySearchResult): string {
  const start = result.start_line ?? result.startLine;
  const end = result.end_line ?? result.endLine;
  if (start == null && end == null) {
    return t("common.na");
  }
  return end == null || end === start ? String(start) : `${start}-${end}`;
}

function resultPath(result: MemorySearchResult): string {
  return result.source_path ?? result.sourcePath ?? result.path ?? t("common.na");
}

function renderSearch(props: MemoryProps) {
  return html`
    <section class="card" style="margin-top: 18px;">
      <div class="card-title">Search debug</div>
      <div class="card-sub">Debug memory retrieval with backend-enforced scope and provenance.</div>
      <div class="grid" style="margin-top: 14px;">
        <label class="field">
          <span>Query</span>
          <textarea
            rows="3"
            .value=${props.searchQuery}
            @input=${(event: Event) =>
              props.onSearchQueryChange((event.target as HTMLTextAreaElement).value)}
            placeholder="Search visible memory…"
          ></textarea>
        </label>
        <div class="stack">
          <label class="field">
            <span>Corpus</span>
            <select
              .value=${props.searchCorpus}
              @change=${(event: Event) =>
                props.onSearchCorpusChange(
                  (event.target as HTMLSelectElement).value as MemorySearchCorpus,
                )}
            >
              <option value="all">All</option>
              <option value="memory">Memory</option>
              <option value="sessions">Sessions</option>
            </select>
          </label>
          <label class="field">
            <span>Max results</span>
            <input
              type="number"
              min="1"
              max="50"
              .value=${String(props.searchMaxResults)}
              @input=${(event: Event) =>
                props.onSearchMaxResultsChange(Number((event.target as HTMLInputElement).value))}
            />
          </label>
          <label class="field">
            <span>Min score</span>
            <input
              .value=${props.searchMinScore}
              placeholder="optional"
              @input=${(event: Event) =>
                props.onSearchMinScoreChange((event.target as HTMLInputElement).value)}
            />
          </label>
        </div>
      </div>
      <div class="row" style="margin-top: 12px;">
        <button
          class="btn primary"
          ?disabled=${props.searchLoading || !props.connected}
          @click=${props.onSearch}
        >
          ${props.searchLoading ? t("common.search") + "…" : t("common.search")}
        </button>
        <button class="btn" ?disabled=${props.searchLoading} @click=${props.onClearSearch}>
          Clear
        </button>
      </div>
      ${props.searchError
        ? html`<div class="callout danger" style="margin-top: 12px;">${props.searchError}</div>`
        : nothing}
      ${props.searchResults.length === 0
        ? html`<div class="muted" style="margin-top: 12px;">No search results yet.</div>`
        : html`
            <div class="table-wrap" style="margin-top: 12px;">
              <table>
                <thead>
                  <tr>
                    <th>Source path</th>
                    <th>Line range</th>
                    <th>Agent</th>
                    <th>Score</th>
                    <th>Match</th>
                    <th>Snippet</th>
                    <th>Open</th>
                  </tr>
                </thead>
                <tbody>
                  ${props.searchResults.map(
                    (result) => html`
                      <tr>
                        <td class="mono">${resultPath(result)}</td>
                        <td>${resultLineRange(result)}</td>
                        <td class="mono">${result.agent_id ?? result.agentId ?? t("common.na")}</td>
                        <td>
                          ${typeof result.score === "number"
                            ? result.score.toFixed(4)
                            : t("common.na")}
                        </td>
                        <td>${result.matchType ?? result.source ?? t("common.na")}</td>
                        <td>${result.snippet ?? ""}</td>
                        <td>
                          ${result.sourceRef
                            ? html`<button
                                class="btn small"
                                ?disabled=${props.sourceOpenLoading}
                                @click=${() => props.onOpenSource(result.sourceRef!)}
                              >
                                Open
                              </button>`
                            : html`<span class="muted">n/a</span>`}
                        </td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            </div>
          `}
      ${props.searchDebug
        ? html`<details style="margin-top: 12px;">
            <summary>Runtime debug</summary>
            <pre class="code-block">${JSON.stringify(props.searchDebug, null, 2)}</pre>
          </details>`
        : nothing}
    </section>
  `;
}

function renderSourceOpen(props: MemoryProps) {
  if (!props.sourceOpen && !props.sourceOpenError) {
    return nothing;
  }
  return html`
    <section class="card" style="margin-top: 18px;">
      <div class="row" style="justify-content: space-between; gap: 12px;">
        <div>
          <div class="card-title">Opened source</div>
          <div class="card-sub">Read-only excerpt returned by memory.source.open.</div>
        </div>
        <button class="btn" @click=${props.onCloseSource}>Close</button>
      </div>
      ${props.sourceOpenError
        ? html`<div class="callout danger" style="margin-top: 12px;">${props.sourceOpenError}</div>`
        : nothing}
      ${props.sourceOpen
        ? html`
            <div class="muted" style="margin-top: 12px;">
              <span class="mono">${props.sourceOpen.path ?? t("common.na")}</span>
              · agent ${props.sourceOpen.agentId ?? t("common.na")} · from
              ${props.sourceOpen.from ?? t("common.na")}
            </div>
            <pre class="code-block" style="margin-top: 12px; white-space: pre-wrap;">
${props.sourceOpen.text ?? ""}</pre
            >
            ${props.sourceOpen.truncated
              ? html`<div class="muted" style="margin-top: 8px;">
                  Truncated. Next line: ${props.sourceOpen.nextFrom ?? t("common.na")}
                </div>`
              : nothing}
          `
        : nothing}
    </section>
  `;
}

export function renderMemory(props: MemoryProps) {
  return html`
    <section class="stack">
      ${!props.connected
        ? html`<div class="callout warn">
            Gateway is offline. Connect before loading Memory status.
          </div>`
        : nothing}
      ${renderOverview(props)} ${renderProviderCards(props)} ${renderSources(props)}
      ${renderIndexJobs(props)} ${renderSearch(props)} ${renderSourceOpen(props)}
    </section>
  `;
}
