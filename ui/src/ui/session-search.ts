/**
 * Session search functionality
 * 
 * Full-text search across session history with filters:
 * - Search by message content
 * - Filter by date range
 * - Filter by channel
 * - Filter by model used
 */

import type { SessionsListResult } from "./types.ts";

export type SessionSearchFilters = {
  query: string;
  dateFrom?: Date;
  dateTo?: Date;
  channel?: string;
  model?: string;
  agent?: string;
};

export type SessionSearchResult = {
  key: string;
  displayName: string;
  excerpt: string;
  matchCount: number;
  lastMessageAt: number;
  channel?: string;
  model?: string;
  messageCount: number;
};

/**
 * Search sessions by content
 */
export function searchSessions(
  sessions: SessionsListResult,
  filters: SessionSearchFilters,
): SessionSearchResult[] {
  const results: SessionSearchResult[] = [];
  const query = filters.query.toLowerCase().trim();

  if (!query && !filters.dateFrom && !filters.dateTo && !filters.channel && !filters.model) {
    // No filters, return all
    return sessions.sessions.map((s) => ({
      key: s.key,
      displayName: s.displayName || s.label || s.key,
      excerpt: "",
      matchCount: 0,
      lastMessageAt: s.lastMessageAt || 0,
      channel: s.channel,
      model: s.model,
      messageCount: s.messageCount || 0,
    }));
  }

  for (const session of sessions.sessions) {
    // Apply filters
    if (filters.dateFrom && session.lastMessageAt < filters.dateFrom.getTime()) {
      continue;
    }
    if (filters.dateTo && session.lastMessageAt > filters.dateTo.getTime()) {
      continue;
    }
    if (filters.channel && session.channel !== filters.channel) {
      continue;
    }
    if (filters.model && session.model !== filters.model) {
      continue;
    }

    // Search in session metadata
    const searchableText = [
      session.key,
      session.displayName || "",
      session.label || "",
      session.channel || "",
      session.model || "",
    ]
      .join(" ")
      .toLowerCase();

    if (query) {
      // Simple substring search (can be enhanced with fuzzy matching)
      const matchCount = (searchableText.match(new RegExp(query, "gi")) || []).length;

      if (matchCount === 0) {
        continue;
      }

      // Create excerpt with highlighted match
      const excerptStart = Math.max(0, searchableText.indexOf(query) - 50);
      const excerptEnd = Math.min(searchableText.length, excerptStart + 150);
      const excerpt = searchableText.substring(excerptStart, excerptEnd);

      results.push({
        key: session.key,
        displayName: session.displayName || session.label || session.key,
        excerpt: excerptStart > 0 ? `...${excerpt}...` : `${excerpt}...`,
        matchCount,
        lastMessageAt: session.lastMessageAt || 0,
        channel: session.channel,
        model: session.model,
        messageCount: session.messageCount || 0,
      });
    } else {
      // No query, just apply filters
      results.push({
        key: session.key,
        displayName: session.displayName || session.label || session.key,
        excerpt: "",
        matchCount: 0,
        lastMessageAt: session.lastMessageAt || 0,
        channel: session.channel,
        model: session.model,
        messageCount: session.messageCount || 0,
      });
    }
  }

  // Sort by relevance (match count) then by recency
  results.sort((a, b) => {
    if (a.matchCount !== b.matchCount) {
      return b.matchCount - a.matchCount;
    }
    return b.lastMessageAt - a.lastMessageAt;
  });

  return results;
}

/**
 * Highlight search terms in text
 */
export function highlightSearchTerms(text: string, query: string): string {
  if (!query) {
    return text;
  }

  const regex = new RegExp(`(${query})`, "gi");
  return text.replace(regex, "<mark>$1</mark>");
}

/**
 * Get unique channels from sessions
 */
export function getUniqueChannels(sessions: SessionsListResult): string[] {
  const channels = new Set<string>();
  for (const session of sessions.sessions) {
    if (session.channel) {
      channels.add(session.channel);
    }
  }
  return Array.from(channels).sort();
}

/**
 * Get unique models from sessions
 */
export function getUniqueModels(sessions: SessionsListResult): string[] {
  const models = new Set<string>();
  for (const session of sessions.sessions) {
    if (session.model) {
      models.add(session.model);
    }
  }
  return Array.from(models).sort();
}

/**
 * Save search to history
 */
const SEARCH_HISTORY_KEY = "openclaw:searchHistory";
const MAX_SEARCH_HISTORY = 10;

export function saveSearchToHistory(query: string): void {
  if (!query.trim()) {
    return;
  }

  try {
    const history = getSearchHistory();
    const filtered = history.filter((q) => q !== query);
    filtered.unshift(query);
    const limited = filtered.slice(0, MAX_SEARCH_HISTORY);
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(limited));
  } catch {
    // Silent fail
  }
}

/**
 * Get search history
 */
export function getSearchHistory(): string[] {
  try {
    const stored = localStorage.getItem(SEARCH_HISTORY_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

/**
 * Clear search history
 */
export function clearSearchHistory(): void {
  try {
    localStorage.removeItem(SEARCH_HISTORY_KEY);
  } catch {
    // Silent fail
  }
}
