import { html, nothing } from "lit";
import type { AgentsListResult } from "../types.ts";
import { icons } from "../icons.ts";

export type BroadcastProps = {
  agentsList: AgentsListResult | null;
  loading: boolean;
  error: string | null;
  message: string;
  selectedAgentIds: Set<string>;
  selectedTeam: string | null;
  results: BroadcastResult[];
  onMessageChange: (message: string) => void;
  onAgentToggle: (agentId: string) => void;
  onTeamSelect: (team: string | null) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onSend: () => void;
};

export type BroadcastResult = {
  agentId: string;
  agentName: string;
  ok: boolean;
  error?: string;
  duration: number;
  timestamp: number;
};

function groupAgentsByTeam(agents: AgentsListResult["agents"]): Map<string, typeof agents> {
  const teams = new Map<string, typeof agents>();
  
  for (const agent of agents) {
    let teamName = "default";
    
    if (agent.id.includes("-")) {
      const parts = agent.id.split("-");
      if (parts.length > 1) {
        teamName = parts[0];
      }
    }
    
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
    default: "All Agents",
  };
  return labels[teamName] || teamName.charAt(0).toUpperCase() + teamName.slice(1);
}

export function renderBroadcast(props: BroadcastProps) {
  const agents = props.agentsList?.agents ?? [];
  const teams = groupAgentsByTeam(agents);
  const teamNames = Array.from(teams.keys()).sort();
  
  // Filter agents by selected team
  const filteredAgents = props.selectedTeam
    ? teams.get(props.selectedTeam) ?? []
    : agents;

  const selectedCount = props.selectedAgentIds.size;
  const totalCount = filteredAgents.length;
  const allSelected = selectedCount === totalCount && totalCount > 0;

  return html`
    <section class="card">
      <div class="broadcast-header">
        <h2 class="page-title">Broadcast</h2>
        <p class="page-sub">Sende Nachrichten an mehrere Agents gleichzeitig</p>
      </div>

      ${props.error
        ? html`<div class="callout danger" style="margin-top: 16px;">${props.error}</div>`
        : nothing}

      <div class="broadcast-content" style="margin-top: 24px; display: flex; flex-direction: column; gap: 20px;">
        <!-- Team Selection -->
        <div class="field">
          <label class="field__label">Team auswählen</label>
          <div class="broadcast-team-chips">
            <button
              class="broadcast-team-chip ${props.selectedTeam === null ? "broadcast-team-chip--active" : ""}"
              @click=${() => props.onTeamSelect(null)}
            >
              Alle Teams
            </button>
            ${teamNames.map((teamName) => {
              const teamAgents = teams.get(teamName) ?? [];
              return html`
                <button
                  class="broadcast-team-chip ${props.selectedTeam === teamName ? "broadcast-team-chip--active" : ""}"
                  @click=${() => props.onTeamSelect(teamName)}
                >
                  ${normalizeTeamLabel(teamName)}
                  <span class="broadcast-team-chip__count">${teamAgents.length}</span>
                </button>
              `;
            })}
          </div>
        </div>

        <!-- Agent Selection -->
        <div class="field">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
            <label class="field__label">Empfänger</label>
            <div style="display: flex; gap: 8px;">
              <button
                class="btn btn--sm"
                @click=${props.onSelectAll}
                ?disabled=${allSelected || filteredAgents.length === 0}
              >
                Alle auswählen
              </button>
              <button
                class="btn btn--sm"
                @click=${props.onDeselectAll}
                ?disabled={selectedCount === 0}
              >
                Alle abwählen
              </button>
            </div>
          </div>
          <div class="broadcast-agents-grid">
            ${filteredAgents.map((agent) => {
              const isSelected = props.selectedAgentIds.has(agent.id);
              return html`
                <label class="broadcast-agent-card ${isSelected ? "broadcast-agent-card--selected" : ""}">
                  <input
                    type="checkbox"
                    .checked=${isSelected}
                    @change=${() => props.onAgentToggle(agent.id)}
                    style="position: absolute; opacity: 0; pointer-events: none;"
                  />
                  <div class="broadcast-agent-card__avatar">
                    ${agent.identity?.avatar || agent.identity?.avatarUrl
                      ? html`<img src="${agent.identity.avatar || agent.identity.avatarUrl}" alt="${agent.name || agent.id}" />`
                      : html`<div class="broadcast-agent-card__avatar-placeholder">${(agent.name || agent.id).charAt(0).toUpperCase()}</div>`}
                  </div>
                  <div class="broadcast-agent-card__info">
                    <div class="broadcast-agent-card__name">${agent.name || agent.id}</div>
                    <div class="broadcast-agent-card__id">${agent.id}</div>
                  </div>
                  ${isSelected
                    ? html`<div class="broadcast-agent-card__check">${icons.check}</div>`
                    : nothing}
                </label>
              `;
            })}
          </div>
          <div class="muted" style="margin-top: 8px; font-size: 12px;">
            ${selectedCount} von ${totalCount} Agents ausgewählt
          </div>
        </div>

        <!-- Message Input -->
        <div class="field">
          <label class="field__label">Nachricht</label>
          <textarea
            class="broadcast-message-input"
            .value=${props.message}
            @input=${(e: Event) => props.onMessageChange((e.target as HTMLTextAreaElement).value)}
            placeholder="Nachricht eingeben..."
            rows="6"
            style="width: 100%; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg); color: var(--text); font-family: var(--font-body); font-size: 14px; resize: vertical;"
          ></textarea>
          <div class="muted" style="margin-top: 4px; font-size: 12px;">
            ${props.message.length} Zeichen
          </div>
        </div>

        <!-- Preview -->
        ${selectedCount > 0 && props.message.trim()
          ? html`
              <div class="broadcast-preview">
                <div class="broadcast-preview__header">
                  <span class="broadcast-preview__title">Vorschau</span>
                  <span class="broadcast-preview__count">${selectedCount} Empfänger</span>
                </div>
                <div class="broadcast-preview__recipients">
                  ${Array.from(props.selectedAgentIds).map((agentId) => {
                    const agent = agents.find((a) => a.id === agentId);
                    return html`
                      <span class="broadcast-preview__recipient">${agent?.name || agentId}</span>
                    `;
                  })}
                </div>
              </div>
            `
          : nothing}

        <!-- Send Button -->
        <div style="display: flex; gap: 12px; align-items: center;">
          <button
            class="btn btn--primary"
            @click=${props.onSend}
            ?disabled=${props.loading || selectedCount === 0 || !props.message.trim()}
          >
            ${props.loading ? "Sende..." : `Senden an ${selectedCount} Agent${selectedCount !== 1 ? "s" : ""}`}
          </button>
        </div>

        <!-- Results -->
        ${props.results.length > 0
          ? html`
              <div class="broadcast-results">
                <div class="broadcast-results__header">
                  <span class="broadcast-results__title">Ergebnisse</span>
                  <span class="broadcast-results__summary">
                    ${props.results.filter((r) => r.ok).length} erfolgreich,
                    ${props.results.filter((r) => !r.ok).length} fehlgeschlagen
                  </span>
                </div>
                <div class="broadcast-results__table">
                  <table style="width: 100%; border-collapse: collapse;">
                    <thead>
                      <tr style="border-bottom: 1px solid var(--border);">
                        <th style="text-align: left; padding: 8px; font-size: 12px; font-weight: 600; color: var(--muted);">Agent</th>
                        <th style="text-align: left; padding: 8px; font-size: 12px; font-weight: 600; color: var(--muted);">Status</th>
                        <th style="text-align: right; padding: 8px; font-size: 12px; font-weight: 600; color: var(--muted);">Dauer</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${props.results.map((result) => html`
                        <tr style="border-bottom: 1px solid var(--border);">
                          <td style="padding: 10px 8px; font-size: 13px;">
                            <div style="display: flex; align-items: center; gap: 8px;">
                              <div class="broadcast-result-status ${result.ok ? "broadcast-result-status--success" : "broadcast-result-status--error"}"></div>
                              <span>${result.agentName}</span>
                            </div>
                          </td>
                          <td style="padding: 10px 8px; font-size: 13px;">
                            ${result.ok
                              ? html`<span style="color: var(--ok);">✓ Erfolgreich</span>`
                              : html`<span style="color: var(--danger);">✗ ${result.error || "Fehler"}</span>`}
                          </td>
                          <td style="padding: 10px 8px; font-size: 13px; text-align: right; color: var(--muted);">
                            ${result.duration}ms
                          </td>
                        </tr>
                      `)}
                    </tbody>
                  </table>
                </div>
              </div>
            `
          : nothing}
      </div>
    </section>
  `;
}
