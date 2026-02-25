import { html, nothing } from "lit";
import type { AgentsListResult } from "../types.ts";
import { icons } from "../icons.ts";

export type SidebarAgentsProps = {
  agentsList: AgentsListResult | null;
  selectedAgentId: string | null;
  collapsed: boolean;
  onSelectAgent: (agentId: string) => void;
};

// Gruppiere Agents nach Teams (vereinfacht: basierend auf ID-Präfix oder Name)
function groupAgentsByTeam(agents: AgentsListResult["agents"]): Map<string, typeof agents> {
  const teams = new Map<string, typeof agents>();
  
  for (const agent of agents) {
    // Vereinfachte Team-Erkennung: basierend auf ID-Präfix oder Name
    let teamName = "default";
    
    // Erkenne Team aus ID (z.B. "boss-main", "mujo-agent-1")
    if (agent.id.includes("-")) {
      const parts = agent.id.split("-");
      if (parts.length > 1) {
        teamName = parts[0];
      }
    }
    
    // Oder aus Name (z.B. "Boss Agent", "Mujo Assistant")
    if (agent.name) {
      const nameLower = agent.name.toLowerCase();
      if (nameLower.includes("boss")) teamName = "boss";
      else if (nameLower.includes("mujo")) teamName = "mujo";
      else if (nameLower.includes("calli")) teamName = "calli";
      else if (nameLower.includes("marki")) teamName = "marki";
      else if (nameLower.includes("arch")) teamName = "arch";
      else if (nameLower.includes("design")) teamName = "design";
    }
    
    if (!teams.has(teamName)) {
      teams.set(teamName, []);
    }
    teams.get(teamName)!.push(agent);
  }
  
  return teams;
}

function normalizeTeamLabel(teamName: string): string {
  const labels: Record<string, string> = {
    boss: "Boss",
    mujo: "Mujo",
    calli: "Calli",
    marki: "Marki",
    arch: "Architecture",
    design: "Design",
    default: "Agents",
  };
  return labels[teamName] || teamName.charAt(0).toUpperCase() + teamName.slice(1);
}

export function renderSidebarAgents(props: SidebarAgentsProps) {
  if (!props.agentsList || props.agentsList.agents.length === 0) {
    return nothing;
  }

  const { agents, defaultId } = props.agentsList;
  const teams = groupAgentsByTeam(agents);
  const selectedId = props.selectedAgentId ?? defaultId ?? agents[0]?.id ?? null;

  return html`
    <div class="sidebar-agents ${props.collapsed ? "sidebar-agents--collapsed" : ""}">
      ${props.collapsed
        ? html`
            <div class="sidebar-agents__header-collapsed">
              ${agents.map((agent) => {
                const isSelected = agent.id === selectedId;
                return html`
                  <button
                    class="sidebar-agent-item sidebar-agent-item--collapsed ${isSelected ? "sidebar-agent-item--active" : ""}"
                    @click=${() => props.onSelectAgent(agent.id)}
                    title="${agent.name || agent.id}"
                    aria-label="Select agent ${agent.name || agent.id}"
                  >
                    <div class="sidebar-agent-item__avatar-collapsed">
                      <div class="sidebar-agent-item__status-dot ${agent.id === defaultId ? "sidebar-agent-item__status-dot--online" : ""}"></div>
                    </div>
                  </button>
                `;
              })}
            </div>
          `
        : html`
            <div class="sidebar-agents__header">
              <span class="sidebar-agents__title">Agents</span>
            </div>
            <div class="sidebar-agents__list">
              ${Array.from(teams.entries()).map(([teamName, teamAgents]) => {
                const teamLabel = normalizeTeamLabel(teamName);
                return html`
                  <div class="sidebar-agents-team">
                    <div class="sidebar-agents-team__header">
                      <span class="sidebar-agents-team__label">${teamLabel}</span>
                      <span class="sidebar-agents-team__count">${teamAgents.length}</span>
                    </div>
                    <div class="sidebar-agents-team__items">
                      ${teamAgents.map((agent) => {
                        const isSelected = agent.id === selectedId;
                        const isDefault = agent.id === defaultId;
                        return html`
                          <button
                            class="sidebar-agent-item ${isSelected ? "sidebar-agent-item--active" : ""}"
                            @click=${() => props.onSelectAgent(agent.id)}
                            title="${agent.name || agent.id}"
                            aria-label="Select agent ${agent.name || agent.id}"
                          >
                            <div class="sidebar-agent-item__avatar">
                              ${agent.identity?.avatar || agent.identity?.avatarUrl
                                ? html`<img src="${agent.identity.avatar || agent.identity.avatarUrl}" alt="${agent.name || agent.id}" class="sidebar-agent-item__avatar-img" />`
                                : html`<div class="sidebar-agent-item__avatar-placeholder">${(agent.name || agent.id).charAt(0).toUpperCase()}</div>`}
                              <div class="sidebar-agent-item__status-dot ${isDefault ? "sidebar-agent-item__status-dot--online" : "sidebar-agent-item__status-dot--offline"}"></div>
                            </div>
                            <div class="sidebar-agent-item__info">
                              <span class="sidebar-agent-item__name">${agent.name || agent.id}</span>
                              ${isDefault ? html`<span class="sidebar-agent-item__badge">default</span>` : nothing}
                            </div>
                          </button>
                        `;
                      })}
                    </div>
                  </div>
                `;
              })}
            </div>
          `}
    </div>
  `;
}
