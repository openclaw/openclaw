/**
 * Mention autocomplete component for multi-agent chat.
 * Shows dropdown when typing @mentions.
 */

import { getAgentColor } from "./agent-colors.js";

export type MentionOption = {
  type: "agent" | "broadcast";
  id: string;
  displayName: string;
  description?: string;
  status?: "active" | "busy" | "away" | "offline";
};

export type MentionAutocompleteState = {
  visible: boolean;
  query: string;
  options: MentionOption[];
  selectedIndex: number;
  position: { top: number; left: number };
};

// Built-in broadcast mentions
export const BROADCAST_OPTIONS: MentionOption[] = [
  {
    type: "broadcast",
    id: "all",
    displayName: "@all",
    description: "Notify everyone in the channel",
  },
  {
    type: "broadcast",
    id: "channel",
    displayName: "@channel",
    description: "Notify channel members",
  },
  { type: "broadcast", id: "here", displayName: "@here", description: "Notify active members" },
];

/**
 * Filter mention options based on query.
 */
export function filterMentionOptions(agents: MentionOption[], query: string): MentionOption[] {
  const lowerQuery = query.toLowerCase();

  // Always show broadcast options first
  const broadcastMatches = BROADCAST_OPTIONS.filter(
    (o) =>
      o.id.toLowerCase().includes(lowerQuery) || o.displayName.toLowerCase().includes(lowerQuery),
  );

  // Then filter agents
  const agentMatches = agents.filter(
    (o) =>
      o.id.toLowerCase().includes(lowerQuery) || o.displayName.toLowerCase().includes(lowerQuery),
  );

  // Sort by relevance
  agentMatches.sort((a, b) => {
    // Exact match first
    if (a.displayName.toLowerCase() === lowerQuery) {
      return -1;
    }
    if (b.displayName.toLowerCase() === lowerQuery) {
      return 1;
    }

    // Starts with query
    const aStarts = a.displayName.toLowerCase().startsWith(lowerQuery);
    const bStarts = b.displayName.toLowerCase().startsWith(lowerQuery);
    if (aStarts && !bStarts) {
      return -1;
    }
    if (bStarts && !aStarts) {
      return 1;
    }

    // Online before offline
    const statusOrder = { active: 0, busy: 1, away: 2, offline: 3, undefined: 4 };
    return (
      (statusOrder[a.status ?? "undefined"] ?? 4) - (statusOrder[b.status ?? "undefined"] ?? 4)
    );
  });

  return [...broadcastMatches, ...agentMatches];
}

/**
 * Extract mention query from cursor position in text.
 * Returns null if not in a mention context.
 */
export function extractMentionQuery(
  text: string,
  cursorPosition: number,
): {
  query: string;
  startIndex: number;
} | null {
  // Find the @ symbol before cursor
  let startIndex = cursorPosition - 1;
  while (startIndex >= 0) {
    const char = text[startIndex];
    if (char === "@") {
      const query = text.slice(startIndex + 1, cursorPosition);
      // Only valid if query doesn't contain spaces
      if (!query.includes(" ")) {
        return { query, startIndex };
      }
      return null;
    }
    if (char === " " || char === "\n") {
      return null;
    }
    startIndex--;
  }
  return null;
}

/**
 * Render mention autocomplete dropdown as HTML.
 */
export function renderMentionAutocomplete(state: MentionAutocompleteState): string {
  if (!state.visible || state.options.length === 0) {
    return "";
  }

  const items = state.options.map((option, index) => {
    const isSelected = index === state.selectedIndex;
    const color = option.type === "agent" ? getAgentColor(option.id) : "#666";
    const initial = option.displayName.charAt(0).replace("@", "").toUpperCase();

    let statusDot = "";
    if (option.status) {
      const statusColors: Record<string, string> = {
        active: "#22c55e",
        busy: "#ef4444",
        away: "#f59e0b",
        offline: "#6b7280",
      };
      statusDot = `<span class="status-dot" style="background: ${statusColors[option.status]}"></span>`;
    }

    return `
      <li
        class="mention-option${isSelected ? " selected" : ""}"
        data-index="${index}"
        data-id="${escapeHtml(option.id)}"
        data-type="${option.type}"
      >
        <div class="option-avatar" style="background: ${color}">
          <span>${initial}</span>
          ${statusDot}
        </div>
        <div class="option-info">
          <span class="option-name">${escapeHtml(option.displayName)}</span>
          ${option.description ? `<span class="option-desc">${escapeHtml(option.description)}</span>` : ""}
        </div>
      </li>
    `;
  });

  return `
    <ul class="mention-autocomplete" style="top: ${state.position.top}px; left: ${state.position.left}px;">
      ${items.join("")}
    </ul>
  `;
}

/**
 * Get CSS styles for mention autocomplete.
 */
export function getMentionAutocompleteStyles(): string {
  return `
    .mention-autocomplete {
      position: absolute;
      list-style: none;
      margin: 0;
      padding: 4px 0;
      background: var(--bg-primary, white);
      border: 1px solid var(--border-color, #e0e0e0);
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      max-height: 300px;
      overflow-y: auto;
      min-width: 200px;
      max-width: 320px;
      z-index: 1000;
    }

    .mention-option {
      display: flex;
      align-items: center;
      padding: 8px 12px;
      cursor: pointer;
      transition: background 0.1s;
    }

    .mention-option:hover,
    .mention-option.selected {
      background: var(--bg-hover, #f5f5f5);
    }

    .mention-option.selected {
      background: var(--bg-selected, #e8e8e8);
    }

    .option-avatar {
      position: relative;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .option-avatar span {
      color: white;
      font-size: 12px;
      font-weight: 600;
    }

    .option-avatar .status-dot {
      position: absolute;
      bottom: -1px;
      right: -1px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      border: 2px solid var(--bg-primary, white);
    }

    .option-info {
      margin-left: 8px;
      overflow: hidden;
      flex: 1;
    }

    .option-name {
      display: block;
      font-weight: 500;
      font-size: 14px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .option-desc {
      display: block;
      font-size: 12px;
      color: var(--text-secondary, #666);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `;
}

/**
 * Handle keyboard navigation in autocomplete.
 */
export function handleAutocompleteKeydown(
  state: MentionAutocompleteState,
  key: string,
): { newState: MentionAutocompleteState; selected?: MentionOption } {
  if (!state.visible) {
    return { newState: state };
  }

  switch (key) {
    case "ArrowDown":
      return {
        newState: {
          ...state,
          selectedIndex: Math.min(state.selectedIndex + 1, state.options.length - 1),
        },
      };

    case "ArrowUp":
      return {
        newState: {
          ...state,
          selectedIndex: Math.max(state.selectedIndex - 1, 0),
        },
      };

    case "Enter":
    case "Tab":
      return {
        newState: { ...state, visible: false },
        selected: state.options[state.selectedIndex],
      };

    case "Escape":
      return {
        newState: { ...state, visible: false },
      };

    default:
      return { newState: state };
  }
}

/**
 * Format a selected mention for insertion.
 */
export function formatMentionForInsertion(option: MentionOption): string {
  if (option.type === "broadcast") {
    return `@${option.id} `;
  }
  return `@agent:${option.id} `;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
