// @ts-expect-error - echarts doesn't have proper ESM types
import * as echarts from "echarts";
import { html, nothing, type TemplateResult } from "lit";
import type {
  AgentDelegationMetrics,
  AgentHierarchyNode,
  AgentHierarchyResult,
  AgentHierarchyUsage,
  CollaborationEdge,
} from "../types.ts";
import { formatAgo } from "../format.ts";
import { icons } from "../icons.ts";
import { renderEmptyState } from "../render-utils.ts";

/* ═══════════════════════════════════════════════════════════════
   Public API
   ═══════════════════════════════════════════════════════════════ */

export type AgentsHierarchyProps = {
  loading: boolean;
  error: string | null;
  data: AgentHierarchyResult | null;
  focusAgentId?: string;
  onRefresh: () => void;
  onNodeClick?: (sessionKey: string) => void;
};

/* ═══════════════════════════════════════════════════════════════
   Internal types
   ═══════════════════════════════════════════════════════════════ */

type NodeMeta = {
  sessionKey: string;
  runId?: string;
  agentId?: string;
  agentRole?: string;
  model?: string;
  task?: string;
  status: string;
  startedAt?: number;
  endedAt?: number;
  usage?: AgentHierarchyUsage;
  delegations?: AgentDelegationMetrics;
};

type GraphNodeData = {
  id: string;
  name: string;
  symbolSize: number;
  value: number;
  category: number;
  fixed?: boolean;
  x?: number;
  y?: number;
  itemStyle?: Record<string, unknown>;
  label?: Record<string, unknown>;
  _meta?: NodeMeta;
};

type GraphLinkData = {
  source: string;
  target: string;
  lineStyle?: Record<string, unknown>;
  label?: Record<string, unknown>;
};

type GraphData = {
  nodes: GraphNodeData[];
  links: GraphLinkData[];
  categories: { name: string; itemStyle: { color: string } }[];
};

/* ═══════════════════════════════════════════════════════════════
   Constants
   ═══════════════════════════════════════════════════════════════ */

const STATUS_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  running: { bg: "#3b82f6", border: "#2563eb", text: "#ffffff" },
  completed: { bg: "#22c55e", border: "#16a34a", text: "#ffffff" },
  error: { bg: "#ef4444", border: "#dc2626", text: "#ffffff" },
  pending: { bg: "#6b7280", border: "#4b5563", text: "#ffffff" },
  idle: { bg: "#374151", border: "#1f2937", text: "#9ca3af" },
};

const ROLE_COLORS: Record<string, { bg: string; text: string }> = {
  orchestrator: { bg: "#7c3aed", text: "#ffffff" },
  lead: { bg: "#2563eb", text: "#ffffff" },
  specialist: { bg: "#0891b2", text: "#ffffff" },
  worker: { bg: "#6b7280", text: "#ffffff" },
};

/** Categories for the ECharts legend — one per role. */
const ROLE_CATEGORIES = [
  { name: "orchestrator", itemStyle: { color: "#7c3aed" } },
  { name: "lead", itemStyle: { color: "#2563eb" } },
  { name: "specialist", itemStyle: { color: "#0891b2" } },
  { name: "worker", itemStyle: { color: "#6b7280" } },
];

const ROLE_CATEGORY_INDEX: Record<string, number> = {
  orchestrator: 0,
  lead: 1,
  specialist: 2,
  worker: 3,
};

const NODE_SIZE_BY_ROLE: Record<string, number> = {
  orchestrator: 14,
  lead: 11,
  specialist: 9,
  worker: 7,
};

/** Deterministic color palette keyed by agentId hash. */
const AGENT_PALETTE = [
  "#7c3aed",
  "#2563eb",
  "#0891b2",
  "#059669",
  "#d97706",
  "#dc2626",
  "#db2777",
  "#7c2d12",
  "#4f46e5",
  "#0d9488",
  "#ea580c",
  "#9333ea",
  "#0284c7",
  "#65a30d",
  "#e11d48",
];

/** Edge styling for collaboration/delegation types. */
const EDGE_STYLES: Record<string, { color: string; type: string; width: number }> = {
  // Hierarchy
  delegation: { color: "rgba(245, 158, 11, 0.7)", type: "solid", width: 2 },
  request: { color: "rgba(168, 85, 247, 0.5)", type: "dashed", width: 1.5 },
  approval: { color: "rgba(34, 197, 94, 0.6)", type: "solid", width: 2 },
  rejection: { color: "rgba(239, 68, 68, 0.5)", type: "dashed", width: 1.5 },
  // Collaboration
  proposal: { color: "rgba(124, 58, 237, 0.5)", type: "dashed", width: 1.5 },
  challenge: { color: "rgba(239, 68, 68, 0.5)", type: "dashed", width: 1.5 },
  agreement: { color: "rgba(34, 197, 94, 0.5)", type: "dashed", width: 1.5 },
  decision: { color: "rgba(245, 158, 11, 0.5)", type: "dashed", width: 1.5 },
  clarification: { color: "rgba(59, 130, 246, 0.4)", type: "dashed", width: 1 },
};

const DEFAULT_EDGE_STYLE = { color: "rgba(161, 161, 170, 0.3)", type: "solid", width: 1 };

/* ═══════════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════════ */

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function getAgentColor(agentId: string | undefined): string {
  if (!agentId) {
    return "#6b7280";
  }
  return AGENT_PALETTE[hashString(agentId) % AGENT_PALETTE.length];
}

function computeNodeSize(node: AgentHierarchyNode): number {
  const roleBase = NODE_SIZE_BY_ROLE[node.agentRole ?? "worker"] ?? 7;
  let total = node.interactionCount ?? 0;
  if (node.usage) {
    total += node.usage.toolCalls;
    total += Math.floor((node.usage.inputTokens + node.usage.outputTokens) / 5_000);
  }
  if (node.delegations) {
    total += (node.delegations.sent + node.delegations.received) * 2;
  }
  // Running nodes get a minimum boost so they're visually distinct
  const runningBoost = node.status === "running" ? 6 : 0;
  // Scale grows more aggressively — nodes visibly grow with activity
  const scale = total > 0 ? Math.min(36, Math.log2(total + 1) * 5) : 0;
  return roleBase + scale + runningBoost;
}

/** Compute a value weight for the node (used for sizing + tooltip). */
function computeNodeValue(node: AgentHierarchyNode): number {
  let total = node.interactionCount ?? 0;
  if (node.usage) {
    total += node.usage.toolCalls;
    total += Math.floor((node.usage.inputTokens + node.usage.outputTokens) / 10_000);
  }
  if (node.delegations) {
    total += node.delegations.sent + node.delegations.received;
  }
  return total;
}

/*
 * Chart height is driven by CSS `calc(100vh - 220px)` on the container,
 * filling available viewport space and responding to window resize.
 */

function computeRepulsion(nodeCount: number): number {
  if (nodeCount <= 5) {
    return 120;
  }
  if (nodeCount <= 15) {
    return 250;
  }
  if (nodeCount <= 30) {
    return 400;
  }
  return 550;
}

function computeEdgeLength(nodeCount: number): number {
  if (nodeCount <= 5) {
    return 80;
  }
  if (nodeCount <= 15) {
    return 120;
  }
  if (nodeCount <= 30) {
    return 180;
  }
  return 220;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M `;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K `;
  }
  return `${tokens} `;
}

function formatDurationMs(ms: number): string {
  if (ms >= 60_000) {
    return `${(ms / 60_000).toFixed(1)}m`;
  }
  if (ms >= 1_000) {
    return `${(ms / 1_000).toFixed(1)}s`;
  }
  return `${ms}ms`;
}

function extractAgentName(sessionKey: string): string {
  const parts = sessionKey.split(":");
  if (parts.length >= 4 && parts[2] === "subagent") {
    return `Subagent ${parts[3].slice(0, 8)}`;
  }
  if (parts.length >= 3) {
    const agentId = parts[1];
    const role = parts[2];
    if (role === "main") {
      return agentId ? `Agent: ${agentId}` : "Main Agent";
    }
    return role;
  }
  if (parts.length >= 2) {
    return parts[1] || sessionKey.slice(0, 20);
  }
  return sessionKey.slice(0, 20);
}

/* ═══════════════════════════════════════════════════════════════
   Focus filter — extract subtree for a specific agent
   ═══════════════════════════════════════════════════════════════ */

/**
 * Collect all agentIds present in a hierarchy subtree (node + descendants).
 */
function collectAgentIds(node: AgentHierarchyNode, out: Set<string>) {
  if (node.agentId) {
    out.add(node.agentId);
  }
  for (const child of node.children) {
    collectAgentIds(child, out);
  }
}

/**
 * Find and extract the subtree rooted at `focusAgentId`.
 * Returns the matching node(s) as new roots, or the original roots if not found.
 */
function filterRootsForAgent(
  roots: AgentHierarchyNode[],
  focusAgentId: string,
): AgentHierarchyNode[] {
  const found: AgentHierarchyNode[] = [];

  function search(nodes: AgentHierarchyNode[]) {
    for (const node of nodes) {
      if (node.agentId === focusAgentId) {
        found.push(node);
      } else {
        search(node.children);
      }
    }
  }
  search(roots);

  return found;
}

/**
 * Filter collaboration edges to only those involving visible agentIds.
 */
function filterEdgesForAgents(
  edges: CollaborationEdge[],
  visibleAgentIds: Set<string>,
): CollaborationEdge[] {
  return edges.filter((e) => visibleAgentIds.has(e.source) || visibleAgentIds.has(e.target));
}

/* ═══════════════════════════════════════════════════════════════
   Data transformation — tree → flat graph {nodes, links, categories}

   KEY FIX: The collaboration edges from the backend use agentId
   as source/target, but graph nodes are keyed by sessionKey.
   We build an agentId→sessionKey map during traversal to resolve
   collaboration edges correctly.
   ═══════════════════════════════════════════════════════════════ */

function isPrimaryAgentSessionKey(sessionKey: string): boolean {
  // Canonical long-lived agent session (preferred anchor for agentId-based edges)
  // e.g. agent:backend-architect:main
  return /^agent:[^:]+:main$/.test(sessionKey);
}

function transformToGraphData(
  roots: AgentHierarchyNode[],
  collaborationEdges?: CollaborationEdge[],
): GraphData {
  const nodes: GraphNodeData[] = [];
  const links: GraphLinkData[] = [];
  const nodeIdSet = new Set<string>();

  // Map agentId → sessionKey for collaboration edge resolution
  const agentIdToSessionKey = new Map<string, string>();

  function traverse(node: AgentHierarchyNode, parentKey?: string) {
    // Deduplicate: a node may appear in multiple paths
    if (nodeIdSet.has(node.sessionKey)) {
      return;
    }
    nodeIdSet.add(node.sessionKey);

    const label = node.label || extractAgentName(node.sessionKey);
    const role = node.agentRole ?? "worker";
    const symbolSize = computeNodeSize(node);
    const isRunning = node.status === "running";
    const agentColor = getAgentColor(node.agentId);

    if (node.agentId) {
      const current = agentIdToSessionKey.get(node.agentId);
      if (!current) {
        agentIdToSessionKey.set(node.agentId, node.sessionKey);
      } else {
        // Keep deterministic, stable mapping:
        // prefer canonical "agent:{id}:main" over transient subagent sessions.
        const currentIsPrimary = isPrimaryAgentSessionKey(current);
        const nextIsPrimary = isPrimaryAgentSessionKey(node.sessionKey);
        if (!currentIsPrimary && nextIsPrimary) {
          agentIdToSessionKey.set(node.agentId, node.sessionKey);
        }
      }
    }

    nodes.push({
      id: node.sessionKey,
      name: label,
      symbolSize,
      value: computeNodeValue(node),
      category: ROLE_CATEGORY_INDEX[role] ?? 3,
      itemStyle: {
        color: agentColor,
        borderColor: isRunning ? "#fff" : "transparent",
        borderWidth: isRunning ? 2 : 0,
        shadowBlur: isRunning ? 12 : 0,
        shadowColor: isRunning ? agentColor : "transparent",
      },
      _meta: {
        sessionKey: node.sessionKey,
        runId: node.runId,
        agentId: node.agentId,
        agentRole: node.agentRole,
        model: node.model,
        task: node.task,
        status: node.status,
        startedAt: node.startedAt,
        endedAt: node.endedAt,
        usage: node.usage,
        delegations: node.delegations,
      },
    });

    // Parent→child spawn link (structural hierarchy)
    if (parentKey) {
      links.push({
        source: parentKey,
        target: node.sessionKey,
        lineStyle: {
          color: "rgba(161, 161, 170, 0.5)",
          width: 1.5,
          type: "solid",
          curveness: 0.2,
        },
      });
    }

    for (const child of node.children) {
      traverse(child, node.sessionKey);
    }
  }

  for (const root of roots) {
    traverse(root);
  }

  // Resolve and add collaboration/delegation edges
  if (collaborationEdges && collaborationEdges.length > 0) {
    const seen = new Set<string>();
    for (const collab of collaborationEdges) {
      // Resolve agentId → sessionKey
      const sourceSession = agentIdToSessionKey.get(collab.source);
      const targetSession = agentIdToSessionKey.get(collab.target);

      // Skip unresolvable or self-referencing edges
      if (!sourceSession || !targetSession) {
        continue;
      }
      if (sourceSession === targetSession) {
        continue;
      }

      // Verify both nodes actually exist in the graph
      if (!nodeIdSet.has(sourceSession) || !nodeIdSet.has(targetSession)) {
        continue;
      }

      // Deduplicate by direction + type
      const pairKey = `${sourceSession}→${targetSession}:${collab.type}`;
      if (seen.has(pairKey)) {
        continue;
      }
      seen.add(pairKey);

      const style = EDGE_STYLES[collab.type] ?? DEFAULT_EDGE_STYLE;

      links.push({
        source: sourceSession,
        target: targetSession,
        lineStyle: {
          color: style.color,
          width: style.width,
          type: style.type,
          curveness: 0.3,
        },
      });
    }
  }

  return { nodes, links, categories: ROLE_CATEGORIES };
}

/* ═══════════════════════════════════════════════════════════════
   Statistics helpers
   ═══════════════════════════════════════════════════════════════ */

function countTotalNodes(nodes: AgentHierarchyNode[]): number {
  let count = nodes.length;
  for (const node of nodes) {
    if (node.children.length > 0) {
      count += countTotalNodes(node.children);
    }
  }
  return count;
}

function countByStatus(nodes: AgentHierarchyNode[]): Record<string, number> {
  const counts: Record<string, number> = {
    running: 0,
    completed: 0,
    error: 0,
    pending: 0,
    idle: 0,
  };
  function traverse(n: AgentHierarchyNode[]) {
    for (const node of n) {
      counts[node.status] = (counts[node.status] ?? 0) + 1;
      if (node.children.length > 0) {
        traverse(node.children);
      }
    }
  }
  traverse(nodes);
  return counts;
}

/* ═══════════════════════════════════════════════════════════════
   Tooltip formatter
   ═══════════════════════════════════════════════════════════════ */

function tooltipFormatter(params: { data?: GraphNodeData; dataType?: string }): string {
  if (params.dataType === "edge") {
    return "";
  }
  const meta = params.data?._meta;
  if (!meta) {
    return params.data?.name ?? "";
  }

  const statusColors = STATUS_COLORS[meta.status] ?? STATUS_COLORS.pending;
  const roleLabel = meta.agentRole
    ? `<span style="display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;background:${ROLE_COLORS[meta.agentRole]?.bg ?? "#6b7280"};color:${ROLE_COLORS[meta.agentRole]?.text ?? "#fff"};">${meta.agentRole}</span>`
    : "";
  const usageLines = meta.usage
    ? `<div style="margin-top:4px;font-size:11px;color:#aaa;">Tokens: ${formatTokenCount(meta.usage.inputTokens)}in / ${formatTokenCount(meta.usage.outputTokens)}out<br/>Tools: ${meta.usage.toolCalls} | Duration: ${formatDurationMs(meta.usage.durationMs)}${meta.usage.costUsd > 0 ? `<br/>Cost: $${meta.usage.costUsd.toFixed(4)}` : ""}</div>`
    : "";
  const delegLines = meta.delegations
    ? `<div style="margin-top:4px;font-size:11px;color:#aaa;">Delegations: ${meta.delegations.sent} sent / ${meta.delegations.received} received${meta.delegations.pending > 0 ? ` | ${meta.delegations.pending} pending` : ""}</div>`
    : "";

  const modelLine = meta.model
    ? `<div style="margin-top:4px;font-size:11px;color:#93c5fd;">Model: ${meta.model}</div>`
    : "";

  return `<div style="max-width:350px;">
    <strong>${params.data?.name ?? ""}</strong> ${roleLabel}<br/>
    <span style="display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;background:${statusColors.bg};color:${statusColors.text};">${meta.status}</span>
    ${meta.task ? `<div style="margin-top:4px;font-size:12px;color:#ccc;">${meta.task.slice(0, 120)}</div>` : ""}
    ${modelLine}
    ${usageLines}
    ${delegLines}
    <div style="margin-top:4px;font-size:10px;color:#666;">${meta.sessionKey}</div>
  </div>`;
}

/* ═══════════════════════════════════════════════════════════════
   Lit template: main render
   ═══════════════════════════════════════════════════════════════ */

export function renderAgentsHierarchy(props: AgentsHierarchyProps) {
  const { loading, error, data, focusAgentId, onRefresh, onNodeClick } = props;

  // Apply focus filter: show only the selected agent's subtree + relevant edges
  let roots = data?.roots ?? [];
  let collabEdges = data?.collaborationEdges ?? [];
  if (focusAgentId && roots.length > 0) {
    roots = filterRootsForAgent(roots, focusAgentId);
    const visibleIds = new Set<string>();
    for (const r of roots) {
      collectAgentIds(r, visibleIds);
    }
    collabEdges = filterEdgesForAgents(collabEdges, visibleIds);
  }

  const totalNodes = countTotalNodes(roots);
  const statusCounts = countByStatus(roots);
  const updatedAt = data?.updatedAt ?? null;

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Agent Hierarchy</div>
          <div class="card-sub">
            ${focusAgentId ? html`Interactions for <span class="mono">${focusAgentId}</span>.` : "Visualize agent-subagent spawn relationships."}
            ${totalNodes > 0 ? html` <span class="mono">${totalNodes}</span> nodes` : nothing}
          </div>
        </div>
        <button class="btn btn--sm" ?disabled=${loading} @click=${onRefresh}>
          ${loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      ${
        updatedAt
          ? html`<div class="muted" style="margin-top: 8px; font-size: 11px;">
            Last updated: ${formatAgo(updatedAt)}
          </div>`
          : nothing
      }

      ${error ? html`<div class="callout danger" style="margin-top: 12px;">${error}</div>` : nothing}

      ${
        roots.length > 0
          ? html`
            <div class="hierarchy-stats" style="margin-top: 16px; display: flex; gap: 12px; flex-wrap: wrap;">
              <div class="hierarchy-stat">
                <span class="hierarchy-stat-dot" style="background: ${STATUS_COLORS.running.bg};"></span>
                <span>Running: ${statusCounts.running}</span>
              </div>
              <div class="hierarchy-stat">
                <span class="hierarchy-stat-dot" style="background: ${STATUS_COLORS.completed.bg};"></span>
                <span>Completed: ${statusCounts.completed}</span>
              </div>
              <div class="hierarchy-stat">
                <span class="hierarchy-stat-dot" style="background: ${STATUS_COLORS.error.bg};"></span>
                <span>Error: ${statusCounts.error}</span>
              </div>
              <div class="hierarchy-stat">
                <span class="hierarchy-stat-dot" style="background: ${STATUS_COLORS.pending.bg};"></span>
                <span>Pending: ${statusCounts.pending}</span>
              </div>
              <div class="hierarchy-stat">
                <span class="hierarchy-stat-dot" style="background: ${STATUS_COLORS.idle.bg};"></span>
                <span>Idle: ${statusCounts.idle}</span>
              </div>
            </div>
          `
          : nothing
      }

      ${
        roots.length === 0
          ? html`
            <div style="margin-top: 16px;">
              ${renderEmptyState({
                icon: icons.link,
                title: "No hierarchy data",
                subtitle: loading
                  ? "Loading hierarchy..."
                  : "Spawn subagents to see their relationships here.",
              })}
            </div>
          `
          : html`
            <div
              class="hierarchy-chart-container"
              id="hierarchy-echarts-container"
              style="margin-top: 8px; min-height: 400px; height: calc(100vh - 220px); transition: height 0.3s ease;"
            >
              ${renderHierarchyTree(roots, onNodeClick)}
            </div>
            ${renderGraphLegend()}
            ${scheduleEChartsInit(roots, collabEdges, onNodeClick)}
          `
      }
    </section>
  `;
}

/* ═══════════════════════════════════════════════════════════════
   Lit template: graph legend
   ═══════════════════════════════════════════════════════════════ */

function renderGraphLegend() {
  const legendStyle =
    "display: flex; flex-wrap: wrap; gap: 16px; margin-top: 12px; padding: 12px 16px; border-radius: 8px; background: rgba(0,0,0,0.03); font-size: 11px; color: #71717a;";
  const groupStyle = "display: flex; align-items: center; gap: 6px;";
  const sectionStyle = "display: flex; flex-wrap: wrap; gap: 10px; align-items: center;";
  const labelStyle = "font-weight: 600; color: #a1a1aa; margin-right: 2px;";

  return html`
    <div style=${legendStyle}>
      <div style=${sectionStyle}>
        <span style=${labelStyle}>Roles:</span>
        ${ROLE_CATEGORIES.map(
          (cat) => html`
            <div style=${groupStyle}>
              <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${cat.itemStyle.color};"></span>
              <span>${cat.name}</span>
            </div>
          `,
        )}
      </div>
      <span style="color:#e4e4e7;">|</span>
      <div style=${sectionStyle}>
        <span style=${labelStyle}>Status:</span>
        <div style=${groupStyle}>
          <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#3b82f6;box-shadow:0 0 6px #3b82f6;border:1.5px solid #fff;"></span>
          <span>running</span>
        </div>
        <div style=${groupStyle}>
          <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#22c55e;"></span>
          <span>completed</span>
        </div>
        <div style=${groupStyle}>
          <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#ef4444;"></span>
          <span>error</span>
        </div>
        <div style=${groupStyle}>
          <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#374151;border:1px solid #4b5563;"></span>
          <span>idle</span>
        </div>
      </div>
      <span style="color:#e4e4e7;">|</span>
      <div style=${sectionStyle}>
        <span style=${labelStyle}>Edges:</span>
        <div style=${groupStyle}>
          <span style="display:inline-block;width:20px;height:0;border-top:2px solid rgba(245,158,11,0.7);"></span>
          <span>delegation</span>
        </div>
        <div style=${groupStyle}>
          <span style="display:inline-block;width:20px;height:0;border-top:2px solid rgba(34,197,94,0.6);"></span>
          <span>approval</span>
        </div>
        <div style=${groupStyle}>
          <span style="display:inline-block;width:20px;height:0;border-top:2px dashed rgba(124,58,237,0.5);"></span>
          <span>proposal</span>
        </div>
        <div style=${groupStyle}>
          <span style="display:inline-block;width:20px;height:0;border-top:2px dashed rgba(239,68,68,0.5);"></span>
          <span>challenge</span>
        </div>
        <div style=${groupStyle}>
          <span style="display:inline-block;width:20px;height:0;border-top:1.5px solid rgba(161,161,170,0.5);"></span>
          <span>spawn</span>
        </div>
      </div>
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════
   Lit template: tree fallback / detail list
   ═══════════════════════════════════════════════════════════════ */

function renderHierarchyTree(
  nodes: AgentHierarchyNode[],
  onNodeClick?: (sessionKey: string) => void,
  depth = 0,
): TemplateResult | typeof nothing {
  if (nodes.length === 0) {
    return nothing;
  }

  return html`
    <div class="hierarchy-tree" style="padding-left: ${depth * 24}px;">
      ${nodes.map((node): TemplateResult => {
        const colors = STATUS_COLORS[node.status] ?? STATUS_COLORS.pending;
        const label = node.label || extractAgentName(node.sessionKey);
        const hasChildren = node.children.length > 0;
        const roleColor = node.agentRole ? ROLE_COLORS[node.agentRole] : undefined;
        const usage = node.usage;

        return html`
          <div class="hierarchy-node" data-status=${node.status}>
            <button
              class="hierarchy-node-header"
              style="--node-color: ${colors.bg}; --node-border: ${colors.border};"
              data-status=${node.status}
              @click=${() => onNodeClick?.(node.sessionKey)}
              type="button"
            >
              <span
                class="hierarchy-node-indicator"
                style="background: ${colors.bg};"
                data-status=${node.status}
              ></span>
              <div class="hierarchy-node-content">
                <div class="hierarchy-node-label">
                  ${label}
                  ${
                    node.agentRole
                      ? html`<span
                        class="hierarchy-role-badge"
                        style="background: ${roleColor?.bg ?? "#6b7280"}; color: ${roleColor?.text ?? "#fff"};"
                      >${node.agentRole}</span>`
                      : nothing
                  }
                </div>
                <div class="hierarchy-node-meta">
                  <span class="hierarchy-node-status">${node.status}</span>
                  ${node.task ? html`<span class="hierarchy-node-task">${node.task.slice(0, 60)}${node.task.length > 60 ? "..." : ""}</span>` : nothing}
                  ${node.startedAt ? html`<span class="hierarchy-node-time">Started ${formatAgo(node.startedAt)}</span>` : nothing}
                </div>
                ${
                  usage
                    ? html`<div class="hierarchy-node-usage">
                      <span class="hierarchy-usage-item" title="Input / Output tokens">${formatTokenCount(usage.inputTokens)}in / ${formatTokenCount(usage.outputTokens)}out</span>
                      <span class="hierarchy-usage-item" title="Tool calls">Tools: ${usage.toolCalls}</span>
                      <span class="hierarchy-usage-item" title="Duration">${formatDurationMs(usage.durationMs)}</span>
                      ${usage.costUsd > 0 ? html`<span class="hierarchy-usage-item" title="Cost">$${usage.costUsd.toFixed(4)}</span>` : nothing}
                    </div>`
                    : nothing
                }
              </div>
              ${
                hasChildren
                  ? html`
                      <span class="hierarchy-node-expand">▼</span>
                    `
                  : nothing
              }
            </button>
            ${hasChildren ? renderHierarchyTree(node.children, onNodeClick, depth + 1) : nothing}
          </div>
        `;
      })}
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════
   ECharts lifecycle management

   Simplified approach inspired by the ECharts "graph-label-overlap"
   example: use `layout: "force"` with `links` (not `edges`),
   `labelLayout.hideOverlap`, and minimal setOption calls.

   KEY FIXES:
   1. Use `links` property (canonical) instead of `edges` alias
   2. Properly resolve agentId→sessionKey for collaboration edges
   3. Removed phantom sibling-inference edges
   4. Reduced pulse timer from 100ms to 500ms to avoid force restarts
   5. Differential updates: topology change → full re-init;
      visual-only change → in-place node update without restarting force
   ═══════════════════════════════════════════════════════════════ */

// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
let chartInstance: echarts.ECharts | null = null;
let lastDataHash = "";
let lastTopologyHash = "";
let pulseTimer: ReturnType<typeof setInterval> | null = null;
let _resizeObserver: ResizeObserver | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let lockedPositions: Map<string, { x: number; y: number }> | null = null;
let currentGraphData: GraphData | null = null;

/** Topology hash: node keys + parent-child structure. */
function computeTopologyHash(roots: AgentHierarchyNode[]): string {
  const keys: string[] = [];
  function collect(nodes: AgentHierarchyNode[], parentKey?: string) {
    for (const node of nodes) {
      keys.push(node.sessionKey);
      if (parentKey) {
        keys.push(`${parentKey}→${node.sessionKey}`);
      }
      if (node.children.length > 0) {
        collect(node.children, node.sessionKey);
      }
    }
  }
  collect(roots);
  return keys.join("|");
}

/** Full data hash: status, usage, interactions. */
function computeDataHash(roots: AgentHierarchyNode[]): string {
  const parts: string[] = [];
  function collect(nodes: AgentHierarchyNode[]) {
    for (const node of nodes) {
      parts.push(node.sessionKey, node.status, node.agentRole ?? "");
      if (node.usage) {
        parts.push(`${node.usage.inputTokens}:${node.usage.outputTokens}:${node.usage.toolCalls}`);
      }
      if (node.delegations) {
        parts.push(
          `d:${node.delegations.sent}:${node.delegations.received}:${node.delegations.pending}`,
        );
      }
      if (node.interactionCount) {
        parts.push(`ic:${node.interactionCount}`);
      }
      if (node.children.length > 0) {
        collect(node.children);
      }
    }
  }
  collect(roots);
  return parts.join("|");
}

function cleanupChart() {
  if (pulseTimer) {
    clearInterval(pulseTimer);
    pulseTimer = null;
  }
  if (settleTimer) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
  if (_resizeObserver) {
    _resizeObserver.disconnect();
    _resizeObserver = null;
  }
  lockedPositions = null;
  currentGraphData = null;
}

function scheduleEChartsInit(
  roots: AgentHierarchyNode[],
  collabEdges: CollaborationEdge[],
  onNodeClick?: (sessionKey: string) => void,
): typeof nothing {
  requestAnimationFrame(() => {
    const container = document.getElementById("hierarchy-echarts-container");
    if (!container) {
      return;
    }

    const newDataHash = computeDataHash(roots);
    const newTopoHash = computeTopologyHash(roots);

    // Check existing chart
    const existingChart = echarts.getInstanceByDom(container);
    if (existingChart && chartInstance === existingChart && lastDataHash === newDataHash) {
      return; // Nothing changed
    }

    const graphData = transformToGraphData(roots, collabEdges);

    if (existingChart && chartInstance === existingChart) {
      // Chart exists — decide: topology change or visual-only?
      lastDataHash = newDataHash;

      if (newTopoHash !== lastTopologyHash) {
        // Topology changed → re-init. Pin existing nodes at locked positions,
        // only new nodes will be placed by force.
        lastTopologyHash = newTopoHash;
        const savedPositions = lockedPositions;
        cleanupChart();
        if (savedPositions && savedPositions.size > 0) {
          for (const node of graphData.nodes) {
            const pos = savedPositions.get(node.id);
            if (pos) {
              node.x = pos.x;
              node.y = pos.y;
              node.fixed = true;
            }
          }
        }
        initECharts(container, graphData, onNodeClick);
      } else {
        // Visual-only change (status/usage) → do NOT call setOption (it restarts force).
        // Just update the shared graphData reference; the pulse timer picks it up.
        currentGraphData = graphData;
      }
      return;
    }

    // No chart yet → initialize
    cleanupChart();
    initECharts(container, graphData, onNodeClick);
    lastDataHash = newDataHash;
    lastTopologyHash = newTopoHash;
  });

  return nothing;
}

function initECharts(
  container: HTMLElement,
  graphData: GraphData,
  onNodeClick?: (sessionKey: string) => void,
) {
  // Dispose existing
  const existing = echarts.getInstanceByDom(container);
  if (existing) {
    existing.dispose();
  }

  const nodeCount = graphData.nodes.length;
  const chartWidth = container.clientWidth || 800;
  const chartHeight = container.clientHeight || 500;

  chartInstance = echarts.init(container, undefined, {
    renderer: "canvas",
    width: chartWidth,
    height: chartHeight,
  });

  const option = {
    tooltip: {
      trigger: "item" as const,
      triggerOn: "mousemove" as const,
      formatter: tooltipFormatter,
    },
    legend: { show: false },
    series: [
      {
        type: "graph",
        layout: "force",
        data: graphData.nodes,
        links: graphData.links,
        categories: graphData.categories,
        roam: true,
        draggable: true,
        label: {
          show: true,
          position: "right" as const,
          formatter: "{b}",
        },
        labelLayout: {
          hideOverlap: true,
        },
        center: ["50%", "50%"],
        force: {
          repulsion: computeRepulsion(nodeCount),
          gravity: 0.15,
          edgeLength: computeEdgeLength(nodeCount),
          friction: 0.85,
        },
        lineStyle: {
          color: "source",
          curveness: 0.3,
        },
        scaleLimit: {
          min: 0.4,
          max: 2,
        },
      },
    ],
  };

  chartInstance.setOption(option);

  // Click handler
  if (onNodeClick) {
    chartInstance.on("click", (params: unknown) => {
      const p = params as { data?: GraphNodeData };
      const meta = p.data?._meta;
      if (meta?.sessionKey) {
        onNodeClick(meta.sessionKey);
      }
    });
  }

  // Resize observer
  _resizeObserver = new ResizeObserver(() => chartInstance?.resize());
  _resizeObserver.observe(container);

  // Wait for force to converge, then lock positions and start pulse animation.
  // Do NOT start pulse timer immediately — setOption during force causes jitter.
  currentGraphData = graphData;
  schedulePositionLock();
}

/**
 * After force converges (~3s), capture all node positions and lock them.
 * Then start the gentle pulse animation.
 */
function schedulePositionLock() {
  if (settleTimer) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
  if (pulseTimer) {
    clearInterval(pulseTimer);
    pulseTimer = null;
  }
  lockedPositions = null;

  settleTimer = setTimeout(() => {
    settleTimer = null;
    if (!chartInstance) {
      return;
    }

    // Extract settled positions from the chart
    const opt = chartInstance.getOption() as {
      series?: { data?: { id?: string; x?: number; y?: number }[] }[];
    };
    const data = opt?.series?.[0]?.data;
    if (!Array.isArray(data)) {
      return;
    }

    lockedPositions = new Map();
    for (const n of data) {
      if (n.id && typeof n.x === "number" && typeof n.y === "number") {
        lockedPositions.set(n.id, { x: n.x, y: n.y });
      }
    }

    startPulseTimer();
  }, 3000);
}

/**
 * Pulse animation for running nodes and active edges.
 * - Running nodes: pulsating shadow glow around the avatar
 * - Edges between two running nodes: highlighted with animated opacity
 * ALL nodes are pinned to lockedPositions to prevent force restarts from moving them.
 */
function startPulseTimer() {
  if (pulseTimer) {
    clearInterval(pulseTimer);
    pulseTimer = null;
  }
  if (!lockedPositions || lockedPositions.size === 0) {
    return;
  }

  let phase = 0;
  pulseTimer = setInterval(() => {
    if (!chartInstance || !lockedPositions) {
      if (pulseTimer) {
        clearInterval(pulseTimer);
        pulseTimer = null;
      }
      return;
    }

    const gd = currentGraphData;
    if (!gd) {
      return;
    }

    phase = (phase + 1) % 24;
    const t = (phase / 24) * Math.PI * 2;
    // Shadow intensity oscillates between 2 and 24 for a pronounced breathing pulse
    const shadowIntensity = 13 + Math.sin(t) * 11;
    // Border width oscillates between 1.5 and 3
    const borderWidth = 2.25 + Math.sin(t) * 0.75;

    // Collect running node IDs for edge highlighting
    const runningNodeIds = new Set<string>();
    for (const n of gd.nodes) {
      if (n._meta?.status === "running") {
        runningNodeIds.add(n.id);
      }
    }

    const updatedNodes = gd.nodes.map((n) => {
      const pos = lockedPositions?.get(n.id);
      const base = pos ? { ...n, fixed: true, x: pos.x, y: pos.y } : n;
      if (n._meta?.status !== "running") {
        return base;
      }
      const c = getAgentColor(n._meta?.agentId);
      return {
        ...base,
        itemStyle: {
          color: c,
          borderColor: "#fff",
          borderWidth,
          shadowBlur: shadowIntensity,
          shadowColor: c,
        },
      };
    });

    // Highlight edges between two running nodes
    const edgeOpacity = 0.6 + Math.sin(t) * 0.3;
    const updatedLinks = gd.links.map((link) => {
      const srcRunning = runningNodeIds.has(link.source);
      const tgtRunning = runningNodeIds.has(link.target);
      if (srcRunning && tgtRunning) {
        return {
          ...link,
          lineStyle: {
            ...link.lineStyle,
            color: "rgba(59, 130, 246, 0.8)",
            width: 2.5 + Math.sin(t) * 0.5,
            opacity: edgeOpacity,
          },
        };
      }
      return link;
    });

    chartInstance.setOption({ series: [{ data: updatedNodes, links: updatedLinks }] });
  }, 400);
}
