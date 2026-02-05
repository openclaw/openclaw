// @ts-expect-error - echarts doesn't have proper ESM types
import * as echarts from "echarts";
import { html, nothing, type TemplateResult } from "lit";
import type { AgentHierarchyNode, AgentHierarchyResult } from "../types.ts";
import { renderEmptyState } from "../app-render.helpers.ts";
import { formatAgo } from "../format.ts";
import { icons } from "../icons.ts";

export type AgentsHierarchyProps = {
  loading: boolean;
  error: string | null;
  data: AgentHierarchyResult | null;
  onRefresh: () => void;
  onNodeClick?: (sessionKey: string) => void;
};

type EChartsTreeNode = {
  name: string;
  value?: string;
  itemStyle?: {
    color?: string;
    borderColor?: string;
  };
  label?: {
    backgroundColor?: string;
    borderColor?: string;
    color?: string;
  };
  children?: EChartsTreeNode[];
  collapsed?: boolean;
  _meta?: {
    sessionKey: string;
    runId?: string;
    task?: string;
    status: string;
    startedAt?: number;
    endedAt?: number;
  };
};

const STATUS_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  running: { bg: "#3b82f6", border: "#2563eb", text: "#ffffff" },
  completed: { bg: "#22c55e", border: "#16a34a", text: "#ffffff" },
  error: { bg: "#ef4444", border: "#dc2626", text: "#ffffff" },
  pending: { bg: "#6b7280", border: "#4b5563", text: "#ffffff" },
};

function extractAgentName(sessionKey: string): string {
  // Extract a readable name from session key
  // Format: agent:<agentId>:main or agent:<agentId>:subagent:<uuid>
  const parts = sessionKey.split(":");
  if (parts.length >= 4 && parts[2] === "subagent") {
    // subagent - return "subagent" or a short uuid prefix
    const uuid = parts[3];
    return `Subagent ${uuid.slice(0, 8)}`;
  }
  if (parts.length >= 3) {
    // Main agent - return the agent ID
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

function transformToEChartsData(nodes: AgentHierarchyNode[]): EChartsTreeNode[] {
  return nodes.map((node) => {
    const colors = STATUS_COLORS[node.status] ?? STATUS_COLORS.pending;
    // Priority: explicit label > extracted agent name from sessionKey
    const label = node.label || extractAgentName(node.sessionKey);
    return {
      name: label,
      value: node.task?.slice(0, 50) || node.sessionKey,
      itemStyle: {
        color: colors.bg,
        borderColor: colors.border,
      },
      label: {
        backgroundColor: colors.bg,
        borderColor: colors.border,
        color: colors.text,
      },
      children: node.children.length > 0 ? transformToEChartsData(node.children) : undefined,
      collapsed: false,
      _meta: {
        sessionKey: node.sessionKey,
        runId: node.runId,
        task: node.task,
        status: node.status,
        startedAt: node.startedAt,
        endedAt: node.endedAt,
      },
    };
  });
}

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
  const counts: Record<string, number> = { running: 0, completed: 0, error: 0, pending: 0 };
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

export function renderAgentsHierarchy(props: AgentsHierarchyProps) {
  const { loading, error, data, onRefresh, onNodeClick } = props;
  const roots = data?.roots ?? [];
  const totalNodes = countTotalNodes(roots);
  const statusCounts = countByStatus(roots);
  const updatedAt = data?.updatedAt ?? null;

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Agent Hierarchy</div>
          <div class="card-sub">
            Visualize agent-subagent spawn relationships.
            ${totalNodes > 0 ? html`<span class="mono">${totalNodes}</span> nodes` : nothing}
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
                style="margin-top: 16px; min-height: 400px;"
                data-hierarchy=${JSON.stringify(transformToEChartsData(roots))}
              >
                ${renderHierarchyTree(roots, onNodeClick)}
              </div>
              ${scheduleEChartsInit(transformToEChartsData(roots), onNodeClick)}
            `
      }
    </section>
  `;
}

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
                <div class="hierarchy-node-label">${label}</div>
                <div class="hierarchy-node-meta">
                  <span class="hierarchy-node-status">${node.status}</span>
                  ${node.task ? html`<span class="hierarchy-node-task">${node.task.slice(0, 60)}${node.task.length > 60 ? "..." : ""}</span>` : nothing}
                  ${node.startedAt ? html`<span class="hierarchy-node-time">Started ${formatAgo(node.startedAt)}</span>` : nothing}
                </div>
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

// Track chart instance and last data hash to avoid unnecessary re-renders
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
let chartInstance: echarts.ECharts | null = null;
let lastDataHash = "";
let clickHandlerAttached = false;

function computeDataHash(data: EChartsTreeNode[]): string {
  // Simple hash based on node count and session keys
  const keys: string[] = [];
  function collect(nodes: EChartsTreeNode[]) {
    for (const node of nodes) {
      keys.push(node._meta?.sessionKey ?? node.name);
      keys.push(node._meta?.status ?? "");
      if (node.children) {
        collect(node.children);
      }
    }
  }
  collect(data);
  return keys.join("|");
}

function scheduleEChartsInit(
  data: EChartsTreeNode[],
  onNodeClick?: (sessionKey: string) => void,
): typeof nothing {
  // Schedule update after DOM is ready
  requestAnimationFrame(() => {
    const container = document.getElementById("hierarchy-echarts-container");
    if (!container) {
      return;
    }

    const newHash = computeDataHash(data);

    // Check if chart already exists and data hasn't changed
    const existingChart = echarts.getInstanceByDom(container);
    if (existingChart && chartInstance === existingChart && lastDataHash === newHash) {
      // No changes needed
      return;
    }

    // If chart exists but data changed, just update the data
    if (existingChart && chartInstance === existingChart) {
      lastDataHash = newHash;
      existingChart.setOption({
        series: [{ data }],
      });
      return;
    }

    // Initialize new chart
    initECharts(container, data, onNodeClick);
    lastDataHash = newHash;
  });

  return nothing;
}

function initECharts(
  container: HTMLElement,
  data: EChartsTreeNode[],
  onNodeClick?: (sessionKey: string) => void,
) {
  // Dispose existing chart if any
  const existingChart = echarts.getInstanceByDom(container);
  if (existingChart) {
    existingChart.dispose();
  }

  chartInstance = echarts.init(container, undefined, {
    renderer: "canvas",
    width: container.clientWidth || 800,
    height: Math.max(400, data.length * 80),
  });

  const option = {
    tooltip: {
      trigger: "item",
      triggerOn: "mousemove",
      formatter: (params: { data?: EChartsTreeNode }) => {
        const meta = params.data?._meta;
        if (!meta) {
          return params.data?.name ?? "";
        }
        return `
          <div style="max-width: 300px;">
            <strong>${params.data?.name}</strong><br/>
            <span>Status: ${meta.status}</span><br/>
            ${meta.task ? `<span>Task: ${meta.task.slice(0, 100)}</span><br/>` : ""}
            <span style="font-size: 10px; color: #888;">${meta.sessionKey}</span>
          </div>
        `;
      },
    },
    series: [
      {
        type: "tree",
        id: 0,
        name: "hierarchy",
        data,
        top: "10%",
        left: "8%",
        bottom: "22%",
        right: "20%",
        symbolSize: 7,
        edgeShape: "polyline",
        edgeForkPosition: "63%",
        initialTreeDepth: 3,
        lineStyle: {
          width: 2,
        },
        label: {
          backgroundColor: "#fff",
          position: "left",
          verticalAlign: "middle",
          align: "right",
          fontSize: 12,
          padding: [4, 8],
          borderRadius: 4,
        },
        leaves: {
          label: {
            position: "right",
            verticalAlign: "middle",
            align: "left",
          },
        },
        emphasis: {
          focus: "descendant",
        },
        expandAndCollapse: true,
        animationDuration: 550,
        animationDurationUpdate: 750,
      },
    ],
  };

  chartInstance.setOption(option);

  if (onNodeClick && !clickHandlerAttached) {
    clickHandlerAttached = true;
    chartInstance.on("click", (params: unknown) => {
      const p = params as { data?: EChartsTreeNode };
      const meta = p.data?._meta;
      if (meta?.sessionKey) {
        onNodeClick(meta.sessionKey);
      }
    });
  }

  const resizeObserver = new ResizeObserver(() => {
    chartInstance?.resize();
  });
  resizeObserver.observe(container);
}
