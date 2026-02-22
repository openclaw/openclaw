import { html, nothing } from "lit";
import type {
  AgentIdentityResult,
  AgentsFilesListResult,
  AgentsListResult,
  ChannelsStatusSnapshot,
  CronJob,
  CronStatus,
  SkillStatusReport,
} from "../types.ts";
import { renderAgentOverview } from "./agents-panels-overview.ts";
import {
  renderAgentFiles,
  renderAgentChannels,
  renderAgentCron,
} from "./agents-panels-status-files.ts";
import { renderAgentTools, renderAgentSkills } from "./agents-panels-tools-skills.ts";
import {
  agentAvatarHue,
  agentBadgeText,
  buildAgentContext,
  normalizeAgentLabel,
  resolveAgentEmoji,
} from "./agents-utils.ts";

export type AgentsPanel = "overview" | "files" | "tools" | "skills" | "channels" | "cron";

export type ConfigState = {
  form: Record<string, unknown> | null;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
};

export type ChannelsState = {
  snapshot: ChannelsStatusSnapshot | null;
  loading: boolean;
  error: string | null;
  lastSuccess: number | null;
};

export type CronState = {
  status: CronStatus | null;
  jobs: CronJob[];
  loading: boolean;
  error: string | null;
};

export type AgentFilesState = {
  list: AgentsFilesListResult | null;
  loading: boolean;
  error: string | null;
  active: string | null;
  contents: Record<string, string>;
  drafts: Record<string, string>;
  saving: boolean;
};

export type AgentSkillsState = {
  report: SkillStatusReport | null;
  loading: boolean;
  error: string | null;
  agentId: string | null;
  filter: string;
};

export type AgentsProps = {
  loading: boolean;
  error: string | null;
  agentsList: AgentsListResult | null;
  selectedAgentId: string | null;
  activePanel: AgentsPanel;
  config: ConfigState;
  channels: ChannelsState;
  cron: CronState;
  agentFiles: AgentFilesState;
  agentIdentityLoading: boolean;
  agentIdentityError: string | null;
  agentIdentityById: Record<string, AgentIdentityResult>;
  agentSkills: AgentSkillsState;
  sidebarFilter: string;
  onSidebarFilterChange: (value: string) => void;
  onRefresh: () => void;
  onSelectAgent: (agentId: string) => void;
  onSelectPanel: (panel: AgentsPanel) => void;
  onLoadFiles: (agentId: string) => void;
  onSelectFile: (name: string) => void;
  onFileDraftChange: (name: string, content: string) => void;
  onFileReset: (name: string) => void;
  onFileSave: (name: string) => void;
  onToolsProfileChange: (agentId: string, profile: string | null, clearAllow: boolean) => void;
  onToolsOverridesChange: (agentId: string, alsoAllow: string[], deny: string[]) => void;
  onConfigReload: () => void;
  onConfigSave: () => void;
  onModelChange: (agentId: string, modelId: string | null) => void;
  onModelFallbacksChange: (agentId: string, fallbacks: string[]) => void;
  onChannelsRefresh: () => void;
  onCronRefresh: () => void;
  onCronRunNow: (jobId: string) => void;
  onSkillsFilterChange: (next: string) => void;
  onSkillsRefresh: () => void;
  onAgentSkillToggle: (agentId: string, skillName: string, enabled: boolean) => void;
  onAgentSkillsClear: (agentId: string) => void;
  onAgentSkillsDisableAll: (agentId: string) => void;
  onSetDefault: (agentId: string) => void;
};

export function renderAgents(props: AgentsProps) {
  const agents = props.agentsList?.agents ?? [];
  const defaultId = props.agentsList?.defaultId ?? null;
  const selectedId = props.selectedAgentId ?? defaultId ?? agents[0]?.id ?? null;
  const selectedAgent = selectedId
    ? (agents.find((agent) => agent.id === selectedId) ?? null)
    : null;

  const sidebarFilter = props.sidebarFilter.trim().toLowerCase();
  const filteredAgents = sidebarFilter
    ? agents.filter((agent) => {
        const label = normalizeAgentLabel(agent).toLowerCase();
        return label.includes(sidebarFilter) || agent.id.toLowerCase().includes(sidebarFilter);
      })
    : agents;

  const channelEntryCount = props.channels.snapshot
    ? Object.keys(props.channels.snapshot.channelAccounts ?? {}).length
    : null;
  const cronJobCount = selectedId
    ? props.cron.jobs.filter((j) => j.agentId === selectedId).length
    : null;
  const tabCounts: Record<string, number | null> = {
    files: props.agentFiles.list?.files?.length ?? null,
    skills: props.agentSkills.report?.skills?.length ?? null,
    channels: channelEntryCount,
    cron: cronJobCount || null,
  };

  return html`
    <div class="agents-layout">
      <section class="card agents-sidebar">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="card-title">Agents</div>
            <div class="card-sub">${agents.length} configured.</div>
          </div>
          <button class="btn btn--sm" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? "Loading…" : "Refresh"}
          </button>
        </div>
        ${
          agents.length > 1
            ? html`
                <input
                  class="field"
                  type="text"
                  placeholder="Filter agents…"
                  .value=${props.sidebarFilter}
                  @input=${(e: Event) =>
                    props.onSidebarFilterChange((e.target as HTMLInputElement).value)}
                  style="margin-top: 8px;"
                />
              `
            : nothing
        }
        ${
          props.error
            ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
            : nothing
        }
        <div class="agent-list" style="margin-top: 12px;">
          ${
            filteredAgents.length === 0
              ? html`
                  <div class="muted">${sidebarFilter ? "No matching agents." : "No agents found."}</div>
                `
              : filteredAgents.map((agent) => {
                  const badge = agentBadgeText(agent.id, defaultId);
                  const emoji = resolveAgentEmoji(agent, props.agentIdentityById[agent.id] ?? null);
                  const hue = agentAvatarHue(agent.id);
                  return html`
                    <button
                      type="button"
                      class="agent-row ${selectedId === agent.id ? "active" : ""}"
                      @click=${() => props.onSelectAgent(agent.id)}
                    >
                      <div class="agent-avatar" style="--agent-hue: ${hue}">
                        ${emoji || normalizeAgentLabel(agent).slice(0, 1)}
                      </div>
                      <div class="agent-info">
                        <div class="agent-title">${normalizeAgentLabel(agent)}</div>
                        <div class="agent-sub mono">${agent.id}</div>
                      </div>
                      ${badge ? html`<span class="agent-pill">${badge}</span>` : nothing}
                    </button>
                  `;
                })
          }
        </div>
      </section>
      <section class="agents-main">
        ${
          !selectedAgent
            ? html`
                <div class="card">
                  <div class="card-title">Select an agent</div>
                  <div class="card-sub">Pick an agent to inspect its workspace and tools.</div>
                </div>
              `
            : html`
                ${renderAgentHeader(
                  selectedAgent,
                  defaultId,
                  props.agentIdentityById[selectedAgent.id] ?? null,
                  props.onSetDefault,
                )}
                ${renderAgentTabs(props.activePanel, (panel) => props.onSelectPanel(panel), tabCounts)}
                ${
                  props.activePanel === "overview"
                    ? renderAgentOverview({
                        agent: selectedAgent,
                        defaultId,
                        configForm: props.config.form,
                        agentFilesList: props.agentFiles.list,
                        agentIdentity: props.agentIdentityById[selectedAgent.id] ?? null,
                        agentIdentityError: props.agentIdentityError,
                        agentIdentityLoading: props.agentIdentityLoading,
                        configLoading: props.config.loading,
                        configSaving: props.config.saving,
                        configDirty: props.config.dirty,
                        onConfigReload: props.onConfigReload,
                        onConfigSave: props.onConfigSave,
                        onModelChange: props.onModelChange,
                        onModelFallbacksChange: props.onModelFallbacksChange,
                        onSelectPanel: props.onSelectPanel,
                      })
                    : nothing
                }
                ${
                  props.activePanel === "files"
                    ? renderAgentFiles({
                        agentId: selectedAgent.id,
                        agentFilesList: props.agentFiles.list,
                        agentFilesLoading: props.agentFiles.loading,
                        agentFilesError: props.agentFiles.error,
                        agentFileActive: props.agentFiles.active,
                        agentFileContents: props.agentFiles.contents,
                        agentFileDrafts: props.agentFiles.drafts,
                        agentFileSaving: props.agentFiles.saving,
                        onLoadFiles: props.onLoadFiles,
                        onSelectFile: props.onSelectFile,
                        onFileDraftChange: props.onFileDraftChange,
                        onFileReset: props.onFileReset,
                        onFileSave: props.onFileSave,
                      })
                    : nothing
                }
                ${
                  props.activePanel === "tools"
                    ? renderAgentTools({
                        agentId: selectedAgent.id,
                        configForm: props.config.form,
                        configLoading: props.config.loading,
                        configSaving: props.config.saving,
                        configDirty: props.config.dirty,
                        onProfileChange: props.onToolsProfileChange,
                        onOverridesChange: props.onToolsOverridesChange,
                        onConfigReload: props.onConfigReload,
                        onConfigSave: props.onConfigSave,
                      })
                    : nothing
                }
                ${
                  props.activePanel === "skills"
                    ? renderAgentSkills({
                        agentId: selectedAgent.id,
                        report: props.agentSkills.report,
                        loading: props.agentSkills.loading,
                        error: props.agentSkills.error,
                        activeAgentId: props.agentSkills.agentId,
                        configForm: props.config.form,
                        configLoading: props.config.loading,
                        configSaving: props.config.saving,
                        configDirty: props.config.dirty,
                        filter: props.agentSkills.filter,
                        onFilterChange: props.onSkillsFilterChange,
                        onRefresh: props.onSkillsRefresh,
                        onToggle: props.onAgentSkillToggle,
                        onClear: props.onAgentSkillsClear,
                        onDisableAll: props.onAgentSkillsDisableAll,
                        onConfigReload: props.onConfigReload,
                        onConfigSave: props.onConfigSave,
                      })
                    : nothing
                }
                ${
                  props.activePanel === "channels"
                    ? renderAgentChannels({
                        context: buildAgentContext(
                          selectedAgent,
                          props.config.form,
                          props.agentFiles.list,
                          defaultId,
                          props.agentIdentityById[selectedAgent.id] ?? null,
                        ),
                        configForm: props.config.form,
                        snapshot: props.channels.snapshot,
                        loading: props.channels.loading,
                        error: props.channels.error,
                        lastSuccess: props.channels.lastSuccess,
                        onRefresh: props.onChannelsRefresh,
                      })
                    : nothing
                }
                ${
                  props.activePanel === "cron"
                    ? renderAgentCron({
                        context: buildAgentContext(
                          selectedAgent,
                          props.config.form,
                          props.agentFiles.list,
                          defaultId,
                          props.agentIdentityById[selectedAgent.id] ?? null,
                        ),
                        agentId: selectedAgent.id,
                        jobs: props.cron.jobs,
                        status: props.cron.status,
                        loading: props.cron.loading,
                        error: props.cron.error,
                        onRefresh: props.onCronRefresh,
                        onRunNow: props.onCronRunNow,
                      })
                    : nothing
                }
              `
        }
      </section>
    </div>
  `;
}

let actionsMenuOpen = false;

function renderAgentHeader(
  agent: AgentsListResult["agents"][number],
  defaultId: string | null,
  agentIdentity: AgentIdentityResult | null,
  onSetDefault: (agentId: string) => void,
) {
  const badge = agentBadgeText(agent.id, defaultId);
  const displayName = normalizeAgentLabel(agent);
  const subtitle = agent.identity?.theme?.trim() || "Agent workspace and routing.";
  const emoji = resolveAgentEmoji(agent, agentIdentity);
  const hue = agentAvatarHue(agent.id);
  const isDefault = Boolean(defaultId && agent.id === defaultId);

  const copyId = () => {
    void navigator.clipboard.writeText(agent.id);
    actionsMenuOpen = false;
  };

  return html`
    <section class="card agent-header">
      <div class="agent-header-main">
        <div class="agent-avatar agent-avatar--lg" style="--agent-hue: ${hue}">
          ${emoji || displayName.slice(0, 1)}
        </div>
        <div>
          <div class="card-title">${displayName}</div>
          <div class="card-sub">${subtitle}</div>
        </div>
      </div>
      <div class="agent-header-meta">
        <div class="mono">${agent.id}</div>
        <div class="row" style="gap: 8px; align-items: center;">
          ${badge ? html`<span class="agent-pill">${badge}</span>` : nothing}
          <div class="agent-actions-wrap">
            <button
              class="agent-actions-toggle"
              type="button"
              @click=${() => {
                actionsMenuOpen = !actionsMenuOpen;
              }}
            >⋯</button>
            ${
              actionsMenuOpen
                ? html`
                    <div class="agent-actions-menu">
                      <button type="button" @click=${copyId}>Copy agent ID</button>
                      <button
                        type="button"
                        ?disabled=${isDefault}
                        @click=${() => {
                          onSetDefault(agent.id);
                          actionsMenuOpen = false;
                        }}
                      >
                        ${isDefault ? "Already default" : "Set as default"}
                      </button>
                    </div>
                  `
                : nothing
            }
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderAgentTabs(
  active: AgentsPanel,
  onSelect: (panel: AgentsPanel) => void,
  counts: Record<string, number | null>,
) {
  const tabs: Array<{ id: AgentsPanel; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "files", label: "Files" },
    { id: "tools", label: "Tools" },
    { id: "skills", label: "Skills" },
    { id: "channels", label: "Channels" },
    { id: "cron", label: "Cron Jobs" },
  ];
  return html`
    <div class="agent-tabs">
      ${tabs.map(
        (tab) => html`
          <button
            class="agent-tab ${active === tab.id ? "active" : ""}"
            type="button"
            @click=${() => onSelect(tab.id)}
          >
            ${tab.label}${counts[tab.id] != null ? html`<span class="agent-tab-count">${counts[tab.id]}</span>` : nothing}
          </button>
        `,
      )}
    </div>
  `;
}
