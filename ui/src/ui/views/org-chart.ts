import { html, nothing } from "lit";
import type { GatewayAgentRow, AgentsListResult } from "../types.ts";

export type OrgChartProps = {
  loading: boolean;
  error: string | null;
  agentsList: AgentsListResult | null;
  basePath: string;
  onRefresh: () => void;
};

type Department = {
  head: GatewayAgentRow;
  members: GatewayAgentRow[];
};

function buildDepartments(agents: GatewayAgentRow[]): { ceo: GatewayAgentRow | null; departments: Department[] } {
  const byId = new Map<string, GatewayAgentRow>();
  for (const a of agents) byId.set(a.id, a);

  let ceo: GatewayAgentRow | null = null;
  const childMap = new Map<string, GatewayAgentRow[]>();

  for (const agent of agents) {
    const parentId = agent.reportsTo;
    if (!parentId || !byId.has(parentId)) {
      ceo = agent;
    } else {
      if (!childMap.has(parentId)) childMap.set(parentId, []);
      childMap.get(parentId)!.push(agent);
    }
  }

  const deptHeads = ceo ? (childMap.get(ceo.id) ?? []) : [];
  const departments: Department[] = deptHeads.map((head) => ({
    head,
    members: childMap.get(head.id) ?? [],
  }));

  return { ceo, departments };
}

function photoUrl(agent: GatewayAgentRow, basePath: string): string {
  const name = agent.name || agent.identity?.name || agent.id;
  const base = basePath || "";
  return `${base}/agents/${name.toLowerCase().trim()}.png`;
}

function imgErrorFallback(e: Event) {
  const img = e.target as HTMLImageElement;
  img.style.display = "none";
  const fallback = img.nextElementSibling as HTMLElement;
  if (fallback) fallback.style.display = "flex";
}

function renderAgentCard(agent: GatewayAgentRow, basePath: string): unknown {
  const name = agent.name || agent.identity?.name || agent.id;
  const role = agent.role || "";

  return html`
    <div class="dept-agent-card">
      <img class="dept-agent-photo" src=${photoUrl(agent, basePath)} alt=${name} loading="lazy" @error=${imgErrorFallback} />
      <div class="dept-agent-fallback" style="display:none;">${name.slice(0, 1)}</div>
      <div class="dept-agent-info">
        <div class="dept-agent-name">${name}</div>
        ${role ? html`<div class="dept-agent-role">${role}</div>` : nothing}
      </div>
    </div>
  `;
}

function renderDepartmentCard(dept: Department, basePath: string): unknown {
  const headName = dept.head.name || dept.head.identity?.name || dept.head.id;
  const headRole = dept.head.role || "";
  const deptLabel = headRole || headName;

  return html`
    <div class="dept-card">
      <div class="dept-card-header">
        <img class="dept-head-photo" src=${photoUrl(dept.head, basePath)} alt=${headName} loading="lazy" @error=${imgErrorFallback} />
        <div class="dept-head-fallback" style="display:none;">${headName.slice(0, 1)}</div>
        <div class="dept-head-info">
          <div class="dept-head-name">${headName}</div>
          ${deptLabel !== headName ? html`<div class="dept-head-role">${deptLabel}</div>` : nothing}
        </div>
      </div>
      <div class="dept-agents-grid">
        ${dept.members.map((agent) => renderAgentCard(agent, basePath))}
      </div>
    </div>
  `;
}

export function renderOrgChart(props: OrgChartProps) {
  const agents = props.agentsList?.agents ?? [];
  const basePath = props.basePath || "";
  const { ceo, departments } = buildDepartments(agents);

  return html`
    <div class="org-chart-container">
      <section class="card">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="card-title">Organization Chart</div>
            <div class="card-sub">${agents.length} agents across ${departments.length} departments.</div>
          </div>
          <button class="btn btn--sm" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? "Loading..." : "Refresh"}
          </button>
        </div>
        ${props.error ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>` : nothing}
      </section>

      ${ceo
        ? html`
            <section class="card dept-ceo-card">
              <div class="dept-ceo-row">
                <img class="dept-ceo-photo" src=${photoUrl(ceo, basePath)} alt=${ceo.name || ceo.id} loading="lazy" @error=${imgErrorFallback} />
                <div class="dept-ceo-fallback" style="display:none;">${(ceo.name || ceo.id).slice(0, 1)}</div>
                <div>
                  <div class="card-title">${ceo.name || ceo.identity?.name || ceo.id}</div>
                  <div class="card-sub">${ceo.role || "Chief of Staff"}</div>
                </div>
                <span class="org-card-badge">CEO</span>
              </div>
            </section>
          `
        : nothing}

      ${agents.length === 0
        ? html`<section class="card"><div class="muted" style="padding: 24px;">No agents configured.</div></section>`
        : html`
            <div class="dept-grid">
              ${departments.map((dept) => renderDepartmentCard(dept, basePath))}
            </div>
          `}
    </div>
  `;
}
