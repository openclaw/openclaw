import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../format.ts";
import {
  formatCronPayload,
  formatCronSchedule,
  formatCronState,
  formatNextRun,
} from "../presenter.ts";
import type {
  AgentFileEntry,
  AgentsFilesListResult,
  ChannelAccountSnapshot,
  ChannelsStatusSnapshot,
  CronJob,
  CronStatus,
} from "../types.ts";
import { formatBytes, type AgentContext } from "./agents-utils.ts";
import { resolveChannelExtras as resolveChannelExtrasFromConfig } from "./channel-config-extras.ts";

function renderAgentContextCard(context: AgentContext, subtitle: string) {
  return html`
    <section class="card">
      <div class="card-title">${t("agentsView.contextTitle")}</div>
      <div class="card-sub">${subtitle}</div>
      <div class="agents-overview-grid" style="margin-top: 16px;">
        <div class="agent-kv">
          <div class="label">${t("agentsView.fields.workspace")}</div>
          <div class="mono">${context.workspace}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${t("agentsView.fields.primaryModel")}</div>
          <div class="mono">${context.model}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${t("agentsView.fields.identityName")}</div>
          <div>${context.identityName}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${t("agentsView.fields.identityEmoji")}</div>
          <div>${context.identityEmoji}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${t("agentsView.fields.skillsFilter")}</div>
          <div>${context.skillsLabel}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${t("agentsView.fields.default")}</div>
          <div>${context.isDefault ? t("common.yes") : t("common.no")}</div>
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
    : t("common.na");
  return html`
    <section class="grid grid-cols-2">
      ${renderAgentContextCard(params.context, t("agentsView.contextSubtitle"))}
      <section class="card">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="card-title">${t("agentsView.channels.title")}</div>
            <div class="card-sub">${t("agentsView.channels.subtitle")}</div>
          </div>
          <button class="btn btn--sm" ?disabled=${params.loading} @click=${params.onRefresh}>
            ${params.loading ? t("common.refreshing") : t("common.refresh")}
          </button>
        </div>
        <div class="muted" style="margin-top: 8px;">
          ${t("agentsView.channels.lastRefresh", { time: lastSuccessLabel })}
        </div>
        ${
          params.error
            ? html`<div class="callout danger" style="margin-top: 12px;">${params.error}</div>`
            : nothing
        }
        ${
          !params.snapshot
            ? html`
                <div class="callout info" style="margin-top: 12px">${t("agentsView.channels.loadHint")}</div>
              `
            : nothing
        }
        ${
          entries.length === 0
            ? html`
                <div class="muted" style="margin-top: 16px">${t("agentsView.channels.noChannels")}</div>
              `
            : html`
                <div class="list" style="margin-top: 16px;">
                  ${entries.map((entry) => {
                    const summary = summarizeChannelAccounts(entry.accounts);
                    const status = summary.total
                      ? t("agentsView.channels.connectedSummary", {
                          connected: String(summary.connected),
                          total: String(summary.total),
                        })
                      : t("agentsView.channels.noAccounts");
                    const config = summary.configured
                      ? t("agentsView.channels.configuredSummary", {
                          count: String(summary.configured),
                        })
                      : t("agentsView.channels.notConfigured");
                    const enabled = summary.total
                      ? t("agentsView.channels.enabledSummary", { count: String(summary.enabled) })
                      : t("agentsView.channels.disabledSummary");
                    const extras = resolveChannelExtrasFromConfig({
                      configForm: params.configForm,
                      channelId: entry.id,
                      fields: CHANNEL_EXTRA_FIELDS,
                    });
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
      ${renderAgentContextCard(params.context, t("agentsView.cronContextSubtitle"))}
      <section class="card">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="card-title">${t("agentsView.scheduler.title")}</div>
            <div class="card-sub">${t("agentsView.scheduler.subtitle")}</div>
          </div>
          <button class="btn btn--sm" ?disabled=${params.loading} @click=${params.onRefresh}>
            ${params.loading ? t("common.refreshing") : t("common.refresh")}
          </button>
        </div>
        <div class="stat-grid" style="margin-top: 16px;">
          <div class="stat">
            <div class="stat-label">${t("agentsView.scheduler.enabled")}</div>
            <div class="stat-value">
              ${params.status ? (params.status.enabled ? t("common.yes") : t("common.no")) : t("common.na")}
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">${t("agentsView.scheduler.jobs")}</div>
            <div class="stat-value">${params.status?.jobs ?? t("common.na")}</div>
          </div>
          <div class="stat">
            <div class="stat-label">${t("agentsView.scheduler.nextWake")}</div>
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

export function renderAgentFiles(params: {
  agentId: string;
  agentFilesList: AgentsFilesListResult | null;
  agentFilesLoading: boolean;
  agentFilesError: string | null;
  agentFileActive: string | null;
  agentFileContents: Record<string, string>;
  agentFileDrafts: Record<string, string>;
  agentFileSaving: boolean;
  onLoadFiles: (agentId: string) => void;
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

  return html`
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
