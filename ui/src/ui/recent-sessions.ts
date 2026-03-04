/**
 * Recent sessions dropdown quick switcher
 * 
 * Features:
 * - Show last 5 sessions
 * - Pin favorite sessions
 * - Unread indicator
 * - Keyboard shortcut (Alt+S)
 */

import type { SessionsListResult } from "./types.ts";

export type RecentSession = {
  key: string;
  displayName: string;
  lastActive: number;
  pinned: boolean;
  unread: boolean;
  channel?: string;
};

const RECENT_SESSIONS_STORAGE_KEY = "openclaw:recentSessions";
const PINNED_SESSIONS_STORAGE_KEY = "openclaw:pinnedSessions";
const MAX_RECENT = 10;

/**
 * Get recent sessions from storage
 */
export function getRecentSessions(): string[] {
  try {
    const stored = localStorage.getItem(RECENT_SESSIONS_STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

/**
 * Add session to recent list
 */
export function addRecentSession(sessionKey: string): void {
  try {
    const recent = getRecentSessions();
    // Remove if already exists
    const filtered = recent.filter((k) => k !== sessionKey);
    // Add to front
    filtered.unshift(sessionKey);
    // Limit to MAX_RECENT
    const limited = filtered.slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_SESSIONS_STORAGE_KEY, JSON.stringify(limited));
  } catch {
    // Silent fail
  }
}

/**
 * Get pinned sessions
 */
export function getPinnedSessions(): string[] {
  try {
    const stored = localStorage.getItem(PINNED_SESSIONS_STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

/**
 * Pin a session
 */
export function pinSession(sessionKey: string): void {
  try {
    const pinned = getPinnedSessions();
    if (!pinned.includes(sessionKey)) {
      pinned.push(sessionKey);
      localStorage.setItem(PINNED_SESSIONS_STORAGE_KEY, JSON.stringify(pinned));
    }
  } catch {
    // Silent fail
  }
}

/**
 * Unpin a session
 */
export function unpinSession(sessionKey: string): void {
  try {
    const pinned = getPinnedSessions();
    const filtered = pinned.filter((k) => k !== sessionKey);
    localStorage.setItem(PINNED_SESSIONS_STORAGE_KEY, JSON.stringify(filtered));
  } catch {
    // Silent fail
  }
}

/**
 * Toggle pin state
 */
export function togglePinSession(sessionKey: string): boolean {
  const pinned = getPinnedSessions();
  const isPinned = pinned.includes(sessionKey);
  if (isPinned) {
    unpinSession(sessionKey);
  } else {
    pinSession(sessionKey);
  }
  return !isPinned;
}

/**
 * Build recent sessions list for display
 */
export function buildRecentSessionsList(
  currentSessionKey: string,
  sessionsResult: SessionsListResult | null,
): RecentSession[] {
  const recentKeys = getRecentSessions();
  const pinnedKeys = getPinnedSessions();
  const sessions: RecentSession[] = [];

  // Add pinned sessions first
  for (const key of pinnedKeys) {
    const sessionData = sessionsResult?.sessions?.find((s) => s.key === key);
    sessions.push({
      key,
      displayName: sessionData?.displayName || sessionData?.label || key,
      lastActive: sessionData?.lastMessageAt || 0,
      pinned: true,
      unread: false, // TODO: implement unread tracking
      channel: sessionData?.channel,
    });
  }

  // Add recent sessions (excluding pinned and current)
  const limit = 5;
  let added = 0;
  for (const key of recentKeys) {
    if (key === currentSessionKey || pinnedKeys.includes(key)) {
      continue;
    }
    if (added >= limit) {
      break;
    }

    const sessionData = sessionsResult?.sessions?.find((s) => s.key === key);
    sessions.push({
      key,
      displayName: sessionData?.displayName || sessionData?.label || key,
      lastActive: sessionData?.lastMessageAt || 0,
      pinned: false,
      unread: false,
      channel: sessionData?.channel,
    });
    added++;
  }

  return sessions;
}

/**
 * Format last active time
 */
export function formatLastActive(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ago`;
  }
  if (hours > 0) {
    return `${hours}h ago`;
  }
  if (minutes > 0) {
    return `${minutes}m ago`;
  }
  return "just now";
}

/**
 * Get channel icon/emoji
 */
export function getChannelIcon(channel?: string): string {
  const icons: Record<string, string> = {
    discord: "💬",
    slack: "📢",
    telegram: "✈️",
    whatsapp: "💚",
    signal: "🔒",
    email: "📧",
    sms: "📱",
  };
  return icons[channel || ""] || "💭";
}
