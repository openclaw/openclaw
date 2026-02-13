import { html, nothing, type TemplateResult } from "lit";
import type {
  AgentHQAgentInfo,
  AgentHQHistoryResult,
  AgentHQStatsResult,
  AgentHQDiffResult,
  AgentHQSummary,
  AgentHQViewMode,
} from "../types.ts";
import { renderIcon } from "../icons.ts";
import { renderAgentHQDiff } from "./agenthq-diff.ts";
import { renderAgentHQHeatmap } from "./agenthq-heatmap.ts";
import { renderAgentHQSummary } from "./agenthq-summary.ts";
import { renderAgentHQTimeline } from "./agenthq-timeline.ts";
import { renderAgentHQVisual } from "./agenthq-visual.ts";

export type AgentHQProps = {
  loading: boolean;
  historyLoading: boolean;
  statsLoading: boolean;
  diffLoading: boolean;
  summaryLoading: boolean;
  error: string | null;
  agents: AgentHQAgentInfo[];
  selectedAgentId: string | null;
  history: AgentHQHistoryResult | null;
  stats: AgentHQStatsResult | null;
  diff: AgentHQDiffResult | null;
  summaries: Map<string, AgentHQSummary>;
  viewMode: AgentHQViewMode;
  selectedCommit: string | null;
  selectedFile: string | null;
  fileFilter: string[];
  expandedCommits: Set<string>;
  summaryEnabled: boolean;
  summaryModel: string | null;
  summaryProvider: string | null;
  availableModels: Array<{ id: string; name: string; provider: string }>;
  onRefresh: () => void;
  onSelectAgent: (agentId: string) => void;
  onSetViewMode: (mode: AgentHQViewMode) => void;
  onSelectCommit: (sha: string, fileName: string) => void;
  onToggleCommit: (sha: string) => void;
  onSetFileFilter: (files: string[]) => void;
  onToggleSummary: (enabled: boolean) => void;
  onSetSummaryModel: (model: string | null, provider: string | null) => void;
  onGenerateSummary: (sha: string) => void;
};

const WORKSPACE_FILES = [
  "IDENTITY.md",
  "MEMORY.md",
  "SOUL.md",
  "HEARTBEAT.md",
  "USER.md",
  "AGENTS.md",
  "TOOLS.md",
  "BOOTSTRAP.md",
];

const VIEW_MODES: Array<{ id: AgentHQViewMode; label: string; icon: string }> = [
  { id: "visual", label: "Visual", icon: "eye" },
  { id: "timeline", label: "Timeline", icon: "history" },
  { id: "heatmap", label: "Activity", icon: "calendar" },
  { id: "diff", label: "Diff", icon: "diff" },
];

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 30) {
    return new Date(timestamp).toLocaleDateString();
  }
  if (days > 0) {
    return `${days}d ago`;
  }
  if (hours > 0) {
    return `${hours}h ago`;
  }
  if (minutes > 0) {
    return `${minutes}m ago`;
  }
  return "just now";
}

export function renderAgentHQ(props: AgentHQProps): TemplateResult {
  const selectedAgent = props.agents.find((a) => a.agentId === props.selectedAgentId);

  return html`
    <div class="agenthq-layout">
      ${renderSidebar(props, selectedAgent)}
      <div class="agenthq-main">
        ${renderHeader(props)}
        ${
          props.loading
            ? renderLoading("Loading agents...")
            : props.error
              ? renderError(props.error)
              : !selectedAgent
                ? renderEmpty()
                : !selectedAgent.isGitRepo
                  ? renderNoGit()
                  : renderContent(props)
        }
      </div>
    </div>
  `;
}

function renderSidebar(
  props: AgentHQProps,
  selectedAgent: AgentHQAgentInfo | undefined,
): TemplateResult {
  return html`
    <div class="agenthq-sidebar">
      <div class="agenthq-filters">
        <div class="agenthq-filter-label">Agents</div>
        <div class="agenthq-agent-list">
          ${props.agents.map((agent) => renderAgentItem(agent, props))}
        </div>
      </div>

      ${
        selectedAgent?.isGitRepo
          ? html`
            <div class="agenthq-filters">
              <div class="agenthq-filter-label">Filter by File</div>
              <div class="agenthq-filter-chips">
                ${WORKSPACE_FILES.map((file) => {
                  const isActive = props.fileFilter.includes(file);
                  return html`
                    <div
                      class="agenthq-filter-chip ${isActive ? "active" : ""}"
                      @click=${() => {
                        const newFilter = isActive
                          ? props.fileFilter.filter((f) => f !== file)
                          : [...props.fileFilter, file];
                        props.onSetFileFilter(newFilter);
                      }}
                    >
                      ${file.replace(".md", "")}
                    </div>
                  `;
                })}
              </div>
            </div>

            ${renderAgentHQSummary({
              enabled: props.summaryEnabled,
              loading: props.summaryLoading,
              model: props.summaryModel,
              provider: props.summaryProvider,
              availableModels: props.availableModels,
              onToggle: props.onToggleSummary,
              onSetModel: props.onSetSummaryModel,
            })}
          `
          : nothing
      }
    </div>
  `;
}

function renderAgentItem(agent: AgentHQAgentInfo, props: AgentHQProps): TemplateResult {
  const isSelected = agent.agentId === props.selectedAgentId;
  const initial = agent.agentId.charAt(0).toUpperCase();
  const lastChange = agent.lastChangeAt ? formatRelativeTime(agent.lastChangeAt) : "No changes";

  return html`
    <div
      class="agenthq-agent-item ${isSelected ? "selected" : ""}"
      @click=${() => props.onSelectAgent(agent.agentId)}
    >
      <div class="agenthq-agent-avatar">${initial}</div>
      <div class="agenthq-agent-info">
        <div class="agenthq-agent-name">${agent.agentId}</div>
        <div class="agenthq-agent-meta">${lastChange} • ${agent.totalCommits} commits</div>
      </div>
      ${
        agent.isGitRepo
          ? html`
              <div class="agenthq-agent-badge">Git</div>
            `
          : html`
              <div class="agenthq-agent-badge inactive">No Git</div>
            `
      }
    </div>
  `;
}

function renderHeader(props: AgentHQProps): TemplateResult {
  return html`
    <div class="agenthq-tabs">
      ${VIEW_MODES.map(
        (mode) => html`
          <div
            class="agenthq-tab ${props.viewMode === mode.id ? "active" : ""}"
            @click=${() => props.onSetViewMode(mode.id)}
          >
            ${renderIcon(mode.icon as Parameters<typeof renderIcon>[0], "agenthq-tab-icon")} ${mode.label}
          </div>
        `,
      )}
    </div>
  `;
}

function renderContent(props: AgentHQProps): TemplateResult {
  if (props.historyLoading && !props.history) {
    return renderLoading("Loading history...");
  }

  switch (props.viewMode) {
    case "visual":
      return renderAgentHQVisual({
        history: props.history,
        summaries: props.summaries,
        summaryEnabled: props.summaryEnabled,
        onSelectCommit: props.onSelectCommit,
        onGenerateSummary: props.onGenerateSummary,
      });
    case "timeline":
      return renderAgentHQTimeline({
        history: props.history,
        expandedCommits: props.expandedCommits,
        summaries: props.summaries,
        summaryEnabled: props.summaryEnabled,
        onToggleCommit: props.onToggleCommit,
        onSelectFile: props.onSelectCommit,
        onGenerateSummary: props.onGenerateSummary,
      });
    case "heatmap":
      return renderAgentHQHeatmap({
        stats: props.stats,
        loading: props.statsLoading,
      });
    case "diff":
      return renderAgentHQDiff({
        diff: props.diff,
        loading: props.diffLoading,
        history: props.history,
        selectedCommit: props.selectedCommit,
        selectedFile: props.selectedFile,
        onSelectCommit: props.onSelectCommit,
      });
    default:
      return html`
        <div>Unknown view mode</div>
      `;
  }
}

function renderLoading(message: string): TemplateResult {
  return html`
    <div class="agenthq-loading">
      <div class="agenthq-loading-spinner"></div>
      <div class="agenthq-loading-text">${message}</div>
    </div>
  `;
}

function renderError(error: string): TemplateResult {
  return html`
    <div class="agenthq-empty">
      <div class="agenthq-empty-title">Error</div>
      <div class="agenthq-empty-desc">${error}</div>
    </div>
  `;
}

function renderEmpty(): TemplateResult {
  return html`
    <div class="agenthq-empty">
      ${renderIcon("folder", "agenthq-empty-icon")}
      <div class="agenthq-empty-title">Select an Agent</div>
      <div class="agenthq-empty-desc">
        Choose an agent from the sidebar to view its evolution history.
      </div>
    </div>
  `;
}

function renderNoGit(): TemplateResult {
  return html`
    <div class="agenthq-no-git">
      ${renderIcon("gitBranch", "agenthq-no-git-icon")}
      <div class="agenthq-no-git-title">No Git Repository</div>
      <div class="agenthq-no-git-desc">
        This workspace is not tracked by Git. To track agent evolution, initialize a Git repository
        in the workspace directory and commit changes to the workspace files.
      </div>
    </div>
  `;
}
