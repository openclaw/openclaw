import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { until } from "lit/directives/until.js";
import "../../styles/agents.css";
import { t } from "../../i18n/index.ts";
import type { KalshiDashboardSnapshot } from "../controllers/kalshi-dashboard.ts";
import type {
  AgentIdentityResult,
  AgentsFilesListResult,
  AgentsListResult,
  AgentsRuntimeStatusResult,
  ChannelsStatusSnapshot,
  CronJob,
  CronStatus,
  ModelCatalogEntry,
  OpsSummaryResult,
  SelfImprovementRecommendationGroup,
  SelfImprovementRecommendation,
  SelfImprovementAuditEvent,
  SelfImprovementAnalysisRunResult,
  SelfImprovementModelPreflightResult,
  SelfImprovementProductionCheckResult,
  SelfImprovementMaintenanceResult,
  SelfImprovementOperationalHealthResult,
  SelfImprovementDailyScorecard,
  SelfImprovementProposal,
  SelfImprovementScanResult,
  SelfImprovementScorecard,
  SkillStatusReport,
  ToolsCatalogResult,
  ToolsEffectiveResult,
} from "../types.ts";
export type { AgentsPanel } from "./agents.types.ts";
import {
  renderAgentRoom,
  renderAgentRoomMemoryFixture,
  type AttentionTarget,
  type AgentRoomSessionsState,
} from "./agents-room.ts";
import { agentBadgeText, buildAgentContext, normalizeAgentLabel } from "./agents-utils.ts";
import type { AgentWorkflowMapsState, AgentsPanel } from "./agents.types.ts";

type AgentOverviewModule = typeof import("./agents-panels-overview.ts");
type AgentStatusFilesModule = typeof import("./agents-panels-status-files.ts");
type AgentSelfImprovementModule = typeof import("./agents-self-improvement.ts");
type AgentToolsSkillsModule = typeof import("./agents-panels-tools-skills.ts");
type AgentWorkflowsModule = typeof import("./agents-workflows.ts");

let agentOverviewModulePromise: Promise<AgentOverviewModule> | null = null;
let agentStatusFilesModulePromise: Promise<AgentStatusFilesModule> | null = null;
let agentSelfImprovementModulePromise: Promise<AgentSelfImprovementModule> | null = null;
let agentToolsSkillsModulePromise: Promise<AgentToolsSkillsModule> | null = null;
let agentWorkflowsModulePromise: Promise<AgentWorkflowsModule> | null = null;
let agentOverviewModule: AgentOverviewModule | null = null;
let agentStatusFilesModule: AgentStatusFilesModule | null = null;
let agentSelfImprovementModule: AgentSelfImprovementModule | null = null;
let agentToolsSkillsModule: AgentToolsSkillsModule | null = null;
let agentWorkflowsModule: AgentWorkflowsModule | null = null;

function loadAgentOverviewModule() {
  return (agentOverviewModulePromise ??= import("./agents-panels-overview.ts").then((module) => {
    agentOverviewModule = module;
    return module;
  }));
}

function loadAgentStatusFilesModule() {
  return (agentStatusFilesModulePromise ??= import("./agents-panels-status-files.ts").then(
    (module) => {
      agentStatusFilesModule = module;
      return module;
    },
  ));
}

function loadAgentSelfImprovementModule() {
  return (agentSelfImprovementModulePromise ??= import("./agents-self-improvement.ts").then(
    (module) => {
      agentSelfImprovementModule = module;
      return module;
    },
  ));
}

function loadAgentToolsSkillsModule() {
  return (agentToolsSkillsModulePromise ??= import("./agents-panels-tools-skills.ts").then(
    (module) => {
      agentToolsSkillsModule = module;
      return module;
    },
  ));
}

function loadAgentWorkflowsModule() {
  return (agentWorkflowsModulePromise ??= import("./agents-workflows.ts").then((module) => {
    agentWorkflowsModule = module;
    return module;
  }));
}

function renderAgentPanelLoading(label: string) {
  return html`
    <section class="card agent-panel-loading" aria-busy="true">
      <div class="card-title">${label}</div>
      <div class="card-sub">${t("common.loading")}</div>
    </section>
  `;
}

function renderLazyAgentPanel<TModule>(
  module: TModule | null,
  load: () => Promise<TModule>,
  render: (module: TModule) => unknown,
  loadingLabel: string,
) {
  return module
    ? render(module)
    : until(
        load().then((loaded) => render(loaded)),
        renderAgentPanelLoading(loadingLabel),
      );
}

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

export type ToolsCatalogState = {
  loading: boolean;
  error: string | null;
  result: ToolsCatalogResult | null;
};

export type ToolsEffectiveState = {
  loading: boolean;
  error: string | null;
  result: ToolsEffectiveResult | null;
};

export type AgentRuntimeStatusState = {
  loading: boolean;
  error: string | null;
  result: AgentsRuntimeStatusResult | null;
};

export type OpsSummaryState = {
  loading: boolean;
  error: string | null;
  result: OpsSummaryResult | null;
};

export type SelfImprovementState = {
  loading: boolean;
  error: string | null;
  recommendations: SelfImprovementRecommendation[];
  groups: SelfImprovementRecommendationGroup[];
  scorecard: SelfImprovementScorecard | null;
  scorecards: SelfImprovementDailyScorecard[];
  health: SelfImprovementOperationalHealthResult | null;
  proposals: SelfImprovementProposal[];
  auditEvents: SelfImprovementAuditEvent[];
  total: number;
  scanLoading: boolean;
  lastScan: SelfImprovementScanResult["scan"] | null;
  analysisLoading: boolean;
  lastAnalysis: SelfImprovementAnalysisRunResult | null;
  modelPreflightLoading: boolean;
  lastModelPreflight: SelfImprovementModelPreflightResult | null;
  productionCheckLoading: boolean;
  lastProductionCheck: SelfImprovementProductionCheckResult | null;
  maintenanceLoading: boolean;
  lastMaintenance: SelfImprovementMaintenanceResult | null;
};

export type AgentsProps = {
  basePath: string;
  loading: boolean;
  error: string | null;
  connected: boolean;
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
  toolsCatalog: ToolsCatalogState;
  toolsEffective: ToolsEffectiveState;
  sessions: AgentRoomSessionsState;
  runtimeStatus: AgentRuntimeStatusState;
  opsSummary: OpsSummaryState;
  selfImprovement: SelfImprovementState;
  runtimeSessionKey: string;
  runtimeSessionMatchesSelectedAgent: boolean;
  workflowMaps: AgentWorkflowMapsState;
  kalshiDashboard?: KalshiDashboardSnapshot | null;
  kalshiDashboardLoading?: boolean;
  kalshiDashboardError?: string | null;
  modelCatalog: ModelCatalogEntry[];
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
  onSelfImprovementRefresh: () => void;
  onSelfImprovementScan: () => void;
  onSelfImprovementAnalysis: () => void;
  onSelfImprovementModelPreflight: () => void;
  onSelfImprovementProductionCheck: () => void;
  onSelfImprovementMaintenanceDryRun: () => void;
  onSelfImprovementRecommendationUpdate: (input: {
    id: string;
    status: string;
    note?: string;
    assignedTargetAgentId?: string;
    claimedBy?: string;
    resolutionProof?: string;
    dismissalReason?: string;
  }) => void;
  onSelfImprovementGroupUpdate: (input: {
    id: string;
    status: string;
    note?: string;
    assignedTargetAgentId?: string;
    claimedBy?: string;
    resolutionProof?: string;
    dismissalReason?: string;
  }) => void;
  onSelfImprovementCuratorUpdate: (input: {
    id: string;
    curatorStatus: string;
    proof?: string;
    reason?: string;
    workshopProposalId?: string;
    workshopProposalStatus?: string;
    note?: string;
  }) => void;
  onSkillsFilterChange: (next: string) => void;
  onSkillsRefresh: () => void;
  onAgentSkillToggle: (agentId: string, skillName: string, enabled: boolean) => void;
  onAgentSkillsClear: (agentId: string) => void;
  onAgentSkillsDisableAll: (agentId: string) => void;
  onSetDefault: (agentId: string) => void;
  onAssignAgentRoom: (agentId: string, roomId: string) => void;
  onWorkflowRoomSelect: (roomId: string) => void;
  onWorkflowStepSelect: (stepId: string) => void;
  onWorkflowOrderChange: (roomId: string, order: string[]) => void;
  onWorkflowResetRoom: (roomId: string) => void;
  onAttentionAction?: (target: AttentionTarget) => void;
};

export function renderAgents(props: AgentsProps) {
  const agents = props.agentsList?.agents ?? [];
  const defaultId = props.agentsList?.defaultId ?? null;
  const selectedId = props.selectedAgentId ?? defaultId ?? agents[0]?.id ?? null;
  const selectedAgent = selectedId
    ? (agents.find((agent) => agent.id === selectedId) ?? null)
    : null;
  const selectedSkillCount =
    selectedId && props.agentSkills.agentId === selectedId
      ? (props.agentSkills.report?.skills?.length ?? null)
      : null;

  const channelEntryCount = props.channels.snapshot
    ? Object.keys(props.channels.snapshot.channelAccounts ?? {}).length
    : null;
  const cronJobCount = selectedId
    ? props.cron.jobs.filter((j) => j.agentId === selectedId).length
    : null;
  const tabCounts: Record<string, number | null> = {
    files: props.agentFiles.list?.files?.length ?? null,
    skills: selectedSkillCount,
    channels: channelEntryCount,
    cron: cronJobCount || null,
    "self-improvement": props.selfImprovement.total > 0 ? props.selfImprovement.total : null,
  };

  return html`
    <div class="agents-layout">
      <section class="agents-toolbar">
        <div class="agents-toolbar-row">
          <div class="agents-control-select">
            <select
              class="agents-select"
              .value=${selectedId ?? ""}
              ?disabled=${props.loading || agents.length === 0}
              @change=${(e: Event) => props.onSelectAgent((e.target as HTMLSelectElement).value)}
            >
              ${agents.length === 0
                ? html` <option value="">${t("agents.noAgents")}</option> `
                : agents.map(
                    (agent) => html`
                      <option value=${agent.id} ?selected=${agent.id === selectedId}>
                        ${normalizeAgentLabel(agent)}${agentBadgeText(agent.id, defaultId)
                          ? ` (${agentBadgeText(agent.id, defaultId)})`
                          : ""}
                      </option>
                    `,
                  )}
            </select>
          </div>
          <div class="agents-toolbar-actions">
            ${selectedAgent
              ? html`
                  <button
                    type="button"
                    class="btn btn--sm btn--ghost"
                    @click=${() => void navigator.clipboard.writeText(selectedAgent.id)}
                    title=${t("agents.copyIdTitle")}
                  >
                    ${t("agents.copyId")}
                  </button>
                  <button
                    type="button"
                    class="btn btn--sm btn--ghost"
                    ?disabled=${Boolean(defaultId && selectedAgent.id === defaultId)}
                    @click=${() => props.onSetDefault(selectedAgent.id)}
                    title=${defaultId && selectedAgent.id === defaultId
                      ? t("agents.alreadyDefaultTitle")
                      : t("agents.setDefaultTitle")}
                  >
                    ${defaultId && selectedAgent.id === defaultId
                      ? t("agents.default")
                      : t("agents.setDefault")}
                  </button>
                `
              : nothing}
            <button
              class="btn btn--sm agents-refresh-btn"
              ?disabled=${props.loading}
              @click=${props.onRefresh}
            >
              ${props.loading ? t("common.loading") : t("common.refresh")}
            </button>
          </div>
        </div>
        ${props.error
          ? html`<div class="callout danger" style="margin-top: 8px;">${props.error}</div>`
          : nothing}
      </section>
      <section class="agents-main">
        ${!selectedAgent
          ? html`
              <div class="card">
                <div class="card-title">${t("agents.selectTitle")}</div>
                <div class="card-sub">${t("agents.selectSubtitle")}</div>
              </div>
            `
          : html`
              ${renderAgentTabs(
                props.activePanel,
                (panel) => props.onSelectPanel(panel),
                tabCounts,
              )}
              <!-- Keep the RAM monitor as a permanent Agents dashboard fixture.
              It should only be removed when the operator explicitly asks for that removal. -->
              ${renderAgentRoomMemoryFixture({
                agents,
                defaultId,
                selectedAgentId: selectedAgent.id,
                sessions: props.sessions,
                runtimeStatus: props.runtimeStatus,
                kalshiDashboard: props.kalshiDashboard,
                connected: props.connected,
              })}
              ${props.activePanel === "room"
                ? renderAgentRoom({
                    agents,
                    defaultId,
                    selectedAgentId: selectedAgent.id,
                    sessions: props.sessions,
                    runtimeStatus: props.runtimeStatus,
                    opsSummary: props.opsSummary,
                    cron: props.cron,
                    channels: props.channels,
                    kalshiDashboard: props.kalshiDashboard,
                    kalshiDashboardLoading: props.kalshiDashboardLoading,
                    kalshiDashboardError: props.kalshiDashboardError,
                    connected: props.connected,
                    onSelectAgent: props.onSelectAgent,
                    onRefresh: props.onRefresh,
                    onOpenAgent: () => props.onSelectPanel("overview"),
                    onAssignAgentRoom: props.onAssignAgentRoom,
                    onInspectAttention: (target) => {
                      if (target.kind === "agent") {
                        props.onSelectAgent(target.agentId);
                        return;
                      }
                      if (target.kind === "agentsPanel") {
                        props.onSelectPanel(target.panel);
                        return;
                      }
                      if (target.kind === "cronRun") {
                        const confirmed =
                          typeof globalThis.confirm === "function"
                            ? globalThis.confirm(
                                `Run this scheduled job once now?\n\n${target.jobId}`,
                              )
                            : true;
                        if (!confirmed) {
                          return;
                        }
                        props.onCronRunNow(target.jobId);
                        props.onSelectPanel("cron");
                        return;
                      }
                      props.onAttentionAction?.(target);
                    },
                  })
                : nothing}
              ${props.activePanel === "workflows"
                ? renderLazyAgentPanel(
                    agentWorkflowsModule,
                    loadAgentWorkflowsModule,
                    (module) =>
                      module.renderAgentWorkflows({
                        agents,
                        workflowMaps: props.workflowMaps,
                        sessions: props.sessions,
                        runtimeStatus: props.runtimeStatus,
                        cron: props.cron,
                        kalshiDashboard: props.kalshiDashboard,
                        onSelectRoom: props.onWorkflowRoomSelect,
                        onSelectStep: props.onWorkflowStepSelect,
                        onOrderChange: props.onWorkflowOrderChange,
                        onResetRoom: props.onWorkflowResetRoom,
                      }),
                    "Loading Agent Workflow Maps",
                  )
                : nothing}
              ${props.activePanel === "overview"
                ? renderLazyAgentPanel(
                    agentOverviewModule,
                    loadAgentOverviewModule,
                    (module) =>
                      keyed(
                        selectedAgent.id,
                        module.renderAgentOverview({
                          agent: selectedAgent,
                          basePath: props.basePath,
                          defaultId,
                          configForm: props.config.form,
                          agentFilesList: props.agentFiles.list,
                          agentIdentity: props.agentIdentityById[selectedAgent.id] ?? null,
                          agentIdentityError: props.agentIdentityError,
                          agentIdentityLoading: props.agentIdentityLoading,
                          configLoading: props.config.loading,
                          configSaving: props.config.saving,
                          configDirty: props.config.dirty,
                          modelCatalog: props.modelCatalog,
                          onConfigReload: props.onConfigReload,
                          onConfigSave: props.onConfigSave,
                          onModelChange: props.onModelChange,
                          onModelFallbacksChange: props.onModelFallbacksChange,
                          onSelectPanel: props.onSelectPanel,
                        }),
                      ),
                    "Loading Agent Overview",
                  )
                : nothing}
              ${props.activePanel === "files"
                ? renderLazyAgentPanel(
                    agentStatusFilesModule,
                    loadAgentStatusFilesModule,
                    (module) =>
                      module.renderAgentFiles({
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
                      }),
                    "Loading Agent Files",
                  )
                : nothing}
              ${props.activePanel === "tools"
                ? renderLazyAgentPanel(
                    agentToolsSkillsModule,
                    loadAgentToolsSkillsModule,
                    (module) =>
                      module.renderAgentTools({
                        agentId: selectedAgent.id,
                        configForm: props.config.form,
                        configLoading: props.config.loading,
                        configSaving: props.config.saving,
                        configDirty: props.config.dirty,
                        toolsCatalogLoading: props.toolsCatalog.loading,
                        toolsCatalogError: props.toolsCatalog.error,
                        toolsCatalogResult: props.toolsCatalog.result,
                        toolsEffectiveLoading: props.toolsEffective.loading,
                        toolsEffectiveError: props.toolsEffective.error,
                        toolsEffectiveResult: props.toolsEffective.result,
                        runtimeSessionKey: props.runtimeSessionKey,
                        runtimeSessionMatchesSelectedAgent:
                          props.runtimeSessionMatchesSelectedAgent,
                        onProfileChange: props.onToolsProfileChange,
                        onOverridesChange: props.onToolsOverridesChange,
                        onConfigReload: props.onConfigReload,
                        onConfigSave: props.onConfigSave,
                      }),
                    "Loading Agent Tools",
                  )
                : nothing}
              ${props.activePanel === "skills"
                ? renderLazyAgentPanel(
                    agentToolsSkillsModule,
                    loadAgentToolsSkillsModule,
                    (module) =>
                      module.renderAgentSkills({
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
                      }),
                    "Loading Agent Skills",
                  )
                : nothing}
              ${props.activePanel === "channels"
                ? renderLazyAgentPanel(
                    agentStatusFilesModule,
                    loadAgentStatusFilesModule,
                    (module) =>
                      module.renderAgentChannels({
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
                        onSelectPanel: props.onSelectPanel,
                      }),
                    "Loading Agent Channels",
                  )
                : nothing}
              ${props.activePanel === "cron"
                ? renderLazyAgentPanel(
                    agentStatusFilesModule,
                    loadAgentStatusFilesModule,
                    (module) =>
                      module.renderAgentCron({
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
                        onSelectPanel: props.onSelectPanel,
                      }),
                    "Loading Agent Cron Jobs",
                  )
                : nothing}
              ${props.activePanel === "self-improvement"
                ? renderLazyAgentPanel(
                    agentSelfImprovementModule,
                    loadAgentSelfImprovementModule,
                    (module) =>
                      module.renderSelfImprovementPanel({
                        loading: props.selfImprovement.loading,
                        error: props.selfImprovement.error,
                        recommendations: props.selfImprovement.recommendations,
                        groups: props.selfImprovement.groups,
                        scorecard: props.selfImprovement.scorecard,
                        scorecards: props.selfImprovement.scorecards,
                        health: props.selfImprovement.health,
                        proposals: props.selfImprovement.proposals,
                        auditEvents: props.selfImprovement.auditEvents,
                        total: props.selfImprovement.total,
                        scanLoading: props.selfImprovement.scanLoading,
                        lastScan: props.selfImprovement.lastScan,
                        analysisLoading: props.selfImprovement.analysisLoading,
                        lastAnalysis: props.selfImprovement.lastAnalysis,
                        modelPreflightLoading: props.selfImprovement.modelPreflightLoading,
                        lastModelPreflight: props.selfImprovement.lastModelPreflight,
                        productionCheckLoading: props.selfImprovement.productionCheckLoading,
                        lastProductionCheck: props.selfImprovement.lastProductionCheck,
                        maintenanceLoading: props.selfImprovement.maintenanceLoading,
                        lastMaintenance: props.selfImprovement.lastMaintenance,
                        onRefresh: props.onSelfImprovementRefresh,
                        onScan: props.onSelfImprovementScan,
                        onAnalyze: props.onSelfImprovementAnalysis,
                        onModelPreflight: props.onSelfImprovementModelPreflight,
                        onProductionCheck: props.onSelfImprovementProductionCheck,
                        onMaintenanceDryRun: props.onSelfImprovementMaintenanceDryRun,
                        onRecommendationUpdate: props.onSelfImprovementRecommendationUpdate,
                        onGroupUpdate: props.onSelfImprovementGroupUpdate,
                        onCuratorUpdate: props.onSelfImprovementCuratorUpdate,
                      }),
                    "Loading Self-Improvement Recommendations",
                  )
                : nothing}
            `}
      </section>
    </div>
  `;
}

function renderAgentTabs(
  active: AgentsPanel,
  onSelect: (panel: AgentsPanel) => void,
  counts: Record<string, number | null>,
) {
  const tabs: Array<{ id: AgentsPanel; label: string }> = [
    { id: "room", label: "Live Agent Workspace" },
    { id: "workflows", label: "Agent Workflow Maps" },
    { id: "overview", label: "Overview" },
    { id: "files", label: "Files" },
    { id: "tools", label: "Tools" },
    { id: "skills", label: "Skills" },
    { id: "channels", label: "Channels" },
    { id: "cron", label: "Cron Jobs" },
    { id: "self-improvement", label: "Self-Improvement" },
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
            ${tab.label}${counts[tab.id] != null
              ? html`<span class="agent-tab-count">${counts[tab.id]}</span>`
              : nothing}
          </button>
        `,
      )}
    </div>
  `;
}
