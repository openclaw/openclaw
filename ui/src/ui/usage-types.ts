export type SessionsUsageEntry = {
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
    activityDates?: string[];
    dailyBreakdown?: Array<{ date: string; tokens: number; cost: number }>;
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
    filesRead?: {
      totalReads: number;
      uniqueFiles: number;
      files: Array<{ path: string; count: number }>;
    };
    modelUsage?: Array<{
      provider?: string;
      model?: string;
      count: number;
      totals: SessionsUsageTotals;
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

export type SessionsUsageTotals = {
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

export type SessionsUsageResult = {
  updatedAt: number;
  startDate: string;
  endDate: string;
  sessions: SessionsUsageEntry[];
  totals: SessionsUsageTotals;
  aggregates: {
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
      totals: SessionsUsageTotals;
    }>;
    byProvider: Array<{
      provider?: string;
      model?: string;
      count: number;
      totals: SessionsUsageTotals;
    }>;
    filesRead?: {
      totalReads: number;
      uniqueFiles: number;
      files: Array<{ path: string; count: number }>;
    };
    byAgent: Array<{ agentId: string; totals: SessionsUsageTotals }>;
    byChannel: Array<{ channel: string; totals: SessionsUsageTotals }>;
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
};

export type CostUsageDailyEntry = SessionsUsageTotals & { date: string };

export type CostUsageSummary = {
  updatedAt: number;
  days: number;
  daily: CostUsageDailyEntry[];
  totals: SessionsUsageTotals;
};

export type SessionUsageTimePoint = {
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

export type SessionUsageTimeSeries = {
  sessionId?: string;
  points: SessionUsageTimePoint[];
};
