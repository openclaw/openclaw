import { html, nothing, type TemplateResult } from "lit";
import type {
  SwarmSnapshot,
  SwarmHierarchy,
  SwarmAgentNode,
  SwarmGroup,
} from "../controllers/swarm.ts";
import { formatAgo } from "../format.ts";

export type SwarmViewProps = {
  loading: boolean;
  error: string | null;
  snapshot: SwarmSnapshot | null;
  hierarchy: SwarmHierarchy | null;
  onRefresh: () => void;
};

function statusDot(status: string) {
  const colors: Record<string, string> = {
    active: "#10b981",
    working: "#10b981",
    idle: "#f59e0b",
    archived: "#6b7280",
    running: "#10b981",
    done: "#10b981",
    failed: "#ef4444",
    cancelled: "#6b7280",
    pending: "#94a3b8",
  };
  const color = colors[status] ?? "#94a3b8";
  const pulse = status === "active" || status === "working" || status === "running";
  return html`<span
    style="
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: ${color};
      ${pulse ? "animation: pulse 2s infinite;" : ""}
      margin-right: 6px;
      flex-shrink: 0;
    "
  ></span>`;
}

function trustBar(score: number) {
  const pct = Math.round(score * 100);
  const color = pct >= 80 ? "#10b981" : pct >= 60 ? "#f59e0b" : "#ef4444";
  return html`
    <div
      style="
      height: 6px;
      background: var(--bg-hover, #242442);
      border-radius: 3px;
      overflow: hidden;
      margin-top: 4px;
      width: 100px;
    "
    >
      <div
        style="
        height: 100%;
        width: ${pct}%;
        background: ${color};
        border-radius: 3px;
      "
      ></div>
    </div>
  `;
}

function renderAgentNode(node: SwarmAgentNode, depth = 0): TemplateResult {
  const indent = depth * 24;
  return html`
    <div style="margin-left: ${indent}px; margin-bottom: 8px;">
      <div
        class="card"
        style="
        padding: 12px 16px;
        display: flex;
        align-items: center;
        gap: 12px;
        ${node.status === "working" ? "border-left: 3px solid #10b981;" : ""}
        ${node.status === "archived" ? "opacity: 0.5;" : ""}
      "
      >
        <div
          style="
          width: 40px;
          height: 40px;
          border-radius: 50%;
          background: var(--bg-hover, #242442);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 1.3rem;
          flex-shrink: 0;
        "
        >
          ${node.emoji ?? "🤖"}
        </div>
        <div style="flex: 1; min-width: 0;">
          <div style="display: flex; align-items: center; gap: 6px;">
            ${statusDot(node.status)}
            <strong>${node.name}</strong>
            <span class="pill" style="font-size: 0.7rem;">${node.level} ${node.role}</span>
          </div>
          ${
            node.currentTask
              ? html`<div class="muted" style="font-size: 0.8rem; margin-top: 2px;">
                Working on: ${node.currentTask}
              </div>`
              : node.specialty
                ? html`<div class="muted" style="font-size: 0.8rem; margin-top: 2px;">
                  ${node.specialty}
                </div>`
                : nothing
          }
          <div style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
            <span style="font-size: 0.75rem; color: var(--text-muted, #94a3b8);"
              >Trust: ${(node.trustScore * 100).toFixed(0)}%</span
            >
            ${trustBar(node.trustScore)}
          </div>
        </div>
      </div>
      ${node.children.map((child) => renderAgentNode(child, depth + 1))}
    </div>
  `;
}

function workerStatusBadge(status: string) {
  const styles: Record<string, string> = {
    running: "background: #065f46; color: #6ee7b7;",
    done: "background: #064e3b; color: #a7f3d0;",
    failed: "background: #7f1d1d; color: #fca5a5;",
    cancelled: "background: #374151; color: #9ca3af;",
    pending: "background: #1e293b; color: #94a3b8;",
  };
  return html`<span
    class="pill"
    style="font-size: 0.7rem; ${styles[status] ?? styles.pending}"
    >${status}</span
  >`;
}

function renderSwarmGroup(group: SwarmGroup) {
  const running = group.workers.filter((w) => w.status === "running").length;
  const done = group.workers.filter((w) => w.status === "done").length;
  const total = group.workers.length;

  return html`
    <div class="card" style="margin-bottom: 12px;">
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <div>
          <strong>🐝 Swarm: ${group.id}</strong>
          <span class="muted" style="margin-left: 8px; font-size: 0.85rem;"
            >${group.repo} @ ${group.baseBranch}</span
          >
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          ${workerStatusBadge(group.status)}
          <span class="muted" style="font-size: 0.8rem;"
            >${done}/${total} done ${running > 0 ? `· ${running} running` : ""}</span
          >
        </div>
      </div>

      <div style="margin-top: 12px; display: grid; gap: 6px;">
        ${group.workers.map(
          (worker) => html`
            <div
              style="
              display: flex;
              align-items: center;
              gap: 8px;
              padding: 8px 12px;
              background: var(--bg-hover, #1a1a2e);
              border-radius: 6px;
            "
            >
              ${statusDot(worker.status)}
              <span style="flex: 1; font-size: 0.9rem;">${worker.name}</span>
              ${
                worker.branch
                  ? html`<code style="font-size: 0.75rem;">${worker.branch}</code>`
                  : nothing
              }
              ${workerStatusBadge(worker.status)}
              ${
                worker.startedAt
                  ? html`<span class="muted" style="font-size: 0.75rem;"
                    >${formatAgo(new Date(worker.startedAt).getTime())}</span
                  >`
                  : nothing
              }
            </div>
          `,
        )}
      </div>
    </div>
  `;
}

export function renderSwarm(props: SwarmViewProps) {
  const hierarchy = props.hierarchy;
  const snapshot = props.snapshot;
  const lastUpdated = snapshot?.fetchedAt ? formatAgo(snapshot.fetchedAt) : "n/a";

  return html`
    <style>
      @keyframes pulse {
        0%,
        100% {
          opacity: 1;
        }
        50% {
          opacity: 0.4;
        }
      }
    </style>

    <div class="card">
      <div class="card-title">🏢 Agent Hierarchy</div>
      <div class="card-sub">
        Live view of the agent organization. Active workers pulse green; idle agents are amber.
      </div>
      <div style="margin-top: 8px; display: flex; align-items: center; gap: 12px;">
        <span class="muted">Updated ${lastUpdated}</span>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>Refresh</button>
      </div>
      ${
        props.error
          ? html`<div class="pill danger" style="margin-top: 12px">${props.error}</div>`
          : nothing
      }
    </div>

    ${
      hierarchy?.root
        ? html`<div style="margin-top: 16px;">${renderAgentNode(hierarchy.root)}</div>`
        : html`
            <div class="card" style="margin-top: 16px">
              <div class="muted">
                No agent profiles found. Create an <code>agents/</code> directory in your workspace to define
                agent identities.
              </div>
            </div>
          `
    }

    ${
      snapshot && snapshot.swarms.length > 0
        ? html`
          <div style="margin-top: 24px;">
            <div class="card">
              <div class="card-title">🐝 Active Swarms</div>
              <div class="card-sub">
                ${snapshot.totalWorkers} total workers · ${snapshot.activeWorkers} currently running
              </div>
            </div>
            <div style="margin-top: 12px;">
              ${snapshot.swarms.map((group) => renderSwarmGroup(group))}
            </div>
          </div>
        `
        : html`
            <div class="card" style="margin-top: 16px">
              <div class="muted">
                No active swarms. Swarms are created when the manager delegates parallel tasks to worker agents.
              </div>
            </div>
          `
    }
  `;
}
