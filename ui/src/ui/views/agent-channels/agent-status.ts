/**
 * Agent status badge component for multi-agent chat UI.
 * Shows online/offline status and role indicators.
 */

import {
  getAgentColor,
  getStatusColor,
  getRoleIcon,
  getListeningModeIcon,
} from "./agent-colors.js";

export type AgentStatusInfo = {
  agentId: string;
  displayName: string;
  status: "active" | "busy" | "away" | "offline";
  role: "owner" | "admin" | "member" | "observer";
  listeningMode: "active" | "mention-only" | "observer" | "coordinator";
  customStatus?: string;
  avatarUrl?: string;
};

/**
 * Render agent status badge as HTML.
 */
export function renderAgentStatus(
  agent: AgentStatusInfo,
  size: "small" | "medium" | "large" = "medium",
): string {
  const color = getAgentColor(agent.agentId);
  const statusColor = getStatusColor(agent.status);
  const roleIcon = getRoleIcon(agent.role);
  const modeIcon = getListeningModeIcon(agent.listeningMode);
  const initial = agent.displayName.charAt(0).toUpperCase();

  const sizeClass = `agent-status-${size}`;

  return `
    <div class="agent-status ${sizeClass}" data-agent-id="${escapeHtml(agent.agentId)}">
      <div class="agent-avatar" style="background: ${color}">
        ${
          agent.avatarUrl
            ? `<img src="${escapeHtml(agent.avatarUrl)}" alt="${escapeHtml(agent.displayName)}" />`
            : `<span class="avatar-initial">${initial}</span>`
        }
        <span class="status-dot" style="background: ${statusColor}"></span>
      </div>
      <div class="agent-info">
        <span class="agent-name">
          ${roleIcon ? `<span class="role-icon">${roleIcon}</span>` : ""}
          ${escapeHtml(agent.displayName)}
        </span>
        ${agent.customStatus ? `<span class="custom-status">${escapeHtml(agent.customStatus)}</span>` : ""}
      </div>
      ${
        size === "large"
          ? `
        <div class="agent-badges">
          <span class="mode-badge" title="${agent.listeningMode}">${modeIcon}</span>
        </div>
      `
          : ""
      }
    </div>
  `;
}

/**
 * Render a list of agents with their status.
 */
export function renderAgentList(agents: AgentStatusInfo[]): string {
  // Sort: online first, then by role
  const sorted = [...agents].toSorted((a, b) => {
    const statusOrder = { active: 0, busy: 1, away: 2, offline: 3 };
    const roleOrder = { owner: 0, admin: 1, member: 2, observer: 3 };

    const statusDiff = statusOrder[a.status] - statusOrder[b.status];
    if (statusDiff !== 0) {
      return statusDiff;
    }

    return roleOrder[a.role] - roleOrder[b.role];
  });

  // Group by status
  const online = sorted.filter((a) => a.status !== "offline");
  const offline = sorted.filter((a) => a.status === "offline");

  let html = `<div class="agent-list">`;

  if (online.length > 0) {
    html += `
      <div class="agent-group">
        <div class="group-header">Online — ${online.length}</div>
        ${online.map((a) => renderAgentStatus(a, "medium")).join("")}
      </div>
    `;
  }

  if (offline.length > 0) {
    html += `
      <div class="agent-group collapsed">
        <div class="group-header">Offline — ${offline.length}</div>
        ${offline.map((a) => renderAgentStatus(a, "medium")).join("")}
      </div>
    `;
  }

  html += `</div>`;
  return html;
}

/**
 * Get status text description.
 */
export function getStatusText(status: AgentStatusInfo["status"]): string {
  switch (status) {
    case "active":
      return "Active";
    case "busy":
      return "Busy";
    case "away":
      return "Away";
    case "offline":
      return "Offline";
    default:
      return "Unknown";
  }
}

/**
 * Get CSS styles for agent status component.
 */
export function getAgentStatusStyles(): string {
  return `
    .agent-status {
      display: flex;
      align-items: center;
      padding: 6px 8px;
      border-radius: 4px;
      cursor: pointer;
    }

    .agent-status:hover {
      background: var(--bg-hover, #f0f0f0);
    }

    .agent-status-small {
      padding: 4px 6px;
    }

    .agent-status-large {
      padding: 8px 12px;
    }

    .agent-avatar {
      position: relative;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .agent-status-small .agent-avatar {
      width: 24px;
      height: 24px;
    }

    .agent-status-medium .agent-avatar {
      width: 32px;
      height: 32px;
    }

    .agent-status-large .agent-avatar {
      width: 40px;
      height: 40px;
    }

    .agent-avatar img {
      width: 100%;
      height: 100%;
      border-radius: 50%;
      object-fit: cover;
    }

    .avatar-initial {
      color: white;
      font-weight: 600;
    }

    .agent-status-small .avatar-initial {
      font-size: 10px;
    }

    .agent-status-medium .avatar-initial {
      font-size: 14px;
    }

    .agent-status-large .avatar-initial {
      font-size: 18px;
    }

    .status-dot {
      position: absolute;
      bottom: -2px;
      right: -2px;
      border-radius: 50%;
      border: 2px solid var(--bg-primary, white);
    }

    .agent-status-small .status-dot {
      width: 8px;
      height: 8px;
    }

    .agent-status-medium .status-dot {
      width: 10px;
      height: 10px;
    }

    .agent-status-large .status-dot {
      width: 12px;
      height: 12px;
    }

    .agent-info {
      margin-left: 8px;
      overflow: hidden;
      flex: 1;
    }

    .agent-name {
      display: flex;
      align-items: center;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .agent-status-small .agent-name {
      font-size: 12px;
    }

    .agent-status-medium .agent-name {
      font-size: 14px;
    }

    .agent-status-large .agent-name {
      font-size: 16px;
    }

    .role-icon {
      margin-right: 4px;
    }

    .custom-status {
      display: block;
      font-size: 12px;
      color: var(--text-secondary, #666);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .agent-badges {
      display: flex;
      gap: 4px;
      margin-left: auto;
    }

    .mode-badge {
      font-size: 14px;
    }

    .agent-list {
      display: flex;
      flex-direction: column;
    }

    .agent-list .agent-group {
      margin-bottom: 16px;
    }

    .agent-list .group-header {
      padding: 8px 12px;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-secondary, #666);
      text-transform: uppercase;
    }

    .agent-list .agent-group.collapsed .agent-status {
      display: none;
    }
  `;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
