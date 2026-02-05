/**
 * Channel sidebar component for multi-agent chat UI.
 * Shows list of channels with unread indicators and quick actions.
 */

export type ChannelListItem = {
  id: string;
  name: string;
  type: "public" | "private" | "dm" | "broadcast";
  unreadCount: number;
  hasUnreadMention: boolean;
  lastMessageAt?: number;
  memberCount: number;
  archived?: boolean;
};

export type ChannelGroup = {
  label: string;
  channels: ChannelListItem[];
  collapsed?: boolean;
};

export type ChannelSidebarState = {
  groups: ChannelGroup[];
  selectedChannelId?: string;
  searchQuery: string;
  showArchived: boolean;
};

/**
 * Get icon for channel type.
 */
export function getChannelIcon(type: ChannelListItem["type"]): string {
  switch (type) {
    case "public":
      return "#";
    case "private":
      return "🔒";
    case "dm":
      return "💬";
    case "broadcast":
      return "📢";
    default:
      return "#";
  }
}

/**
 * Format channel name for display.
 */
export function formatChannelName(channel: ChannelListItem): string {
  const icon = getChannelIcon(channel.type);
  return `${icon} ${channel.name}`;
}

/**
 * Group channels by type.
 */
export function groupChannelsByType(channels: ChannelListItem[]): ChannelGroup[] {
  const groups: ChannelGroup[] = [
    { label: "Channels", channels: [] },
    { label: "Direct Messages", channels: [] },
    { label: "Broadcasts", channels: [] },
  ];

  for (const channel of channels) {
    if (channel.archived) {
      continue;
    }

    switch (channel.type) {
      case "public":
      case "private":
        groups[0].channels.push(channel);
        break;
      case "dm":
        groups[1].channels.push(channel);
        break;
      case "broadcast":
        groups[2].channels.push(channel);
        break;
    }
  }

  // Sort channels within groups by last message
  for (const group of groups) {
    group.channels.sort((a, b) => {
      // Unread first
      if (a.unreadCount > 0 && b.unreadCount === 0) {
        return -1;
      }
      if (b.unreadCount > 0 && a.unreadCount === 0) {
        return 1;
      }

      // Then by last message
      const aTime = a.lastMessageAt ?? 0;
      const bTime = b.lastMessageAt ?? 0;
      return bTime - aTime;
    });
  }

  // Filter out empty groups
  return groups.filter((g) => g.channels.length > 0);
}

/**
 * Filter channels by search query.
 */
export function filterChannels(channels: ChannelListItem[], query: string): ChannelListItem[] {
  if (!query.trim()) {
    return channels;
  }

  const lowerQuery = query.toLowerCase();
  return channels.filter((c) => c.name.toLowerCase().includes(lowerQuery));
}

/**
 * Render channel sidebar as HTML.
 */
export function renderChannelSidebar(state: ChannelSidebarState): string {
  const filteredGroups = state.groups.map((group) => ({
    ...group,
    channels: filterChannels(group.channels, state.searchQuery),
  }));

  let html = `
    <div class="channel-sidebar">
      <div class="sidebar-header">
        <input
          type="text"
          class="channel-search"
          placeholder="Search channels..."
          value="${escapeHtml(state.searchQuery)}"
        />
      </div>
      <div class="channel-list">
  `;

  for (const group of filteredGroups) {
    if (group.channels.length === 0) {
      continue;
    }

    html += `
      <div class="channel-group${group.collapsed ? " collapsed" : ""}">
        <div class="group-header">
          <span class="group-toggle">${group.collapsed ? "▸" : "▾"}</span>
          <span class="group-label">${escapeHtml(group.label)}</span>
          <span class="group-count">(${group.channels.length})</span>
        </div>
        <ul class="group-channels">
    `;

    for (const channel of group.channels) {
      const isSelected = channel.id === state.selectedChannelId;
      const hasUnread = channel.unreadCount > 0;
      const hasMention = channel.hasUnreadMention;

      html += `
        <li
          class="channel-item${isSelected ? " selected" : ""}${hasUnread ? " unread" : ""}${hasMention ? " mention" : ""}"
          data-channel-id="${escapeHtml(channel.id)}"
        >
          <span class="channel-icon">${getChannelIcon(channel.type)}</span>
          <span class="channel-name">${escapeHtml(channel.name)}</span>
          ${hasUnread ? `<span class="unread-badge${hasMention ? " mention" : ""}">${channel.unreadCount}</span>` : ""}
        </li>
      `;
    }

    html += `
        </ul>
      </div>
    `;
  }

  html += `
      </div>
      <div class="sidebar-footer">
        <button class="create-channel-btn">+ Create Channel</button>
      </div>
    </div>
  `;

  return html;
}

/**
 * Get CSS styles for channel sidebar.
 */
export function getChannelSidebarStyles(): string {
  return `
    .channel-sidebar {
      display: flex;
      flex-direction: column;
      width: 240px;
      height: 100%;
      background: var(--bg-secondary, #f5f5f5);
      border-right: 1px solid var(--border-color, #e0e0e0);
    }

    .sidebar-header {
      padding: 12px;
      border-bottom: 1px solid var(--border-color, #e0e0e0);
    }

    .channel-search {
      width: 100%;
      padding: 8px 12px;
      border: 1px solid var(--border-color, #e0e0e0);
      border-radius: 4px;
      font-size: 14px;
    }

    .channel-list {
      flex: 1;
      overflow-y: auto;
    }

    .channel-group {
      margin-bottom: 8px;
    }

    .group-header {
      display: flex;
      align-items: center;
      padding: 8px 12px;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-secondary, #666);
      cursor: pointer;
      user-select: none;
    }

    .group-toggle {
      width: 16px;
      margin-right: 4px;
    }

    .group-count {
      margin-left: auto;
      opacity: 0.6;
    }

    .group-channels {
      list-style: none;
      margin: 0;
      padding: 0;
    }

    .channel-group.collapsed .group-channels {
      display: none;
    }

    .channel-item {
      display: flex;
      align-items: center;
      padding: 6px 12px 6px 24px;
      cursor: pointer;
      border-radius: 4px;
      margin: 2px 8px;
    }

    .channel-item:hover {
      background: var(--bg-hover, #e8e8e8);
    }

    .channel-item.selected {
      background: var(--bg-selected, #d0d0d0);
    }

    .channel-item.unread .channel-name {
      font-weight: 600;
    }

    .channel-icon {
      margin-right: 8px;
      opacity: 0.6;
    }

    .channel-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .unread-badge {
      min-width: 18px;
      height: 18px;
      padding: 0 6px;
      border-radius: 9px;
      background: var(--badge-bg, #666);
      color: white;
      font-size: 11px;
      font-weight: 600;
      text-align: center;
      line-height: 18px;
    }

    .unread-badge.mention {
      background: var(--accent-color, #ea580c);
    }

    .sidebar-footer {
      padding: 12px;
      border-top: 1px solid var(--border-color, #e0e0e0);
    }

    .create-channel-btn {
      width: 100%;
      padding: 8px;
      border: 1px dashed var(--border-color, #ccc);
      border-radius: 4px;
      background: transparent;
      color: var(--text-secondary, #666);
      cursor: pointer;
      font-size: 14px;
    }

    .create-channel-btn:hover {
      background: var(--bg-hover, #e8e8e8);
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
