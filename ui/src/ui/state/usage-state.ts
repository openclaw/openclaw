/**
 * Usage State Slice
 * 
 * 使用量统计相关状态
 */

import { createContext } from '@lit/context';
import type { SessionsUsageResult, CostUsageSummary } from '../types.ts';
import type { SessionLogEntry } from '../views/usage.ts';

export interface UsageState {
  // 基础数据
  usageLoading: boolean;
  usageResult: SessionsUsageResult | null;
  usageCostSummary: CostUsageSummary | null;
  usageError: string | null;
  
  // 日期范围
  usageStartDate: string;
  usageEndDate: string;
  
  // 选择
  usageSelectedSessions: string[];
  usageSelectedDays: string[];
  usageSelectedHours: number[];
  
  // 图表模式
  usageChartMode: 'tokens' | 'cost';
  usageDailyChartMode: 'total' | 'by-type';
  usageTimeSeriesMode: 'cumulative' | 'per-turn';
  usageTimeSeriesBreakdownMode: 'total' | 'by-type';
  
  // 时间序列
  usageTimeSeries: import('../types.ts').SessionUsageTimeSeries | null;
  usageTimeSeriesLoading: boolean;
  usageTimeSeriesCursorStart: number | null;
  usageTimeSeriesCursorEnd: number | null;
  
  // Session 日志
  usageSessionLogs: SessionLogEntry[] | null;
  usageSessionLogsLoading: boolean;
  usageSessionLogsExpanded: boolean;
  
  // 查询
  usageQuery: string;
  usageQueryDraft: string;
  
  // 排序
  usageSessionSort: 'tokens' | 'cost' | 'recent' | 'messages' | 'errors';
  usageSessionSortDir: 'desc' | 'asc';
  
  // 其他
  usageRecentSessions: string[];
  usageTimeZone: 'local' | 'utc';
  usageContextExpanded: boolean;
  usageHeaderPinned: boolean;
  usageSessionsTab: 'all' | 'recent';
  usageVisibleColumns: string[];
  usageLogFilterRoles: import('../views/usage.ts').SessionLogRole[];
  usageLogFilterTools: string[];
  usageLogFilterHasTools: boolean;
  usageLogFilterQuery: string;
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const defaultUsageState: UsageState = {
  usageLoading: false,
  usageResult: null,
  usageCostSummary: null,
  usageError: null,
  usageStartDate: today(),
  usageEndDate: today(),
  usageSelectedSessions: [],
  usageSelectedDays: [],
  usageSelectedHours: [],
  usageChartMode: 'tokens',
  usageDailyChartMode: 'by-type',
  usageTimeSeriesMode: 'per-turn',
  usageTimeSeriesBreakdownMode: 'by-type',
  usageTimeSeries: null,
  usageTimeSeriesLoading: false,
  usageTimeSeriesCursorStart: null,
  usageTimeSeriesCursorEnd: null,
  usageSessionLogs: null,
  usageSessionLogsLoading: false,
  usageSessionLogsExpanded: false,
  usageQuery: '',
  usageQueryDraft: '',
  usageSessionSort: 'recent',
  usageSessionSortDir: 'desc',
  usageRecentSessions: [],
  usageTimeZone: 'local',
  usageContextExpanded: false,
  usageHeaderPinned: false,
  usageSessionsTab: 'all',
  usageVisibleColumns: ['channel', 'agent', 'provider', 'model', 'messages', 'tools', 'errors', 'duration'],
  usageLogFilterRoles: [],
  usageLogFilterTools: [],
  usageLogFilterHasTools: false,
  usageLogFilterQuery: '',
};

export const usageStateContext = createContext<UsageState>('usage-state');