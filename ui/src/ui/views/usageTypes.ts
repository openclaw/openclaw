export type UsageSessionEntry = {
  key: string;
  label?: string;
  sessionId?: string;
  updatedAt?: number;
  agentId?: string;
  channel?: string;
  chatType?: string;
  origin?: {
    label?: string;
    provider?: string;
    surface?: string;
    chatType?: string;
    from?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  modelOverride?: string;
  providerOverride?: string;
  modelProvider?: string;
  model?: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    totalCost: number;
    inputCost?: number;
    outputCost?: number;
    cacheReadCost?: number;
    cacheWriteCost?: number;
    missingCostEntries: number;
    firstActivity?: number;
    lastActivity?: number;
    durationMs?: number;
    activityDates?: string[]; // YYYY-MM-DD dates when session had activity
    dailyBreakdown?: Array<{ date: string; tokens: number; cost: number }>; // Per-day breakdown
    dailyMessageCounts?: Array<{
      date: string;
      total: number;
      user: number;
      assistant: number;
      toolCalls: number;
      toolResults: number;
      errors: number;
    }>;
    dailyLatency?: Array<{
      date: string;
      count: number;
      avgMs: number;
      p95Ms: number;
      minMs: number;
      maxMs: number;
    }>;
    dailyModelUsage?: Array<{
      date: string;
      provider?: string;
      model?: string;
      tokens: number;
      cost: number;
      count: number;
    }>;
    messageCounts?: {
      total: number;
      user: number;
      assistant: number;
      toolCalls: number;
      toolResults: number;
      errors: number;
    };
    toolUsage?: {
      totalCalls: number;
      uniqueTools: number;
      tools: Array<{ name: string; count: number }>;
    };
    modelUsage?: Array<{
      provider?: string;
      model?: string;
      count: number;
      totals: UsageTotals;
    }>;
    latency?: {
      count: number;
      avgMs: number;
      p95Ms: number;
      minMs: number;
      maxMs: number;
    };
  } | null;
  contextWeight?: {
    systemPrompt: { chars: number; projectContextChars: number; nonProjectContextChars: number };
    skills: { promptChars: number; entries: Array<{ name: string; blockChars: number }> };
    tools: {
      listChars: number;
      schemaChars: number;
      entries: Array<{ name: string; summaryChars: number; schemaChars: number }>;
    };
    injectedWorkspaceFiles: Array<{
      name: string;
      path: string;
      rawChars: number;
      injectedChars: number;
      truncated: boolean;
    }>;
  } | null;
};

export type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalCost: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  missingCostEntries: number;
};

export type CostDailyEntry = UsageTotals & { date: string };

export type UsageAggregates = {
  messages: {
    total: number;
    user: number;
    assistant: number;
    toolCalls: number;
    toolResults: number;
    errors: number;
  };
  tools: {
    totalCalls: number;
    uniqueTools: number;
    tools: Array<{ name: string; count: number }>;
  };
  byModel: Array<{
    provider?: string;
    model?: string;
    count: number;
    totals: UsageTotals;
  }>;
  byProvider: Array<{
    provider?: string;
    model?: string;
    count: number;
    totals: UsageTotals;
  }>;
  byAgent: Array<{ agentId: string; totals: UsageTotals }>;
  byChannel: Array<{ channel: string; totals: UsageTotals }>;
  latency?: {
    count: number;
    avgMs: number;
    p95Ms: number;
    minMs: number;
    maxMs: number;
  };
  dailyLatency?: Array<{
    date: string;
    count: number;
    avgMs: number;
    p95Ms: number;
    minMs: number;
    maxMs: number;
  }>;
  modelDaily?: Array<{
    date: string;
    provider?: string;
    model?: string;
    tokens: number;
    cost: number;
    count: number;
  }>;
  daily: Array<{
    date: string;
    tokens: number;
    cost: number;
    messages: number;
    toolCalls: number;
    errors: number;
  }>;
};

export type UsageColumnId =
  | "channel"
  | "agent"
  | "provider"
  | "model"
  | "messages"
  | "tools"
  | "errors"
  | "duration";

export type TimeSeriesPoint = {
  timestamp: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  cumulativeTokens: number;
  cumulativeCost: number;
};

export type UsageProps = {
  loading: boolean;
  error: string | null;
  startDate: string;
  endDate: string;
  sessions: UsageSessionEntry[];
  sessionsLimitReached: boolean; // True if 1000 session cap was hit
  totals: UsageTotals | null;
  aggregates: UsageAggregates | null;
  costDaily: CostDailyEntry[];
  selectedSessions: string[]; // Support multiple session selection
  selectedDays: string[]; // Support multiple day selection
  selectedHours: number[]; // Support multiple hour selection
  chartMode: "tokens" | "cost";
  dailyChartMode: "total" | "by-type";
  timeSeriesMode: "cumulative" | "per-turn";
  timeSeriesBreakdownMode: "total" | "by-type";
  timeSeries: { points: TimeSeriesPoint[] } | null;
  timeSeriesLoading: boolean;
  sessionLogs: SessionLogEntry[] | null;
  sessionLogsLoading: boolean;
  sessionLogsExpanded: boolean;
  logFilterRoles: SessionLogRole[];
  logFilterTools: string[];
  logFilterHasTools: boolean;
  logFilterQuery: string;
  query: string;
  queryDraft: string;
  sessionSort: "tokens" | "cost" | "recent" | "messages" | "errors";
  sessionSortDir: "asc" | "desc";
  recentSessions: string[];
  sessionsTab: "all" | "recent";
  visibleColumns: UsageColumnId[];
  timeZone: "local" | "utc";
  contextExpanded: boolean;
  headerPinned: boolean;
  onStartDateChange: (date: string) => void;
  onEndDateChange: (date: string) => void;
  onRefresh: () => void;
  onTimeZoneChange: (zone: "local" | "utc") => void;
  onToggleContextExpanded: () => void;
  onToggleHeaderPinned: () => void;
  onToggleSessionLogsExpanded: () => void;
  onLogFilterRolesChange: (next: SessionLogRole[]) => void;
  onLogFilterToolsChange: (next: string[]) => void;
  onLogFilterHasToolsChange: (next: boolean) => void;
  onLogFilterQueryChange: (next: string) => void;
  onLogFilterClear: () => void;
  onSelectSession: (key: string, shiftKey: boolean) => void;
  onChartModeChange: (mode: "tokens" | "cost") => void;
  onDailyChartModeChange: (mode: "total" | "by-type") => void;
  onTimeSeriesModeChange: (mode: "cumulative" | "per-turn") => void;
  onTimeSeriesBreakdownChange: (mode: "total" | "by-type") => void;
  onSelectDay: (day: string, shiftKey: boolean) => void; // Support shift-click
  onSelectHour: (hour: number, shiftKey: boolean) => void;
  onClearDays: () => void;
  onClearHours: () => void;
  onClearSessions: () => void;
  onClearFilters: () => void;
  onQueryDraftChange: (query: string) => void;
  onApplyQuery: () => void;
  onClearQuery: () => void;
  onSessionSortChange: (sort: "tokens" | "cost" | "recent" | "messages" | "errors") => void;
  onSessionSortDirChange: (dir: "asc" | "desc") => void;
  onSessionsTabChange: (tab: "all" | "recent") => void;
  onToggleColumn: (column: UsageColumnId) => void;
};

export type SessionLogEntry = {
  timestamp: number;
  role: "user" | "assistant" | "tool" | "toolResult";
  content: string;
  tokens?: number;
  cost?: number;
};

export type SessionLogRole = SessionLogEntry["role"];
