import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { formatRelativeTimestamp } from "../format.ts";
import { toSanitizedMarkdownHtml } from "../markdown.ts";
import {
  formatCronPayload,
  formatCronSchedule,
  formatCronState,
  formatNextRun,
} from "../presenter.ts";
import type {
  AgentWorkspaceEntry,
  AgentFileEntry,
  AgentsFilesListResult,
  AgentsFilesReadResult,
  AgentsFilesTreeResult,
  ChannelAccountSnapshot,
  ChannelsStatusSnapshot,
  CronJob,
  CronStatus,
} from "../types.ts";
import { formatBytes, type AgentContext } from "./agents-utils.ts";

function renderAgentContextCard(context: AgentContext, subtitle: string) {
  return html`
    <section class="card">
      <div class="card-title">Agent Context</div>
      <div class="card-sub">${subtitle}</div>
      <div class="agents-overview-grid" style="margin-top: 16px;">
        <div class="agent-kv">
          <div class="label">Workspace</div>
          <div class="mono">${context.workspace}</div>
        </div>
        <div class="agent-kv">
          <div class="label">Primary Model</div>
          <div class="mono">${context.model}</div>
        </div>
        <div class="agent-kv">
          <div class="label">Identity Name</div>
          <div>${context.identityName}</div>
        </div>
        <div class="agent-kv">
          <div class="label">Identity Emoji</div>
          <div>${context.identityEmoji}</div>
        </div>
        <div class="agent-kv">
          <div class="label">Skills Filter</div>
          <div>${context.skillsLabel}</div>
        </div>
        <div class="agent-kv">
          <div class="label">Default</div>
          <div>${context.isDefault ? "yes" : "no"}</div>
        </div>
      </div>
    </section>
  `;
}

type ChannelSummaryEntry = {
  id: string;
  label: string;
  accounts: ChannelAccountSnapshot[];
};

function resolveChannelLabel(snapshot: ChannelsStatusSnapshot, id: string) {
  const meta = snapshot.channelMeta?.find((entry) => entry.id === id);
  if (meta?.label) {
    return meta.label;
  }
  return snapshot.channelLabels?.[id] ?? id;
}

function resolveChannelEntries(snapshot: ChannelsStatusSnapshot | null): ChannelSummaryEntry[] {
  if (!snapshot) {
    return [];
  }
  const ids = new Set<string>();
  for (const id of snapshot.channelOrder ?? []) {
    ids.add(id);
  }
  for (const entry of snapshot.channelMeta ?? []) {
    ids.add(entry.id);
  }
  for (const id of Object.keys(snapshot.channelAccounts ?? {})) {
    ids.add(id);
  }
  const ordered: string[] = [];
  const seed = snapshot.channelOrder?.length ? snapshot.channelOrder : Array.from(ids);
  for (const id of seed) {
    if (!ids.has(id)) {
      continue;
    }
    ordered.push(id);
    ids.delete(id);
  }
  for (const id of ids) {
    ordered.push(id);
  }
  return ordered.map((id) => ({
    id,
    label: resolveChannelLabel(snapshot, id),
    accounts: snapshot.channelAccounts?.[id] ?? [],
  }));
}

const CHANNEL_EXTRA_FIELDS = ["groupPolicy", "streamMode", "dmPolicy"] as const;

function resolveChannelConfigValue(
  configForm: Record<string, unknown> | null,
  channelId: string,
): Record<string, unknown> | null {
  if (!configForm) {
    return null;
  }
  const channels = (configForm.channels ?? {}) as Record<string, unknown>;
  const fromChannels = channels[channelId];
  if (fromChannels && typeof fromChannels === "object") {
    return fromChannels as Record<string, unknown>;
  }
  const fallback = configForm[channelId];
  if (fallback && typeof fallback === "object") {
    return fallback as Record<string, unknown>;
  }
  return null;
}

function formatChannelExtraValue(raw: unknown): string {
  if (raw == null) {
    return "n/a";
  }
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    return String(raw);
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return "n/a";
  }
}

function resolveChannelExtras(
  configForm: Record<string, unknown> | null,
  channelId: string,
): Array<{ label: string; value: string }> {
  const value = resolveChannelConfigValue(configForm, channelId);
  if (!value) {
    return [];
  }
  return CHANNEL_EXTRA_FIELDS.flatMap((field) => {
    if (!(field in value)) {
      return [];
    }
    return [{ label: field, value: formatChannelExtraValue(value[field]) }];
  });
}

function summarizeChannelAccounts(accounts: ChannelAccountSnapshot[]) {
  let connected = 0;
  let configured = 0;
  let enabled = 0;
  for (const account of accounts) {
    const probeOk =
      account.probe && typeof account.probe === "object" && "ok" in account.probe
        ? Boolean((account.probe as { ok?: unknown }).ok)
        : false;
    const isConnected = account.connected === true || account.running === true || probeOk;
    if (isConnected) {
      connected += 1;
    }
    if (account.configured) {
      configured += 1;
    }
    if (account.enabled) {
      enabled += 1;
    }
  }
  return {
    total: accounts.length,
    connected,
    configured,
    enabled,
  };
}

export function renderAgentChannels(params: {
  context: AgentContext;
  configForm: Record<string, unknown> | null;
  snapshot: ChannelsStatusSnapshot | null;
  loading: boolean;
  error: string | null;
  lastSuccess: number | null;
  onRefresh: () => void;
}) {
  const entries = resolveChannelEntries(params.snapshot);
  const lastSuccessLabel = params.lastSuccess
    ? formatRelativeTimestamp(params.lastSuccess)
    : "never";
  return html`
    <section class="grid grid-cols-2">
      ${renderAgentContextCard(params.context, "Workspace, identity, and model configuration.")}
      <section class="card">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="card-title">Channels</div>
            <div class="card-sub">Gateway-wide channel status snapshot.</div>
          </div>
          <button class="btn btn--sm" ?disabled=${params.loading} @click=${params.onRefresh}>
            ${params.loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        <div class="muted" style="margin-top: 8px;">
          Last refresh: ${lastSuccessLabel}
        </div>
        ${
          params.error
            ? html`<div class="callout danger" style="margin-top: 12px;">${params.error}</div>`
            : nothing
        }
        ${
          !params.snapshot
            ? html`
                <div class="callout info" style="margin-top: 12px">Load channels to see live status.</div>
              `
            : nothing
        }
        ${
          entries.length === 0
            ? html`
                <div class="muted" style="margin-top: 16px">No channels found.</div>
              `
            : html`
                <div class="list" style="margin-top: 16px;">
                  ${entries.map((entry) => {
                    const summary = summarizeChannelAccounts(entry.accounts);
                    const status = summary.total
                      ? `${summary.connected}/${summary.total} connected`
                      : "no accounts";
                    const config = summary.configured
                      ? `${summary.configured} configured`
                      : "not configured";
                    const enabled = summary.total ? `${summary.enabled} enabled` : "disabled";
                    const extras = resolveChannelExtras(params.configForm, entry.id);
                    return html`
                      <div class="list-item">
                        <div class="list-main">
                          <div class="list-title">${entry.label}</div>
                          <div class="list-sub mono">${entry.id}</div>
                        </div>
                        <div class="list-meta">
                          <div>${status}</div>
                          <div>${config}</div>
                          <div>${enabled}</div>
                          ${
                            extras.length > 0
                              ? extras.map(
                                  (extra) => html`<div>${extra.label}: ${extra.value}</div>`,
                                )
                              : nothing
                          }
                        </div>
                      </div>
                    `;
                  })}
                </div>
              `
        }
      </section>
    </section>
  `;
}

export function renderAgentCron(params: {
  context: AgentContext;
  agentId: string;
  jobs: CronJob[];
  status: CronStatus | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const jobs = params.jobs.filter((job) => job.agentId === params.agentId);
  return html`
    <section class="grid grid-cols-2">
      ${renderAgentContextCard(params.context, "Workspace and scheduling targets.")}
      <section class="card">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="card-title">Scheduler</div>
            <div class="card-sub">Gateway cron status.</div>
          </div>
          <button class="btn btn--sm" ?disabled=${params.loading} @click=${params.onRefresh}>
            ${params.loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        <div class="stat-grid" style="margin-top: 16px;">
          <div class="stat">
            <div class="stat-label">Enabled</div>
            <div class="stat-value">
              ${params.status ? (params.status.enabled ? "Yes" : "No") : "n/a"}
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">Jobs</div>
            <div class="stat-value">${params.status?.jobs ?? "n/a"}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Next wake</div>
            <div class="stat-value">${formatNextRun(params.status?.nextWakeAtMs ?? null)}</div>
          </div>
        </div>
        ${
          params.error
            ? html`<div class="callout danger" style="margin-top: 12px;">${params.error}</div>`
            : nothing
        }
      </section>
    </section>
    <section class="card">
      <div class="card-title">Agent Cron Jobs</div>
      <div class="card-sub">Scheduled jobs targeting this agent.</div>
      ${
        jobs.length === 0
          ? html`
              <div class="muted" style="margin-top: 16px">No jobs assigned.</div>
            `
          : html`
              <div class="list" style="margin-top: 16px;">
                ${jobs.map(
                  (job) => html`
                    <div class="list-item">
                      <div class="list-main">
                        <div class="list-title">${job.name}</div>
                        ${
                          job.description
                            ? html`<div class="list-sub">${job.description}</div>`
                            : nothing
                        }
                        <div class="chip-row" style="margin-top: 6px;">
                          <span class="chip">${formatCronSchedule(job)}</span>
                          <span class="chip ${job.enabled ? "chip-ok" : "chip-warn"}">
                            ${job.enabled ? "enabled" : "disabled"}
                          </span>
                          <span class="chip">${job.sessionTarget}</span>
                        </div>
                      </div>
                      <div class="list-meta">
                        <div class="mono">${formatCronState(job)}</div>
                        <div class="muted">${formatCronPayload(job)}</div>
                      </div>
                    </div>
                  `,
                )}
              </div>
            `
      }
    </section>
  `;
}

function maskLikelySecrets(content: string): string {
  const patterns: RegExp[] = [
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bsk-[A-Za-z0-9]{20,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    /\bAIza[0-9A-Za-z\-_]{20,}\b/g,
  ];
  let masked = content;
  for (const pattern of patterns) {
    masked = masked.replace(pattern, (token) => `${token.slice(0, 6)}…${token.slice(-4)}`);
  }
  return masked;
}

function countMatches(haystack: string, needle: string): number {
  const query = needle.trim().toLowerCase();
  if (!query) {
    return 0;
  }
  const target = haystack.toLowerCase();
  let from = 0;
  let count = 0;
  while (from < target.length) {
    const idx = target.indexOf(query, from);
    if (idx < 0) {
      break;
    }
    count += 1;
    from = idx + query.length;
  }
  return count;
}

function renderWorkspaceTreeEntry(
  entry: AgentWorkspaceEntry,
  activePath: string | null,
  onSelect: (path: string) => void,
) {
  if (entry.type === "dir") {
    return html`
      <div class="agent-tree-dir" style=${`padding-left: ${entry.depth * 14 + 8}px;`}>
        <span class="mono">${entry.name}/</span>
      </div>
    `;
  }
  const status = `${entry.markdown ? "markdown" : "file"} · ${formatBytes(entry.size)} · ${formatRelativeTimestamp(
    entry.updatedAtMs ?? null,
  )}`;
  return html`
    <button
      type="button"
      class="agent-tree-file ${activePath === entry.path ? "active" : ""}"
      style=${`padding-left: ${entry.depth * 14 + 8}px;`}
      @click=${() => onSelect(entry.path)}
    >
      <div>
        <div class="agent-file-name mono">${entry.name}</div>
        <div class="agent-file-meta">${status}</div>
      </div>
    </button>
  `;
}

export function renderAgentFiles(params: {
  agentId: string;
  agentFilesList: AgentsFilesListResult | null;
  agentFilesLoading: boolean;
  agentFilesError: string | null;
  agentFileActive: string | null;
  agentFileContents: Record<string, string>;
  agentFileDrafts: Record<string, string>;
  agentFileSaving: boolean;
  agentFilesTree: AgentsFilesTreeResult | null;
  agentFilesIncludeAll: boolean;
  agentMarkdownActivePath: string | null;
  agentMarkdownRendered: boolean;
  agentMarkdownSearch: string;
  agentMarkdownRead: AgentsFilesReadResult | null;
  agentMarkdownReadLoading: boolean;
  agentMarkdownReadError: string | null;
  onLoadFiles: (agentId: string) => void;
  onToggleIncludeAllFiles: (enabled: boolean) => void;
  onSelectWorkspaceFile: (path: string) => void;
  onLoadMoreWorkspaceFile: () => void;
  onToggleWorkspaceRenderMode: (rendered: boolean) => void;
  onWorkspaceSearchChange: (value: string) => void;
  onSelectFile: (name: string) => void;
  onFileDraftChange: (name: string, content: string) => void;
  onFileReset: (name: string) => void;
  onFileSave: (name: string) => void;
}) {
  const list = params.agentFilesList?.agentId === params.agentId ? params.agentFilesList : null;
  const files = list?.files ?? [];
  const active = params.agentFileActive ?? null;
  const activeEntry = active ? (files.find((file) => file.name === active) ?? null) : null;
  const baseContent = active ? (params.agentFileContents[active] ?? "") : "";
  const draft = active ? (params.agentFileDrafts[active] ?? baseContent) : "";
  const isDirty = active ? draft !== baseContent : false;
  const tree = params.agentFilesTree?.agentId === params.agentId ? params.agentFilesTree : null;
  const entries = tree?.entries ?? [];
  const activeRead = params.agentMarkdownRead;
  const safeContent = activeRead ? maskLikelySecrets(activeRead.content) : "";
  const searchCount = activeRead ? countMatches(safeContent, params.agentMarkdownSearch) : 0;

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; gap: 12px; flex-wrap: wrap;">
        <div>
          <div class="card-title">Workspace Markdown Explorer</div>
          <div class="card-sub">Read-only tree + viewer for agent workspace docs.</div>
        </div>
        <div class="row" style="gap: 8px; flex-wrap: wrap;">
          <label class="field" style="margin: 0; min-width: 180px;">
            <span>Search in file</span>
            <input
              .value=${params.agentMarkdownSearch}
              @input=${(e: Event) =>
                params.onWorkspaceSearchChange((e.target as HTMLInputElement).value)}
              placeholder="Find text"
            />
          </label>
          <button
            class="btn btn--sm ${params.agentMarkdownRendered ? "active" : ""}"
            @click=${() => params.onToggleWorkspaceRenderMode(true)}
          >
            Rendered
          </button>
          <button
            class="btn btn--sm ${!params.agentMarkdownRendered ? "active" : ""}"
            @click=${() => params.onToggleWorkspaceRenderMode(false)}
          >
            Raw
          </button>
          <label class="cfg-toggle" title="Show all files">
            <input
              type="checkbox"
              .checked=${params.agentFilesIncludeAll}
              @change=${(e: Event) =>
                params.onToggleIncludeAllFiles((e.target as HTMLInputElement).checked)}
            />
            <span class="cfg-toggle__track"></span>
          </label>
          <button
            class="btn btn--sm"
            ?disabled=${params.agentFilesLoading}
            @click=${() => params.onLoadFiles(params.agentId)}
          >
            ${params.agentFilesLoading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>
      ${
        tree
          ? html`<div class="muted mono" style="margin-top: 8px;">Workspace: ${tree.workspace}</div>`
          : nothing
      }
      ${
        tree
          ? html`
              <div class="muted" style="margin-top: 6px;">
                ${tree.markdownCount} markdown · ${tree.fileCount} files · ${tree.dirCount} folders
              </div>
            `
          : nothing
      }
      ${
        params.agentFilesError
          ? html`<div class="callout danger" style="margin-top: 12px;">${params.agentFilesError}</div>`
          : nothing
      }
      ${
        params.agentMarkdownReadError
          ? html`
              <div class="callout danger" style="margin-top: 12px;">${params.agentMarkdownReadError}</div>
            `
          : nothing
      }
      ${
        !tree
          ? html`
              <div class="callout info" style="margin-top: 12px">
                Load files to browse markdown documents.
              </div>
            `
          : html`
              <div class="agent-files-grid agent-files-grid--explorer" style="margin-top: 14px;">
                <div class="agent-files-list agent-tree-list">
                  ${
                    entries.length === 0
                      ? html`<div class="muted">No files found.</div>`
                      : entries.map((entry) =>
                          renderWorkspaceTreeEntry(
                            entry,
                            params.agentMarkdownActivePath,
                            params.onSelectWorkspaceFile,
                          ),
                        )
                  }
                </div>
                <div class="agent-files-editor agent-markdown-viewer">
                  ${
                    !activeRead
                      ? html`<div class="muted">Select a file to preview.</div>`
                      : html`
                          <div class="agent-file-header agent-file-header--sticky">
                            <div>
                              <div class="agent-file-title mono">${activeRead.file.path}</div>
                              <div class="agent-file-sub">
                                ${formatBytes(activeRead.file.size)} · ${formatRelativeTimestamp(
                                  activeRead.file.updatedAtMs,
                                )} · ${activeRead.file.markdown ? "markdown" : "text"}
                              </div>
                            </div>
                            <div class="muted">${searchCount > 0 ? `${searchCount} matches` : ""}</div>
                          </div>
                          <div class="agent-markdown-body">
                            ${
                              params.agentMarkdownRendered
                                ? html`
                                    <article class="md-content">${unsafeHTML(
                                      toSanitizedMarkdownHtml(safeContent),
                                    )}</article>
                                  `
                                : html`<pre class="code-block">${safeContent}</pre>`
                            }
                          </div>
                          ${
                            activeRead.truncated
                              ? html`
                                  <div class="row" style="justify-content: flex-end; margin-top: 12px;">
                                    <button
                                      class="btn btn--sm"
                                      ?disabled=${params.agentMarkdownReadLoading}
                                      @click=${params.onLoadMoreWorkspaceFile}
                                    >
                                      ${params.agentMarkdownReadLoading ? "Loading…" : "Load more"}
                                    </button>
                                  </div>
                                `
                              : nothing
                          }
                        `
                  }
                </div>
              </div>
            `
      }
    </section>

    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Core Files</div>
          <div class="card-sub">Bootstrap persona, identity, and tool guidance.</div>
        </div>
        <button
          class="btn btn--sm"
          ?disabled=${params.agentFilesLoading}
          @click=${() => params.onLoadFiles(params.agentId)}
        >
          ${params.agentFilesLoading ? "Loading…" : "Refresh"}
        </button>
      </div>
      ${
        list
          ? html`<div class="muted mono" style="margin-top: 8px;">Workspace: ${list.workspace}</div>`
          : nothing
      }
      ${
        params.agentFilesError
          ? html`<div class="callout danger" style="margin-top: 12px;">${params.agentFilesError}</div>`
          : nothing
      }
      ${
        !list
          ? html`
              <div class="callout info" style="margin-top: 12px">
                Load the agent workspace files to edit core instructions.
              </div>
            `
          : html`
              <div class="agent-files-grid" style="margin-top: 16px;">
                <div class="agent-files-list">
                  ${
                    files.length === 0
                      ? html`
                          <div class="muted">No files found.</div>
                        `
                      : files.map((file) =>
                          renderAgentFileRow(file, active, () => params.onSelectFile(file.name)),
                        )
                  }
                </div>
                <div class="agent-files-editor">
                  ${
                    !activeEntry
                      ? html`
                          <div class="muted">Select a file to edit.</div>
                        `
                      : html`
                          <div class="agent-file-header">
                            <div>
                              <div class="agent-file-title mono">${activeEntry.name}</div>
                              <div class="agent-file-sub mono">${activeEntry.path}</div>
                            </div>
                            <div class="agent-file-actions">
                              <button
                                class="btn btn--sm"
                                ?disabled=${!isDirty}
                                @click=${() => params.onFileReset(activeEntry.name)}
                              >
                                Reset
                              </button>
                              <button
                                class="btn btn--sm primary"
                                ?disabled=${params.agentFileSaving || !isDirty}
                                @click=${() => params.onFileSave(activeEntry.name)}
                              >
                                ${params.agentFileSaving ? "Saving…" : "Save"}
                              </button>
                            </div>
                          </div>
                          ${
                            activeEntry.missing
                              ? html`
                                  <div class="callout info" style="margin-top: 10px">
                                    This file is missing. Saving will create it in the agent workspace.
                                  </div>
                                `
                              : nothing
                          }
                          <label class="field" style="margin-top: 12px;">
                            <span>Content</span>
                            <textarea
                              .value=${draft}
                              @input=${(e: Event) =>
                                params.onFileDraftChange(
                                  activeEntry.name,
                                  (e.target as HTMLTextAreaElement).value,
                                )}
                            ></textarea>
                          </label>
                        `
                  }
                </div>
              </div>
            `
      }
    </section>
  `;
}

function renderAgentFileRow(file: AgentFileEntry, active: string | null, onSelect: () => void) {
  const status = file.missing
    ? "Missing"
    : `${formatBytes(file.size)} · ${formatRelativeTimestamp(file.updatedAtMs ?? null)}`;
  return html`
    <button
      type="button"
      class="agent-file-row ${active === file.name ? "active" : ""}"
      @click=${onSelect}
    >
      <div>
        <div class="agent-file-name mono">${file.name}</div>
        <div class="agent-file-meta">${status}</div>
      </div>
      ${
        file.missing
          ? html`
              <span class="agent-pill warn">missing</span>
            `
          : nothing
      }
    </button>
  `;
}
