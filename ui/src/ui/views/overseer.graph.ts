import type { OverseerGoalStatusResult } from "../types/overseer";
import type {
  AgentsListResult,
  ChannelsStatusSnapshot,
  CronJob,
  PresenceEntry,
  SessionsListResult,
  SkillStatusReport,
} from "../types";
import type { GraphViewport } from "../ui-types";

export type GraphNodeKind =
  | "goal"
  | "phase"
  | "task"
  | "subtask"
  | "gateway"
  | "group"
  | "node"
  | "instance"
  | "cron"
  | "skill"
  | "agent"
  | "session"
  | "channel";

export type GraphNode = {
  id: string;
  kind: GraphNodeKind;
  label: string;
  status?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  data?: Record<string, unknown>;
};

export type GraphEdge = {
  id: string;
  from: string;
  to: string;
};

export type GraphBounds = {
  width: number;
  height: number;
};

export type GraphLayout = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  bounds: GraphBounds;
};

const NODE_WIDTH = 200;
const NODE_HEIGHT = 60;
const COL_GAP = 90;
const ROW_GAP = 24;
const GROUP_GAP = 36;

const PLAN_COLUMNS = {
  goal: 0,
  phase: NODE_WIDTH + COL_GAP,
  task: (NODE_WIDTH + COL_GAP) * 2,
  subtask: (NODE_WIDTH + COL_GAP) * 3,
};

export function buildOverseerGraphLayout(
  goal: OverseerGoalStatusResult["goal"] | undefined,
): GraphLayout {
  if (!goal) return emptyLayout();
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let cursorY = 0;

  const goalNodeId = `goal:${goal.goalId}`;
  const goalNode: GraphNode = {
    id: goalNodeId,
    kind: "goal",
    label: goal.title,
    status: goal.status,
    x: PLAN_COLUMNS.goal,
    y: 0,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  };
  nodes.push(goalNode);

  const phases = goal.plan?.phases ?? [];
  const phaseCenters: number[] = [];

  for (const phase of phases) {
    const phaseTaskCenters: number[] = [];
    const phaseStartY = cursorY;

    if (phase.tasks.length === 0) {
      const phaseNode: GraphNode = {
        id: phase.id,
        kind: "phase",
        label: phase.name,
        status: phase.status,
        x: PLAN_COLUMNS.phase,
        y: cursorY,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      };
      nodes.push(phaseNode);
      edges.push({ id: `${goalNodeId}->${phase.id}`, from: goalNodeId, to: phase.id });
      phaseCenters.push(phaseNode.y + NODE_HEIGHT / 2);
      cursorY += NODE_HEIGHT + ROW_GAP + GROUP_GAP;
      continue;
    }

    for (const task of phase.tasks) {
      const subtaskCenters: number[] = [];
      if (task.subtasks.length === 0) {
        const taskNode: GraphNode = {
          id: task.id,
          kind: "task",
          label: task.name,
          status: task.status,
          x: PLAN_COLUMNS.task,
          y: cursorY,
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
        };
        nodes.push(taskNode);
        phaseTaskCenters.push(taskNode.y + NODE_HEIGHT / 2);
        cursorY += NODE_HEIGHT + ROW_GAP;
      } else {
        for (const subtask of task.subtasks) {
          const subtaskNode: GraphNode = {
            id: subtask.id,
            kind: "subtask",
            label: subtask.name,
            status: subtask.status,
            x: PLAN_COLUMNS.subtask,
            y: cursorY,
            width: NODE_WIDTH,
            height: NODE_HEIGHT,
          };
          nodes.push(subtaskNode);
          edges.push({ id: `${task.id}->${subtask.id}`, from: task.id, to: subtask.id });
          subtaskCenters.push(subtaskNode.y + NODE_HEIGHT / 2);
          cursorY += NODE_HEIGHT + ROW_GAP;
        }
        const taskCenter = average(subtaskCenters) ?? (cursorY - ROW_GAP - NODE_HEIGHT / 2);
        const taskNode: GraphNode = {
          id: task.id,
          kind: "task",
          label: task.name,
          status: task.status,
          x: PLAN_COLUMNS.task,
          y: taskCenter - NODE_HEIGHT / 2,
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
        };
        nodes.push(taskNode);
        phaseTaskCenters.push(taskCenter);
      }
      edges.push({ id: `${phase.id}->${task.id}`, from: phase.id, to: task.id });
    }

    const phaseCenter =
      average(phaseTaskCenters) ??
      (phaseStartY + (cursorY - phaseStartY - ROW_GAP) / 2);
    const phaseNode: GraphNode = {
      id: phase.id,
      kind: "phase",
      label: phase.name,
      status: phase.status,
      x: PLAN_COLUMNS.phase,
      y: phaseCenter - NODE_HEIGHT / 2,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
    nodes.push(phaseNode);
    edges.push({ id: `${goalNodeId}->${phase.id}`, from: goalNodeId, to: phase.id });
    phaseCenters.push(phaseCenter);
    cursorY += GROUP_GAP;
  }

  if (phaseCenters.length > 0) {
    goalNode.y = average(phaseCenters)! - NODE_HEIGHT / 2;
  } else {
    goalNode.y = 0;
  }

  return finalizeLayout(nodes, edges);
}

export type SystemGraphInput = {
  nodes: Array<Record<string, unknown>>;
  presenceEntries: PresenceEntry[];
  cronJobs: CronJob[];
  skillsReport: SkillStatusReport | null;
  agents: AgentsListResult | null;
  sessions: SessionsListResult | null;
  channels: ChannelsStatusSnapshot | null;
};

export function buildSystemGraphLayout(input: SystemGraphInput): GraphLayout {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let cursorY = 0;

  const gatewayId = "gateway";
  const groupConfigs: Array<{
    id: string;
    label: string;
    kind: GraphNodeKind;
    items: Array<{ id: string; label: string; data?: Record<string, unknown>; status?: string }>;
  }> = [
    {
      id: "group:nodes",
      label: "Nodes",
      kind: "node",
      items: input.nodes.map((node) => ({
        id: `node:${String(node.nodeId ?? node.displayName ?? "node")}`,
        label: String(node.displayName ?? node.nodeId ?? "Node"),
        status: node.connected ? "online" : "offline",
        data: node,
      })),
    },
    {
      id: "group:agents",
      label: "Agents",
      kind: "agent",
      items: (input.agents?.agents ?? []).map((agent) => ({
        id: `agent:${agent.id}`,
        label: agent.identity?.name ?? agent.id,
        data: agent as unknown as Record<string, unknown>,
      })),
    },
    {
      id: "group:sessions",
      label: "Sessions",
      kind: "session",
      items: (input.sessions?.sessions ?? []).map((session) => ({
        id: `session:${session.key}`,
        label: session.displayName ?? session.key,
        data: session as unknown as Record<string, unknown>,
      })),
    },
    {
      id: "group:instances",
      label: "Instances",
      kind: "instance",
      items: input.presenceEntries.map((entry) => ({
        id: `instance:${String(entry.instanceId ?? entry.host ?? "instance")}`,
        label: String(entry.host ?? entry.instanceId ?? "Instance"),
        status: entry.lastInputSeconds != null && entry.lastInputSeconds <= 90 ? "online" : undefined,
        data: entry as unknown as Record<string, unknown>,
      })),
    },
    {
      id: "group:cron",
      label: "Cron Jobs",
      kind: "cron",
      items: input.cronJobs.map((job) => ({
        id: `cron:${job.id}`,
        label: job.name,
        status: job.enabled ? "enabled" : "disabled",
        data: job as unknown as Record<string, unknown>,
      })),
    },
    {
      id: "group:skills",
      label: "Skills",
      kind: "skill",
      items: (input.skillsReport?.skills ?? []).map((skill) => ({
        id: `skill:${skill.skillKey}`,
        label: skill.name,
        status: skill.disabled
          ? "disabled"
          : skill.eligible
            ? "eligible"
            : "blocked",
        data: skill as unknown as Record<string, unknown>,
      })),
    },
    {
      id: "group:channels",
      label: "Channels",
      kind: "channel",
      items: (input.channels?.channelOrder ?? []).map((channelId) => ({
        id: `channel:${channelId}`,
        label: input.channels?.channelLabels?.[channelId] ?? channelId,
        data: (input.channels?.channels?.[channelId] as Record<string, unknown> | undefined) ?? {
          id: channelId,
        },
      })),
    },
  ];

  const groupCenters: number[] = [];
  for (const group of groupConfigs) {
    const groupStartY = cursorY;
    const itemCenters: number[] = [];
    const items = group.items.length > 0 ? group.items : [];
    for (const item of items) {
      const itemNode: GraphNode = {
        id: item.id,
        kind: group.kind,
        label: item.label,
        status: item.status,
        x: PLAN_COLUMNS.task,
        y: cursorY,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        data: item.data,
      };
      nodes.push(itemNode);
      edges.push({ id: `${group.id}->${item.id}`, from: group.id, to: item.id });
      itemCenters.push(itemNode.y + NODE_HEIGHT / 2);
      cursorY += NODE_HEIGHT + ROW_GAP;
    }

    const groupCenter =
      average(itemCenters) ??
      (groupStartY + (NODE_HEIGHT / 2));
    const groupNode: GraphNode = {
      id: group.id,
      kind: "group",
      label: group.label,
      x: PLAN_COLUMNS.phase,
      y: groupCenter - NODE_HEIGHT / 2,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
    nodes.push(groupNode);
    edges.push({ id: `${gatewayId}->${group.id}`, from: gatewayId, to: group.id });
    groupCenters.push(groupCenter);

    cursorY = Math.max(cursorY, groupStartY + NODE_HEIGHT + ROW_GAP);
    cursorY += GROUP_GAP;
  }

  const gatewayCenter = average(groupCenters) ?? NODE_HEIGHT / 2;
  nodes.push({
    id: gatewayId,
    kind: "gateway",
    label: "Gateway",
    x: PLAN_COLUMNS.goal,
    y: gatewayCenter - NODE_HEIGHT / 2,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  });

  return finalizeLayout(nodes, edges);
}

export function fitGraphViewport(
  bounds: GraphBounds,
  width: number,
  height: number,
  padding = 24,
): GraphViewport {
  const usableWidth = Math.max(width - padding * 2, 1);
  const usableHeight = Math.max(height - padding * 2, 1);
  const scaleX = usableWidth / Math.max(bounds.width, 1);
  const scaleY = usableHeight / Math.max(bounds.height, 1);
  const scale = clampScale(Math.min(scaleX, scaleY, 1));
  const offsetX = padding + (usableWidth - bounds.width * scale) / 2;
  const offsetY = padding + (usableHeight - bounds.height * scale) / 2;
  return { scale, offsetX, offsetY };
}

export function zoomGraphViewport(
  viewport: GraphViewport,
  nextScale: number,
  originX: number,
  originY: number,
): GraphViewport {
  const scale = clampScale(nextScale);
  const worldX = (originX - viewport.offsetX) / viewport.scale;
  const worldY = (originY - viewport.offsetY) / viewport.scale;
  return {
    scale,
    offsetX: originX - worldX * scale,
    offsetY: originY - worldY * scale,
  };
}

function clampScale(value: number) {
  return Math.min(2.5, Math.max(0.4, value));
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function finalizeLayout(nodes: GraphNode[], edges: GraphEdge[]): GraphLayout {
  const bounds = computeGraphBounds(nodes);
  return { nodes, edges, bounds };
}

function computeGraphBounds(nodes: GraphNode[]): GraphBounds {
  if (nodes.length === 0) return { width: NODE_WIDTH, height: NODE_HEIGHT };
  const maxX = Math.max(...nodes.map((node) => node.x + node.width));
  const maxY = Math.max(...nodes.map((node) => node.y + node.height));
  return { width: maxX + ROW_GAP, height: maxY + ROW_GAP };
}

function emptyLayout(): GraphLayout {
  return {
    nodes: [],
    edges: [],
    bounds: { width: NODE_WIDTH, height: NODE_HEIGHT },
  };
}
