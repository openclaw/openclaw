import { html, nothing } from "lit";

import { skeleton } from "../components/design-utils";
import { clampText, formatAgo, formatDurationMs, formatList } from "../format";
import { icon, type IconName } from "../icons";
import type {
  AgentsListResult,
  ChannelsStatusSnapshot,
  CronJob,
  CronRunLogEntry,
  PresenceEntry,
  SessionsListResult,
  SkillStatusReport,
} from "../types";
import type { GraphDragState, GraphViewport } from "../ui-types";
import type {
  OverseerGoalStatusResult,
  OverseerStatusResult,
} from "../types/overseer";
import type { SimulatorState } from "../types/overseer-simulator";
import {
  buildOverseerGraphLayout,
  buildSystemGraphLayout,
  fitGraphViewport,
  zoomGraphViewport,
  type GraphLayout,
  type GraphNode,
} from "./overseer.graph";
import { renderSimulator, type SimulatorProps } from "./overseer-simulator";

export type OverseerProps = {
  loading: boolean;
  error: string | null;
  status: OverseerStatusResult | null;
  goalLoading: boolean;
  goalError: string | null;
  goal: OverseerGoalStatusResult | null;
  selectedGoalId: string | null;
  showOverseerGraph: boolean;
  showSystemGraph: boolean;
  overseerViewport: GraphViewport;
  overseerDrag: GraphDragState | null;
  systemViewport: GraphViewport;
  systemDrag: GraphDragState | null;
  selectedOverseerNodeId: string | null;
  selectedSystemNodeId: string | null;
  drawerOpen: boolean;
  drawerKind:
    | "cron"
    | "session"
    | "skill"
    | "channel"
    | "node"
    | "instance"
    | null;
  drawerNodeId: string | null;
  nodes: Array<Record<string, unknown>>;
  presenceEntries: PresenceEntry[];
  cronJobs: CronJob[];
  cronRunsJobId: string | null;
  cronRuns: CronRunLogEntry[];
  skillsReport: SkillStatusReport | null;
  agents: AgentsListResult | null;
  sessions: SessionsListResult | null;
  channels: ChannelsStatusSnapshot | null;
  // Goal management state
  goalActionPending?: boolean;
  goalActionError?: string | null;
  createGoalOpen?: boolean;
  createGoalForm?: {
    title: string;
    problemStatement: string;
    successCriteria: string[];
    constraints: string[];
    priority: "low" | "normal" | "high" | "urgent";
    generatePlan: boolean;
  };
  // Activity feed enhancements
  activityFilterStatus?: string | null;
  activityLimit?: number;
  connected: boolean;
  // Simulator state
  simulatorState: SimulatorState;
  simulatorProps: Omit<SimulatorProps, "state" | "overseerStatus" | "connected">;
  // Goal management state
  goalActionPending?: boolean;
  goalActionError?: string | null;
  createGoalOpen?: boolean;
  createGoalForm?: {
    title: string;
    problemStatement: string;
    successCriteria: string[];
    constraints: string[];
    priority: "low" | "normal" | "high" | "urgent";
    generatePlan: boolean;
  };
  // Activity feed enhancements
  activityFilterStatus?: string | null;
  activityLimit?: number;
  // Event handlers
  onRefresh: () => void;
  onTick: () => void;
  onSelectGoal: (goalId: string | null) => void;
  onToggleOverseerGraph: (next: boolean) => void;
  onToggleSystemGraph: (next: boolean) => void;
  onSelectOverseerNode: (nodeId: string | null) => void;
  onSelectSystemNode: (nodeId: string | null) => void;
  onViewportChange: (kind: "overseer" | "system", next: GraphViewport) => void;
  onDragChange: (kind: "overseer" | "system", next: GraphDragState | null) => void;
  onDrawerClose: () => void;
  onLoadCronRuns: (jobId: string) => void;
  // Goal management handlers
  onPauseGoal?: (goalId: string) => void;
  onResumeGoal?: (goalId: string) => void;
  onOpenCreateGoal?: () => void;
  onCloseCreateGoal?: () => void;
  onCreateGoal?: (params: {
    title: string;
    problemStatement: string;
    successCriteria: string[];
    constraints: string[];
    priority: "low" | "normal" | "high" | "urgent";
    generatePlan: boolean;
  }) => void;
  onUpdateCreateGoalForm?: (updates: Partial<OverseerProps["createGoalForm"]>) => void;
  // Work node management handlers
  onMarkWorkDone?: (goalId: string, workNodeId: string, summary?: string) => void;
  onBlockWork?: (goalId: string, workNodeId: string, reason: string) => void;
  onRetryAssignment?: (goalId: string, workNodeId: string) => void;
  // Activity feed handlers
  onActivityFilterChange?: (status: string | null) => void;
  onActivityLimitChange?: (limit: number) => void;
  onActivityEventClick?: (event: ActivityEvent) => void;
};

export function setupOverseerKeyboardShortcuts(props: {
  getDrawerOpen: () => boolean;
  onCloseDrawer: () => void;
}): () => void {
  const handler = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (!props.getDrawerOpen()) return;

    event.preventDefault();
    props.onCloseDrawer();

    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")
    ) {
      target.blur();
    }
  };

  document.addEventListener("keydown", handler);
  return () => document.removeEventListener("keydown", handler);
}

export function renderOverseer(props: OverseerProps) {
  // Show skeleton on initial load (no data yet)
  if (props.loading && !props.status) {
    return renderOverseerSkeleton();
  }

  const overseerLayout = buildOverseerGraphLayout(props.goal?.goal);
  const systemLayout = buildSystemGraphLayout({
    nodes: props.nodes,
    presenceEntries: props.presenceEntries,
    cronJobs: props.cronJobs,
    skillsReport: props.skillsReport,
    agents: props.agents,
    sessions: props.sessions,
    channels: props.channels,
  });
  const statusGoals = props.status?.goals ?? [];
  const stalledAssignments = props.status?.stalledAssignments ?? [];
  const activityEvents = buildActivityEvents(props);

  // Build simulator props
  const simulatorFullProps: SimulatorProps = {
    state: props.simulatorState,
    overseerStatus: props.status,
    connected: props.connected,
    ...props.simulatorProps,
  };

  return html`
    <div class="overseer-view">
      ${renderHeader(props, statusGoals.length, stalledAssignments.length)}
      ${renderStatsCards(props, statusGoals, stalledAssignments)}
      ${renderControls(props, statusGoals)}
      ${props.error
        ? html`<div class="overseer-notice overseer-notice--error">${props.error}</div>`
        : nothing}
      ${props.goalActionError
        ? html`<div class="overseer-notice overseer-notice--error">${props.goalActionError}</div>`
        : nothing}
      ${stalledAssignments.length > 0
        ? renderStalledPanel(stalledAssignments, props)
        : nothing}
      <div class="overseer-main-grid" style="display: grid; grid-template-columns: 1fr 380px; gap: 20px;">
        <div class="overseer-main-content">
          ${props.showOverseerGraph
            ? renderGraphPanel({
                title: "Overseer Plan",
                description: props.goal?.goal?.title ?? "Select a goal to view its plan.",
                loading: props.loading || props.goalLoading,
                layout: overseerLayout,
                viewport: props.overseerViewport,
                drag: props.overseerDrag,
                selectedId: props.selectedOverseerNodeId,
                onSelect: props.onSelectOverseerNode,
                onViewportChange: (next) => props.onViewportChange("overseer", next),
                onDragChange: (next) => props.onDragChange("overseer", next),
                details: renderOverseerDetails(props, overseerLayout),
              })
            : nothing}
          ${props.showSystemGraph
            ? renderGraphPanel({
                title: "System View",
                description: "Gateway, nodes, agents, sessions, and channels.",
                loading: props.loading,
                layout: systemLayout,
                viewport: props.systemViewport,
                drag: props.systemDrag,
                selectedId: props.selectedSystemNodeId,
                onSelect: props.onSelectSystemNode,
                onViewportChange: (next) => props.onViewportChange("system", next),
                onDragChange: (next) => props.onDragChange("system", next),
                details: renderSystemDetails(props, systemLayout),
              })
            : nothing}
        </div>
        ${renderActivityFeed(activityEvents, props)}
      </div>
      ${props.drawerOpen ? renderDrawer(props) : nothing}
      ${props.createGoalOpen ? renderCreateGoalModal(props) : nothing}
      ${renderSimulator(simulatorFullProps)}
      ${props.createGoalOpen ? renderCreateGoalModal(props) : nothing}
    </div>
  `;
}

function renderOverseerSkeleton() {
  return html`
    <div class="overseer-view">
      <!-- Header skeleton -->
      <div class="overseer-header">
        <div class="overseer-header__info" style="display:flex;align-items:center;gap:12px;">
          ${skeleton({ width: "24px", height: "24px", rounded: true })}
          <div style="display:flex;flex-direction:column;gap:6px;">
            ${skeleton({ width: "120px", height: "24px" })}
            ${skeleton({ width: "360px", height: "14px" })}
          </div>
        </div>
        <div style="display:flex;gap:8px;">
          ${skeleton({ width: "80px", height: "28px" })}
          ${skeleton({ width: "80px", height: "28px" })}
        </div>
      </div>

      <!-- Stats cards skeleton -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:20px 0;">
        ${Array.from({ length: 4 }, () => html`
          <div style="padding:16px;border-radius:12px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
              ${skeleton({ width: "100px", height: "14px" })}
              ${skeleton({ width: "20px", height: "20px", rounded: true })}
            </div>
            ${skeleton({ width: "48px", height: "28px" })}
          </div>
        `)}
      </div>

      <!-- Controls skeleton -->
      <div style="display:flex;gap:8px;margin-bottom:20px;">
        ${skeleton({ width: "140px", height: "36px" })}
        ${skeleton({ width: "100px", height: "36px" })}
        ${skeleton({ width: "100px", height: "36px" })}
      </div>

      <!-- Main grid skeleton -->
      <div style="display:grid;grid-template-columns:1fr 380px;gap:20px;">
        <div style="display:flex;flex-direction:column;gap:16px;">
          ${skeleton({ width: "100%", height: "400px" })}
        </div>
        <div style="display:flex;flex-direction:column;gap:12px;">
          ${skeleton({ width: "140px", height: "20px" })}
          ${Array.from({ length: 5 }, (_, i) => html`
            <div style="padding:12px;border-radius:8px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                ${skeleton({ width: `${150 - i * 10}px`, height: "14px" })}
                ${skeleton({ width: "60px", height: "12px" })}
              </div>
              ${skeleton({ width: "100%", height: "12px" })}
            </div>
          `)}
        </div>
      </div>
    </div>
  `;
}

function renderHeader(props: OverseerProps, goalsCount: number, stalledCount: number) {
  const goal = props.goal?.goal;
  const canPause = goal && goal.status === "active" && props.onPauseGoal;
  const canResume = goal && goal.status === "paused" && props.onResumeGoal;
  const actionPending = props.goalActionPending ?? false;

  return html`
    <div class="overseer-header">
      <div class="overseer-header__info">
        <div class="overseer-header__icon">${icon("sparkles", { size: 24 })}</div>
        <div>
          <h1 class="overseer-header__title">Overseer</h1>
          <p class="overseer-header__desc">
            Durable plans, assignments, and recovery signals for long-horizon work.
          </p>
        </div>
      </div>
      <div class="overseer-header__actions">
        <div class="overseer-header__stats">
          <span class="badge badge--muted">${goalsCount} goals</span>
          <span class="badge ${stalledCount > 0 ? "badge--warn" : "badge--muted"}">
            ${stalledCount} stalled
          </span>
        </div>
        ${props.onOpenCreateGoal
          ? html`
              <button
                class="btn btn--primary"
                ?disabled=${props.loading || actionPending}
                @click=${props.onOpenCreateGoal}
                title="Create a new goal"
              >
                ${icon("plus", { size: 16 })}
                <span>New Goal</span>
              </button>
            `
          : nothing}
        ${canPause
          ? html`
              <button
                class="btn btn--secondary"
                ?disabled=${props.loading || actionPending}
                @click=${() => props.onPauseGoal!(goal!.goalId)}
                title="Pause the selected goal"
              >
                ${icon("pause", { size: 16 })}
                <span>Pause</span>
              </button>
            `
          : nothing}
        ${canResume
          ? html`
              <button
                class="btn btn--accent"
                ?disabled=${props.loading || actionPending}
                @click=${() => props.onResumeGoal!(goal!.goalId)}
                title="Resume the selected goal"
              >
                ${icon("play", { size: 16 })}
                <span>Resume</span>
              </button>
            `
          : nothing}
        <button class="btn btn--secondary" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${icon("refresh-cw", { size: 16 })}
          <span>${props.loading ? "Loading..." : "Refresh"}</span>
        </button>
        <button class="btn btn--secondary" ?disabled=${props.loading} @click=${props.onTick}>
          ${icon("zap", { size: 16 })}
          <span>Tick</span>
        </button>
      </div>
    </div>
  `;
}

function renderControls(
  props: OverseerProps,
  goals: OverseerStatusResult["goals"],
) {
  return html`
    <div class="overseer-controls">
      <label class="field">
        <span class="field__label">Goal</span>
        <select
          .value=${props.selectedGoalId ?? ""}
          @change=${(event: Event) => {
            const value = (event.target as HTMLSelectElement).value;
            props.onSelectGoal(value || null);
          }}
        >
          ${goals.length === 0
            ? html`<option value="">No goals yet</option>`
            : goals.map(
                (goal) => html`<option value=${goal.goalId}>${goal.title}</option>`,
              )}
        </select>
      </label>
      <label class="toggle-field">
        <input
          type="checkbox"
          ?checked=${props.showOverseerGraph}
          @change=${(event: Event) =>
            props.onToggleOverseerGraph((event.target as HTMLInputElement).checked)}
        />
        <span>Show Overseer graph</span>
      </label>
      <label class="toggle-field">
        <input
          type="checkbox"
          ?checked=${props.showSystemGraph}
          @change=${(event: Event) =>
            props.onToggleSystemGraph((event.target as HTMLInputElement).checked)}
        />
        <span>Show System graph</span>
      </label>
    </div>
  `;
}

type GraphPanelProps = {
  title: string;
  description: string;
  loading: boolean;
  layout: GraphLayout;
  viewport: GraphViewport;
  drag: GraphDragState | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onViewportChange: (next: GraphViewport) => void;
  onDragChange: (next: GraphDragState | null) => void;
  details: unknown;
};

function renderGraphPanel(props: GraphPanelProps) {
  return html`
    <div class="graph-panel">
      <div class="graph-panel__header">
        <div>
          <h2>${props.title}</h2>
          <p>${props.description}</p>
        </div>
        <div class="graph-panel__controls">
          <button
            class="btn btn--sm btn--icon"
            title="Fit to view"
            @click=${(event: Event) => {
              const target = event.currentTarget as HTMLElement;
              const canvas = target.closest(".graph-panel")?.querySelector(".graph-canvas");
              if (!canvas) return;
              const rect = canvas.getBoundingClientRect();
              props.onViewportChange(
                fitGraphViewport(props.layout.bounds, rect.width, rect.height),
              );
            }}
          >
            ${icon("maximize", { size: 14 })}
          </button>
          <button
            class="btn btn--sm btn--icon"
            title="Zoom in"
            @click=${(event: Event) => {
              const target = event.currentTarget as HTMLElement;
              const canvas = target.closest(".graph-panel")?.querySelector(".graph-canvas");
              if (!canvas) return;
              const rect = canvas.getBoundingClientRect();
              const originX = rect.width / 2;
              const originY = rect.height / 2;
              props.onViewportChange(
                zoomGraphViewport(props.viewport, props.viewport.scale * 1.1, originX, originY),
              );
            }}
          >
            ${icon("plus", { size: 14 })}
          </button>
          <button
            class="btn btn--sm btn--icon"
            title="Zoom out"
            @click=${(event: Event) => {
              const target = event.currentTarget as HTMLElement;
              const canvas = target.closest(".graph-panel")?.querySelector(".graph-canvas");
              if (!canvas) return;
              const rect = canvas.getBoundingClientRect();
              const originX = rect.width / 2;
              const originY = rect.height / 2;
              props.onViewportChange(
                zoomGraphViewport(props.viewport, props.viewport.scale * 0.9, originX, originY),
              );
            }}
          >
            ${icon("minus", { size: 14 })}
          </button>
          <button
            class="btn btn--sm btn--icon"
            title="Reset view"
            @click=${() =>
              props.onViewportChange({ scale: 1, offsetX: 24, offsetY: 24 })}
          >
            ${icon("refresh-cw", { size: 14 })}
          </button>
        </div>
      </div>
      <div class="graph-panel__body">
        <div class="graph-canvas ${props.drag ? "graph-canvas--dragging" : ""}"
          @pointerdown=${(event: PointerEvent) => {
            if (event.button !== 0) return;
            const target = event.currentTarget as HTMLElement;
            target.setPointerCapture(event.pointerId);
            props.onDragChange({
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              originX: props.viewport.offsetX,
              originY: props.viewport.offsetY,
            });
          }}
          @pointermove=${(event: PointerEvent) => {
            if (!props.drag || props.drag.pointerId !== event.pointerId) return;
            const deltaX = event.clientX - props.drag.startX;
            const deltaY = event.clientY - props.drag.startY;
            props.onViewportChange({
              ...props.viewport,
              offsetX: props.drag.originX + deltaX,
              offsetY: props.drag.originY + deltaY,
            });
          }}
          @pointerup=${(event: PointerEvent) => {
            if (!props.drag || props.drag.pointerId !== event.pointerId) return;
            props.onDragChange(null);
          }}
          @pointercancel=${() => props.onDragChange(null)}
          @wheel=${(event: WheelEvent) => {
            event.preventDefault();
            const target = event.currentTarget as HTMLElement;
            const rect = target.getBoundingClientRect();
            const originX = event.clientX - rect.left;
            const originY = event.clientY - rect.top;
            const factor = event.deltaY < 0 ? 1.1 : 0.9;
            props.onViewportChange(
              zoomGraphViewport(props.viewport, props.viewport.scale * factor, originX, originY),
            );
          }}
        >
          ${props.loading ? html`<div class="graph-loading">Loading…</div>` : nothing}
          ${props.layout.nodes.length === 0
            ? html`<div class="graph-empty">No graph data yet.</div>`
            : renderGraph(props.layout, props.viewport, props.selectedId, props.onSelect)}
        </div>
        <div class="graph-details">${props.details}</div>
      </div>
    </div>
  `;
}

function renderGraph(
  layout: GraphLayout,
  viewport: GraphViewport,
  selectedId: string | null,
  onSelect: (id: string | null) => void,
) {
  const transform = `translate(${viewport.offsetX} ${viewport.offsetY}) scale(${viewport.scale})`;
  return html`
    <svg class="graph-svg" aria-hidden="true">
      <g transform=${transform}>
        ${layout.edges.map((edge) => {
          const from = layout.nodes.find((node) => node.id === edge.from);
          const to = layout.nodes.find((node) => node.id === edge.to);
          if (!from || !to) return nothing;
          const x1 = from.x + from.width;
          const y1 = from.y + from.height / 2;
          const x2 = to.x;
          const y2 = to.y + to.height / 2;
          return html`<path class="graph-edge" d="M ${x1} ${y1} L ${x2} ${y2}" />`;
        })}
        ${layout.nodes.map((node) => renderGraphNode(node, selectedId === node.id, onSelect))}
      </g>
    </svg>
  `;
}

function renderGraphNode(
  node: GraphNode,
  selected: boolean,
  onSelect: (id: string | null) => void,
) {
  const classes = [
    "graph-node",
    `graph-node--${node.kind}`,
    node.status ? `graph-node--status-${node.status}` : "",
    selected ? "graph-node--selected" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`
    <g
      class=${classes}
      transform="translate(${node.x} ${node.y})"
      @click=${(event: Event) => {
        event.stopPropagation();
        onSelect(node.id);
      }}
    >
      <rect width=${node.width} height=${node.height} rx="10" ry="10"></rect>
      <text x=${node.width / 2} y=${node.height / 2} text-anchor="middle" dominant-baseline="middle">
        ${clampText(node.label, 22)}
      </text>
    </g>
  `;
}

function renderOverseerDetails(props: OverseerProps, layout: GraphLayout) {
  if (!props.goal?.goal) {
    return html`<div class="graph-details__empty">Select a goal to see details.</div>`;
  }
  if (props.goalError) {
    return html`<div class="graph-details__empty">${props.goalError}</div>`;
  }
  const goal = props.goal.goal;
  const selected = props.selectedOverseerNodeId;
  const actionPending = props.goalActionPending ?? false;

  if (!selected || selected.startsWith("goal:")) {
    return html`
      <div class="graph-details__title">Goal</div>
      ${detailRow("Status", goal.status)}
      ${detailRow("Priority", goal.priority)}
      ${detailRow("Updated", formatAgo(goal.updatedAt))}
      ${goal.tags.length ? detailRow("Tags", goal.tags.join(", ")) : nothing}
      ${detailRow("Problem", goal.problemStatement)}
      ${goal.successCriteria.length
        ? detailRow("Success", formatList(goal.successCriteria))
        : nothing}
      ${goal.constraints?.length ? detailRow("Constraints", formatList(goal.constraints)) : nothing}
      ${goal.assumptions?.length ? detailRow("Assumptions", formatList(goal.assumptions)) : nothing}
    `;
  }

  const node = findPlanNode(goal, selected);
  if (!node) {
    return html`<div class="graph-details__empty">Select a node to see details.</div>`;
  }

  const assignment = props.goal.assignments.find((entry) => entry.workNodeId === node.id);
  const crystallizations = props.goal.crystallizations.filter(
    (entry) => entry.workNodeId === node.id,
  );
  const latestCrystal = crystallizations[crystallizations.length - 1];
  const canMarkDone = node.status !== "done" && props.onMarkWorkDone;
  const canBlock = node.status !== "blocked" && props.onBlockWork;
  const canRetry = assignment?.status === "stalled" && props.onRetryAssignment;

  return html`
    <div class="graph-details__title">${node.name}</div>
    ${detailRow("Status", node.status)}
    ${node.blockedReason ? detailRow("Blocked", node.blockedReason) : nothing}
    ${node.objective ? detailRow("Objective", node.objective) : nothing}
    ${node.expectedOutcome ? detailRow("Outcome", node.expectedOutcome) : nothing}
    ${node.definitionOfDone ? detailRow("Definition", node.definitionOfDone) : nothing}
    ${node.acceptanceCriteria?.length
      ? detailRow("Acceptance", formatList(node.acceptanceCriteria))
      : nothing}
    ${canMarkDone || canBlock || canRetry
      ? html`
          <div class="graph-details__actions">
            ${canMarkDone
              ? html`
                  <button
                    class="btn btn--sm btn--accent"
                    ?disabled=${actionPending}
                    @click=${() => {
                      const summary = prompt("Optional: Add a summary of the completed work");
                      props.onMarkWorkDone!(goal.goalId, node.id, summary ?? undefined);
                    }}
                    title="Mark this work as done"
                  >
                    ${icon("check", { size: 12 })}
                    <span>Mark Done</span>
                  </button>
                `
              : nothing}
            ${canBlock
              ? html`
                  <button
                    class="btn btn--sm btn--secondary"
                    ?disabled=${actionPending}
                    @click=${() => {
                      const reason = prompt("Enter a reason for blocking this work:");
                      if (reason) {
                        props.onBlockWork!(goal.goalId, node.id, reason);
                      }
                    }}
                    title="Mark this work as blocked"
                  >
                    ${icon("x-circle", { size: 12 })}
                    <span>Block</span>
                  </button>
                `
              : nothing}
            ${canRetry
              ? html`
                  <button
                    class="btn btn--sm btn--accent"
                    ?disabled=${actionPending}
                    @click=${() => props.onRetryAssignment!(goal.goalId, node.id)}
                    title="Retry this assignment"
                  >
                    ${icon("refresh-cw", { size: 12 })}
                    <span>Retry</span>
                  </button>
                `
              : nothing}
          </div>
        `
      : nothing}
    ${assignment
      ? html`
          <div class="graph-details__section">
            <div class="graph-details__label">Assignment</div>
            ${detailRow("Status", assignment.status)}
            ${assignment.agentId ? detailRow("Agent", assignment.agentId) : nothing}
            ${assignment.sessionKey ? detailRow("Session", assignment.sessionKey) : nothing}
            ${assignment.lastDispatchAt
              ? detailRow("Last dispatch", formatAgo(assignment.lastDispatchAt))
              : nothing}
            ${assignment.lastObservedActivityAt
              ? detailRow("Last activity", formatAgo(assignment.lastObservedActivityAt))
              : nothing}
            ${assignment.backoffUntil
              ? detailRow("Backoff", formatAgo(assignment.backoffUntil))
              : nothing}
          </div>
        `
      : nothing}
    ${latestCrystal
      ? html`
          <div class="graph-details__section">
            <div class="graph-details__label">Latest crystallization</div>
            ${latestCrystal.summary ? detailRow("Summary", latestCrystal.summary) : nothing}
            ${latestCrystal.decisions?.length
              ? detailRow("Decisions", formatList(latestCrystal.decisions))
              : nothing}
            ${latestCrystal.nextActions?.length
              ? detailRow("Next", formatList(latestCrystal.nextActions))
              : nothing}
          </div>
        `
      : nothing}
  `;
}

function renderSystemDetails(props: OverseerProps, layout: GraphLayout) {
  const selectedId = props.selectedSystemNodeId;
  if (!selectedId) {
    return html`
      <div class="graph-details__title">System summary</div>
      ${detailRow("Nodes", String(props.nodes.length))}
      ${detailRow("Instances", String(props.presenceEntries.length))}
      ${detailRow("Cron jobs", String(props.cronJobs.length))}
      ${detailRow("Skills", String(props.skillsReport?.skills?.length ?? 0))}
      ${detailRow("Agents", String(props.agents?.agents?.length ?? 0))}
      ${detailRow("Sessions", String(props.sessions?.count ?? 0))}
      ${detailRow("Channels", String(props.channels?.channelOrder?.length ?? 0))}
    `;
  }
  const node = layout.nodes.find((entry) => entry.id === selectedId);
  if (!node) {
    return html`<div class="graph-details__empty">Select a node to see details.</div>`;
  }
  if (node.kind === "gateway") {
    return html`
      <div class="graph-details__title">Gateway</div>
      ${detailRow("Nodes", String(props.nodes.length))}
      ${detailRow("Instances", String(props.presenceEntries.length))}
      ${detailRow("Cron jobs", String(props.cronJobs.length))}
      ${detailRow("Skills", String(props.skillsReport?.skills?.length ?? 0))}
      ${detailRow("Agents", String(props.agents?.agents?.length ?? 0))}
      ${detailRow("Sessions", String(props.sessions?.count ?? 0))}
      ${detailRow("Channels", String(props.channels?.channelOrder?.length ?? 0))}
    `;
  }
  if (node.kind === "group") {
    return html`
      <div class="graph-details__title">${node.label}</div>
      ${detailRow("Items", String(layout.edges.filter((edge) => edge.from === node.id).length))}
    `;
  }
  if (node.kind === "node") {
    const data = node.data ?? {};
    return html`
      <div class="graph-details__title">${node.label}</div>
      ${detailRow("Node ID", String(data.nodeId ?? ""))}
      ${detailRow("Status", data.connected ? "Online" : "Offline")}
      ${data.version ? detailRow("Version", String(data.version)) : nothing}
      ${data.remoteIp ? detailRow("IP", String(data.remoteIp)) : nothing}
      ${Array.isArray(data.caps) && data.caps.length
        ? detailRow("Caps", formatList(data.caps as string[]))
        : nothing}
    `;
  }
  if (node.kind === "agent") {
    const data = (node.data ?? {}) as Record<string, unknown>;
    const identity = data.identity as Record<string, unknown> | undefined;
    return html`
      <div class="graph-details__title">${node.label}</div>
      ${detailRow("Agent ID", String(data.id ?? ""))}
      ${identity?.role ? detailRow("Role", String(identity.role)) : nothing}
      ${identity?.emoji ? detailRow("Emoji", String(identity.emoji)) : nothing}
    `;
  }
  if (node.kind === "session") {
    const data = (node.data ?? {}) as Record<string, unknown>;
    return html`
      <div class="graph-details__title">${node.label}</div>
      ${detailRow("Key", String(data.key ?? ""))}
      ${detailRow("Kind", String(data.kind ?? ""))}
      ${data.updatedAt ? detailRow("Updated", formatAgo(data.updatedAt as number)) : nothing}
    `;
  }
  if (node.kind === "channel") {
    const data = node.data ?? {};
    return html`
      <div class="graph-details__title">${node.label}</div>
      ${data.configured != null ? detailRow("Configured", data.configured ? "Yes" : "No") : nothing}
      ${data.running != null ? detailRow("Running", data.running ? "Yes" : "No") : nothing}
      ${data.connected != null ? detailRow("Connected", data.connected ? "Yes" : "No") : nothing}
      ${data.lastError ? detailRow("Last error", String(data.lastError)) : nothing}
    `;
  }
  if (node.kind === "instance") {
    const data = node.data ?? {};
    const lastInputSeconds =
      typeof data.lastInputSeconds === "number" ? data.lastInputSeconds : null;
    return html`
      <div class="graph-details__title">${node.label}</div>
      ${detailRow("Instance ID", String(data.instanceId ?? ""))}
      ${data.host ? detailRow("Host", String(data.host)) : nothing}
      ${data.platform ? detailRow("Platform", String(data.platform)) : nothing}
      ${data.version ? detailRow("Version", String(data.version)) : nothing}
      ${data.mode ? detailRow("Mode", String(data.mode)) : nothing}
      ${data.deviceFamily ? detailRow("Device", String(data.deviceFamily)) : nothing}
      ${data.modelIdentifier ? detailRow("Model", String(data.modelIdentifier)) : nothing}
      ${lastInputSeconds != null
        ? detailRow("Last input", `${formatDurationMs(lastInputSeconds * 1000)} ago`)
        : nothing}
      ${data.reason ? detailRow("Reason", String(data.reason)) : nothing}
    `;
  }
  if (node.kind === "cron") {
    const data = (node.data ?? {}) as Record<string, unknown>;
    const state = data.state as Record<string, unknown> | undefined;
    return html`
      <div class="graph-details__title">${node.label}</div>
      ${detailRow("Enabled", data.enabled ? "Yes" : "No")}
      ${data.description ? detailRow("Description", String(data.description)) : nothing}
      ${data.agentId ? detailRow("Agent", String(data.agentId)) : nothing}
      ${data.schedule ? detailRow("Schedule", formatCronSchedule(data.schedule)) : nothing}
      ${state?.nextRunAtMs
        ? detailRow("Next run", formatAgo(state.nextRunAtMs as number))
        : nothing}
      ${state?.lastStatus ? detailRow("Last status", String(state.lastStatus)) : nothing}
    `;
  }
  if (node.kind === "skill") {
    const data = (node.data ?? {}) as Record<string, unknown>;
    const missing = data.missing as Record<string, unknown> | undefined;
    const missingBins = Array.isArray(missing?.bins) ? (missing.bins as string[]) : [];
    const missingEnv = Array.isArray(missing?.env) ? (missing.env as string[]) : [];
    return html`
      <div class="graph-details__title">${node.label}</div>
      ${detailRow("Key", String(data.skillKey ?? ""))}
      ${data.description ? detailRow("Description", String(data.description)) : nothing}
      ${detailRow("Eligible", data.eligible ? "Yes" : "No")}
      ${detailRow("Disabled", data.disabled ? "Yes" : "No")}
      ${missingBins.length ? detailRow("Missing bins", formatList(missingBins)) : nothing}
      ${missingEnv.length ? detailRow("Missing env", formatList(missingEnv)) : nothing}
    `;
  }
  return html`<div class="graph-details__empty">Select a node to see details.</div>`;
}

function renderDrawer(props: OverseerProps) {
  const content = buildDrawerContent(props);
  if (!content) return nothing;
  return html`
    <div class="overseer-drawer-backdrop" @click=${props.onDrawerClose}></div>
    <aside class="overseer-drawer">
      <div class="overseer-drawer__header">
        <div>
          <div class="overseer-drawer__title">${content.title}</div>
          ${content.subtitle
            ? html`<div class="overseer-drawer__subtitle">${content.subtitle}</div>`
            : nothing}
        </div>
        <button class="btn btn--icon btn--sm" @click=${props.onDrawerClose} title="Close">
          ${icon("x", { size: 14 })}
        </button>
      </div>
      <div class="overseer-drawer__body">${content.body}</div>
    </aside>
  `;
}

function buildDrawerContent(props: OverseerProps): {
  title: string;
  subtitle?: string;
  body: unknown;
} | null {
  if (!props.drawerKind || !props.drawerNodeId) return null;
  if (props.drawerKind === "cron") {
    const job = props.cronJobs.find((entry) => entry.id === props.drawerNodeId);
    if (!job) return null;
    const runs = props.cronRunsJobId === job.id ? props.cronRuns : [];
    return {
      title: job.name,
      subtitle: job.enabled ? "Cron job (enabled)" : "Cron job (disabled)",
      body: renderCronDrawerBody(job, runs, props),
    };
  }
  if (props.drawerKind === "session") {
    const session = props.sessions?.sessions.find(
      (entry) => entry.key === props.drawerNodeId,
    );
    if (!session) return null;
    return {
      title: session.displayName ?? session.key,
      subtitle: "Session",
      body: renderSessionDrawerBody(session),
    };
  }
  if (props.drawerKind === "skill") {
    const skill = props.skillsReport?.skills.find(
      (entry) => entry.skillKey === props.drawerNodeId,
    );
    if (!skill) return null;
    return {
      title: skill.name,
      subtitle: "Skill",
      body: renderSkillDrawerBody(skill),
    };
  }
  if (props.drawerKind === "channel") {
    const channelId = props.drawerNodeId;
    const channel = props.channels?.channels?.[channelId] as
      | Record<string, unknown>
      | undefined;
    return {
      title: props.channels?.channelLabels?.[channelId] ?? channelId,
      subtitle: "Channel",
      body: renderChannelDrawerBody(channelId, channel, props),
    };
  }
  if (props.drawerKind === "node") {
    const node = props.nodes.find(
      (entry) =>
        String(entry.nodeId ?? entry.displayName ?? "") === props.drawerNodeId,
    );
    if (!node) return null;
    return {
      title: String(node.displayName ?? node.nodeId ?? "Node"),
      subtitle: "Node",
      body: renderNodeDrawerBody(node),
    };
  }
  if (props.drawerKind === "instance") {
    const entry = props.presenceEntries.find(
      (item) =>
        String(item.instanceId ?? item.host ?? "") === props.drawerNodeId,
    );
    if (!entry) return null;
    return {
      title: String(entry.host ?? entry.instanceId ?? "Instance"),
      subtitle: "Instance",
      body: renderInstanceDrawerBody(entry),
    };
  }
  return null;
}

function renderCronDrawerBody(job: CronJob, runs: CronRunLogEntry[], props: OverseerProps) {
  const schedule = formatCronSchedule(job.schedule);
  return html`
    <div class="overseer-drawer__section">
      ${detailRow("Enabled", job.enabled ? "Yes" : "No")}
      ${job.description ? detailRow("Description", job.description) : nothing}
      ${job.agentId ? detailRow("Agent", job.agentId) : nothing}
      ${detailRow("Schedule", schedule)}
      ${job.state?.nextRunAtMs
        ? detailRow("Next run", formatAgo(job.state.nextRunAtMs))
        : nothing}
    </div>
    <div class="overseer-drawer__section">
      <div class="overseer-drawer__section-header">
        <div class="overseer-drawer__section-title">Recent runs</div>
        <button
          class="btn btn--sm btn--secondary"
          @click=${() => props.onLoadCronRuns(job.id)}
        >
          ${icon("refresh-cw", { size: 14 })}
          <span>Refresh</span>
        </button>
      </div>
      ${runs.length === 0
        ? html`<div class="muted">No runs recorded.</div>`
        : html`
            <div class="overseer-run-list">
              ${runs.map(
                (run) => html`
                  <div class="overseer-run-list__row">
                    <span class="badge ${run.status === "ok"
                      ? "badge--ok"
                      : run.status === "error"
                        ? "badge--danger"
                        : "badge--muted"}"
                    >
                      ${run.status}
                    </span>
                    <span>${formatAgo(run.ts)}</span>
                    <span class="muted">
                      ${run.durationMs ? formatDurationMs(run.durationMs) : "n/a"}
                    </span>
                    ${run.error ? html`<span class="muted">${run.error}</span>` : nothing}
                  </div>
                `,
              )}
            </div>
          `}
    </div>
  `;
}

function renderSessionDrawerBody(session: SessionsListResult["sessions"][number]) {
  return html`
    <div class="overseer-drawer__section">
      ${detailRow("Key", session.key)}
      ${detailRow("Kind", session.kind)}
      ${session.model ? detailRow("Model", session.model) : nothing}
      ${session.modelProvider ? detailRow("Provider", session.modelProvider) : nothing}
      ${session.updatedAt ? detailRow("Updated", formatAgo(session.updatedAt)) : nothing}
      ${session.totalTokens != null ? detailRow("Tokens", String(session.totalTokens)) : nothing}
    </div>
  `;
}

function renderSkillDrawerBody(skill: SkillStatusReport["skills"][number]) {
  return html`
    <div class="overseer-drawer__section">
      ${detailRow("Key", skill.skillKey)}
      ${detailRow("Eligible", skill.eligible ? "Yes" : "No")}
      ${detailRow("Disabled", skill.disabled ? "Yes" : "No")}
      ${skill.description ? detailRow("Description", skill.description) : nothing}
    </div>
    <div class="overseer-drawer__section">
      <div class="overseer-drawer__section-title">Missing requirements</div>
      ${skill.missing.bins.length
        ? detailRow("Bins", formatList(skill.missing.bins))
        : nothing}
      ${skill.missing.env.length ? detailRow("Env", formatList(skill.missing.env)) : nothing}
      ${skill.missing.config.length
        ? detailRow("Config", formatList(skill.missing.config))
        : nothing}
      ${skill.missing.bins.length ||
      skill.missing.env.length ||
      skill.missing.config.length
        ? nothing
        : html`<div class="muted">All requirements met.</div>`}
    </div>
  `;
}

function renderChannelDrawerBody(
  channelId: string,
  channel: Record<string, unknown> | undefined,
  props: OverseerProps,
) {
  const accounts = props.channels?.channelAccounts?.[channelId] ?? [];
  return html`
    <div class="overseer-drawer__section">
      ${channel?.configured != null
        ? detailRow("Configured", channel.configured ? "Yes" : "No")
        : nothing}
      ${channel?.running != null
        ? detailRow("Running", channel.running ? "Yes" : "No")
        : nothing}
      ${channel?.connected != null
        ? detailRow("Connected", channel.connected ? "Yes" : "No")
        : nothing}
      ${detailRow("Accounts", String(accounts.length))}
    </div>
  `;
}

function renderNodeDrawerBody(node: Record<string, unknown>) {
  return html`
    <div class="overseer-drawer__section">
      ${detailRow("Node ID", String(node.nodeId ?? ""))}
      ${detailRow("Status", node.connected ? "Online" : "Offline")}
      ${node.version ? detailRow("Version", String(node.version)) : nothing}
      ${node.remoteIp ? detailRow("IP", String(node.remoteIp)) : nothing}
      ${Array.isArray(node.caps) && node.caps.length
        ? detailRow("Caps", formatList(node.caps as string[]))
        : nothing}
    </div>
  `;
}

function renderInstanceDrawerBody(entry: PresenceEntry) {
  const lastInputSeconds = entry.lastInputSeconds ?? null;
  return html`
    <div class="overseer-drawer__section">
      ${detailRow("Instance ID", String(entry.instanceId ?? ""))}
      ${entry.host ? detailRow("Host", entry.host) : nothing}
      ${entry.platform ? detailRow("Platform", entry.platform) : nothing}
      ${entry.version ? detailRow("Version", entry.version) : nothing}
      ${entry.mode ? detailRow("Mode", entry.mode) : nothing}
      ${entry.deviceFamily ? detailRow("Device", entry.deviceFamily) : nothing}
      ${entry.modelIdentifier ? detailRow("Model", entry.modelIdentifier) : nothing}
      ${lastInputSeconds != null
        ? detailRow("Last input", `${formatDurationMs(lastInputSeconds * 1000)} ago`)
        : nothing}
      ${entry.reason ? detailRow("Reason", entry.reason) : nothing}
    </div>
  `;
}

function findPlanNode(
  goal: NonNullable<OverseerGoalStatusResult["goal"]>,
  nodeId: string,
) {
  const phases = goal.plan?.phases ?? [];
  for (const phase of phases) {
    if (phase.id === nodeId) return phase;
    for (const task of phase.tasks) {
      if (task.id === nodeId) return task;
      for (const subtask of task.subtasks) {
        if (subtask.id === nodeId) return subtask;
      }
    }
  }
  return null;
}

function detailRow(label: string, value: string) {
  return html`
    <div class="graph-details__row">
      <span class="graph-details__label">${label}</span>
      <span class="graph-details__value">${value}</span>
    </div>
  `;
}

function formatCronSchedule(schedule: {
  kind?: string;
  atMs?: number;
  everyMs?: number;
  expr?: string;
  tz?: string;
}) {
  if (!schedule) return "n/a";
  if (schedule.kind === "at" && schedule.atMs) return `at ${formatAgo(schedule.atMs)}`;
  if (schedule.kind === "every" && schedule.everyMs) {
    return `every ${formatDurationMs(schedule.everyMs)}`;
  }
  if (schedule.kind === "cron") {
    return schedule.tz ? `cron ${schedule.expr} (${schedule.tz})` : `cron ${schedule.expr}`;
  }
  return "n/a";
}

/* =============================================================================
   ENHANCED OVERSEER COMPONENTS - Activity Feed, Stats, Stalled Panel
   ============================================================================= */

type ActivityEvent = {
  id: string;
  title: string;
  description: string;
  status: "success" | "warning" | "error" | "info" | "progress";
  timestamp: number;
  source?: string;
};

function buildActivityEvents(props: OverseerProps): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  // Add events from assignments
  const assignments = props.goal?.assignments ?? [];
  for (const assignment of assignments) {
    if (assignment.lastDispatchAt) {
      events.push({
        id: `dispatch-${assignment.workNodeId}`,
        title: "Task Dispatched",
        description: `Assignment sent to ${assignment.agentId ?? "agent"}`,
        status: "info",
        timestamp: assignment.lastDispatchAt,
        source: assignment.agentId ?? undefined,
      });
    }
    if (assignment.status === "stalled") {
      events.push({
        id: `stalled-${assignment.workNodeId}`,
        title: "Assignment Stalled",
        description: `Work on ${assignment.workNodeId} has stalled`,
        status: "warning",
        timestamp: assignment.lastObservedActivityAt ?? Date.now(),
        source: assignment.agentId ?? undefined,
      });
    }
  }

  // Add events from crystallizations
  const crystallizations = props.goal?.crystallizations ?? [];
  for (const crystal of crystallizations.slice(-10)) {
    events.push({
      id: `crystal-${crystal.workNodeId}-${crystal.createdAt}`,
      title: "Progress Crystallized",
      description: crystal.summary ?? `Work crystallized on ${crystal.workNodeId}`,
      status: "success",
      timestamp: crystal.createdAt,
      source: "Overseer",
    });
  }

  // Add goal status events
  const goal = props.goal?.goal;
  if (goal?.updatedAt) {
    events.push({
      id: `goal-update-${goal.goalId}`,
      title: `Goal: ${goal.status}`,
      description: goal.title,
      status: goal.status === "done" ? "success" : goal.status === "blocked" ? "error" : "progress",
      timestamp: goal.updatedAt,
      source: "Overseer",
    });
  }

  // Sort by timestamp descending
  events.sort((a, b) => b.timestamp - a.timestamp);
  return events.slice(0, 20);
}

function renderStatsCards(
  props: OverseerProps,
  goals: OverseerStatusResult["goals"],
  stalledAssignments: OverseerStatusResult["stalledAssignments"],
) {
  const goal = props.goal?.goal;
  const phases = goal?.plan?.phases ?? [];
  const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
  const doneTasks = phases.reduce(
    (sum, phase) => sum + phase.tasks.filter((t) => t.status === "done").length,
    0,
  );
  const inProgressTasks = phases.reduce(
    (sum, phase) => sum + phase.tasks.filter((t) => t.status === "in_progress").length,
    0,
  );
  const completionPct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

  return html`
    <div class="overseer-stats">
      <div class="overseer-stat-card">
        <div class="overseer-stat-card__header">
          <span class="overseer-stat-card__label">Goals</span>
          <div class="overseer-stat-card__icon overseer-stat-card__icon--accent">
            ${icon("target", { size: 16 })}
          </div>
        </div>
        <div class="overseer-stat-card__value">${goals.length}</div>
        <div class="overseer-stat-card__footer">
          <div class="progress-bar progress-bar--sm" style="flex: 1;">
            <div class="progress-bar__fill" style="width: ${completionPct}%;"></div>
          </div>
          <span style="font-size: 11px; color: var(--muted);">${completionPct}%</span>
        </div>
      </div>

      <div class="overseer-stat-card">
        <div class="overseer-stat-card__header">
          <span class="overseer-stat-card__label">Tasks</span>
          <div class="overseer-stat-card__icon overseer-stat-card__icon--success">
            ${icon("check-circle", { size: 16 })}
          </div>
        </div>
        <div class="overseer-stat-card__value">${doneTasks}<span style="font-size: 14px; color: var(--muted);"> / ${totalTasks}</span></div>
        <div class="overseer-stat-card__footer">
          <span class="overseer-stat-card__trend overseer-stat-card__trend--up">
            ${icon("trending-up", { size: 12 })}
            <span>${inProgressTasks} in progress</span>
          </span>
        </div>
      </div>

      <div class="overseer-stat-card">
        <div class="overseer-stat-card__header">
          <span class="overseer-stat-card__label">Stalled</span>
          <div class="overseer-stat-card__icon ${stalledAssignments.length > 0 ? "overseer-stat-card__icon--warn" : ""}">
            ${icon("alert-triangle", { size: 16 })}
          </div>
        </div>
        <div class="overseer-stat-card__value" style="${stalledAssignments.length > 0 ? "color: var(--warn);" : ""}">${stalledAssignments.length}</div>
        <div class="overseer-stat-card__footer">
          <span style="font-size: 11px; color: var(--muted);">
            ${stalledAssignments.length > 0 ? "Needs attention" : "All clear"}
          </span>
        </div>
      </div>

      <div class="overseer-stat-card">
        <div class="overseer-stat-card__header">
          <span class="overseer-stat-card__label">Phases</span>
          <div class="overseer-stat-card__icon">
            ${icon("layers", { size: 16 })}
          </div>
        </div>
        <div class="overseer-stat-card__value">${phases.length}</div>
        <div class="overseer-stat-card__footer">
          <span style="font-size: 11px; color: var(--muted);">
            ${phases.filter((p) => p.status === "done").length} completed
          </span>
        </div>
      </div>
    </div>
  `;
}

function renderStalledPanel(
  stalledAssignments: OverseerStatusResult["stalledAssignments"],
  props: OverseerProps,
) {
  const actionPending = props.goalActionPending ?? false;

  return html`
    <div class="stalled-panel">
      <div class="stalled-panel__header">
        <div class="stalled-panel__icon">
          ${icon("alert-triangle", { size: 18 })}
        </div>
        <div class="stalled-panel__title">
          <div class="stalled-panel__title-text">Stalled Assignments</div>
          <div class="stalled-panel__count">${stalledAssignments.length} assignments need attention</div>
        </div>
      </div>
      <div class="stalled-list">
        ${stalledAssignments.slice(0, 5).map(
          (assignment) => html`
            <div class="stalled-item">
              <div>
                <div class="stalled-item__task">${assignment.workNodeId}</div>
                <div class="stalled-item__reason">
                  ${assignment.agentId ? `Agent: ${assignment.agentId}` : "No agent assigned"}
                  ${assignment.backoffUntil ? ` • Backoff until ${formatAgo(assignment.backoffUntil)}` : ""}
                </div>
              </div>
              <div class="stalled-item__actions">
                ${props.onRetryAssignment
                  ? html`
                      <button
                        class="btn btn--sm btn--accent"
                        title="Retry assignment"
                        ?disabled=${actionPending}
                        @click=${() => props.onRetryAssignment!(assignment.goalId, assignment.workNodeId)}
                      >
                        ${icon("refresh-cw", { size: 12 })}
                        <span>Retry</span>
                      </button>
                    `
                  : html`
                      <button class="btn btn--sm" title="Retry assignment" disabled>
                        ${icon("refresh-cw", { size: 12 })}
                      </button>
                    `}
                ${props.onBlockWork
                  ? html`
                      <button
                        class="btn btn--sm btn--secondary"
                        title="Mark as blocked"
                        ?disabled=${actionPending}
                        @click=${() => {
                          const reason = prompt("Enter a reason for blocking this work:");
                          if (reason) {
                            props.onBlockWork!(assignment.goalId, assignment.workNodeId, reason);
                          }
                        }}
                      >
                        ${icon("x-circle", { size: 12 })}
                      </button>
                    `
                  : nothing}
              </div>
            </div>
          `,
        )}
      </div>
    </div>
  `;
}

function renderCreateGoalModal(props: OverseerProps) {
  const form = props.createGoalForm ?? {
    title: "",
    problemStatement: "",
    successCriteria: [],
    constraints: [],
    priority: "normal" as const,
    generatePlan: true,
  };
  const actionPending = props.goalActionPending ?? false;
  const canSubmit = form.title.trim() && form.problemStatement.trim() && !actionPending;

  return html`
    <div class="overseer-modal-backdrop" @click=${props.onCloseCreateGoal}></div>
    <div class="overseer-modal" role="dialog" aria-labelledby="create-goal-title">
      <div class="overseer-modal__header">
        <h2 id="create-goal-title" class="overseer-modal__title">Create New Goal</h2>
        <button
          class="btn btn--icon btn--sm"
          @click=${props.onCloseCreateGoal}
          title="Close"
          aria-label="Close"
        >
          ${icon("x", { size: 14 })}
        </button>
      </div>
      <div class="overseer-modal__body">
        <div class="field">
          <label class="field__label">Title *</label>
          <input
            class="field__input"
            type="text"
            placeholder="Brief title for the goal"
            .value=${form.title}
            ?disabled=${actionPending}
            @input=${(e: Event) =>
              props.onUpdateCreateGoalForm?.({ title: (e.target as HTMLInputElement).value })}
          />
        </div>
        <div class="field">
          <label class="field__label">Problem Statement *</label>
          <textarea
            class="field__input"
            rows="3"
            placeholder="Describe the problem to solve"
            .value=${form.problemStatement}
            ?disabled=${actionPending}
            @input=${(e: Event) =>
              props.onUpdateCreateGoalForm?.({
                problemStatement: (e.target as HTMLTextAreaElement).value,
              })}
          ></textarea>
        </div>
        <div class="field">
          <label class="field__label">Success Criteria (one per line)</label>
          <textarea
            class="field__input"
            rows="2"
            placeholder="How will we know this is done?"
            .value=${form.successCriteria.join("\n")}
            ?disabled=${actionPending}
            @input=${(e: Event) =>
              props.onUpdateCreateGoalForm?.({
                successCriteria: (e.target as HTMLTextAreaElement).value
                  .split("\n")
                  .filter((line) => line.trim()),
              })}
          ></textarea>
        </div>
        <div class="field">
          <label class="field__label">Constraints (one per line)</label>
          <textarea
            class="field__input"
            rows="2"
            placeholder="Limitations or requirements"
            .value=${form.constraints.join("\n")}
            ?disabled=${actionPending}
            @input=${(e: Event) =>
              props.onUpdateCreateGoalForm?.({
                constraints: (e.target as HTMLTextAreaElement).value
                  .split("\n")
                  .filter((line) => line.trim()),
              })}
          ></textarea>
        </div>
        <div class="overseer-modal__row">
          <div class="field" style="flex: 1;">
            <label class="field__label">Priority</label>
            <select
              class="field__input"
              .value=${form.priority}
              ?disabled=${actionPending}
              @change=${(e: Event) =>
                props.onUpdateCreateGoalForm?.({
                  priority: (e.target as HTMLSelectElement).value as typeof form.priority,
                })}
            >
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>
          <label class="toggle-field" style="flex: 1; align-self: flex-end;">
            <input
              type="checkbox"
              ?checked=${form.generatePlan}
              ?disabled=${actionPending}
              @change=${(e: Event) =>
                props.onUpdateCreateGoalForm?.({
                  generatePlan: (e.target as HTMLInputElement).checked,
                })}
            />
            <span>Generate plan automatically</span>
          </label>
        </div>
        ${props.goalActionError
          ? html`<div class="overseer-modal__error">${props.goalActionError}</div>`
          : nothing}
      </div>
      <div class="overseer-modal__footer">
        <button
          class="btn btn--secondary"
          ?disabled=${actionPending}
          @click=${props.onCloseCreateGoal}
        >
          Cancel
        </button>
        <button
          class="btn btn--primary"
          ?disabled=${!canSubmit}
          @click=${() => props.onCreateGoal?.(form)}
        >
          ${actionPending ? "Creating..." : "Create Goal"}
        </button>
      </div>
    </div>
  `;
}

function renderActivityFeed(events: ActivityEvent[], props: OverseerProps) {
  const statusIcons: Record<ActivityEvent["status"], IconName> = {
    success: "check-circle",
    warning: "alert-triangle",
    error: "alert-circle",
    info: "info",
    progress: "clock",
  };

  const filterStatus = props.activityFilterStatus ?? null;
  const limit = props.activityLimit ?? 50;
  const filteredEvents = filterStatus
    ? events.filter((e) => e.status === filterStatus)
    : events;
  const displayedEvents = filteredEvents.slice(0, limit);
  const hasClickHandler = Boolean(props.onActivityEventClick);

  return html`
    <div class="activity-feed">
      <div class="activity-feed__header">
        <div class="activity-feed__header-left">
          <div class="activity-feed__icon">
            ${icon("activity", { size: 20 })}
          </div>
          <div>
            <div class="activity-feed__title">Activity Feed</div>
            <div class="activity-feed__subtitle">Real-time overseer events</div>
          </div>
        </div>
        <div class="activity-feed__live">
          <span class="activity-feed__live-dot"></span>
          <span>Live</span>
        </div>
      </div>
      ${props.onActivityFilterChange
        ? html`
            <div class="activity-feed__filters">
              <button
                class="activity-feed__filter ${!filterStatus ? "activity-feed__filter--active" : ""}"
                @click=${() => props.onActivityFilterChange!(null)}
              >
                All
              </button>
              <button
                class="activity-feed__filter activity-feed__filter--success ${filterStatus === "success" ? "activity-feed__filter--active" : ""}"
                @click=${() => props.onActivityFilterChange!("success")}
              >
                ${icon("check-circle", { size: 12 })}
              </button>
              <button
                class="activity-feed__filter activity-feed__filter--warning ${filterStatus === "warning" ? "activity-feed__filter--active" : ""}"
                @click=${() => props.onActivityFilterChange!("warning")}
              >
                ${icon("alert-triangle", { size: 12 })}
              </button>
              <button
                class="activity-feed__filter activity-feed__filter--error ${filterStatus === "error" ? "activity-feed__filter--active" : ""}"
                @click=${() => props.onActivityFilterChange!("error")}
              >
                ${icon("alert-circle", { size: 12 })}
              </button>
              <button
                class="activity-feed__filter activity-feed__filter--info ${filterStatus === "info" ? "activity-feed__filter--active" : ""}"
                @click=${() => props.onActivityFilterChange!("info")}
              >
                ${icon("info", { size: 12 })}
              </button>
            </div>
          `
        : nothing}
      <div class="activity-feed__body">
        <div class="activity-feed__items">
          ${displayedEvents.length === 0
            ? html`
                <div class="activity-feed__empty">
                  <div class="activity-feed__empty-icon">${icon("activity", { size: 32 })}</div>
                  <div class="activity-feed__empty-text">
                    ${filterStatus ? "No matching events" : "No activity yet"}
                  </div>
                </div>
              `
            : displayedEvents.map(
                (event, index) => html`
                  <div
                    class="activity-feed__item ${hasClickHandler ? "activity-feed__item--clickable" : ""}"
                    style="animation-delay: ${index * 50}ms;"
                    @click=${() => props.onActivityEventClick?.(event)}
                    role=${hasClickHandler ? "button" : nothing}
                    tabindex=${hasClickHandler ? "0" : nothing}
                  >
                    <div class="activity-feed__item-icon activity-feed__item-icon--${event.status}">
                      ${icon(statusIcons[event.status], { size: 14 })}
                    </div>
                    <div class="activity-feed__item-content">
                      <div class="activity-feed__item-header">
                        <div class="activity-feed__item-title">${event.title}</div>
                        <span class="activity-feed__item-badge activity-feed__item-badge--${event.status}">
                          ${event.status}
                        </span>
                      </div>
                      <div class="activity-feed__item-desc">${clampText(event.description, 80)}</div>
                      <div class="activity-feed__item-meta">
                        ${event.source ? html`<span>${event.source}</span>` : nothing}
                        <span>${formatAgo(event.timestamp)}</span>
                      </div>
                    </div>
                  </div>
                `,
              )}
          ${filteredEvents.length > limit
            ? html`
                <div class="activity-feed__more">
                  ${filteredEvents.length - limit} more events
                  ${props.onActivityLimitChange
                    ? html`
                        <button
                          class="btn btn--sm btn--secondary"
                          @click=${() => props.onActivityLimitChange!(limit + 50)}
                        >
                          Show more
                        </button>
                      `
                    : nothing}
                </div>
              `
            : nothing}
        </div>
      </div>
    </div>
  `;
}
