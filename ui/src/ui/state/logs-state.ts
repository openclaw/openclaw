/**
 * Logs State Slice
 * 
 * 日志查看相关状态
 */

import { createContext } from '@lit/context';
import type { LogEntry, LogLevel } from '../types.ts';
import { DEFAULT_LOG_LEVEL_FILTERS } from '../app-defaults.ts';

export interface LogsState {
  logsLoading: boolean;
  logsError: string | null;
  logsFile: string | null;
  logsEntries: LogEntry[];
  
  // 过滤
  logsFilterText: string;
  logsLevelFilters: Record<LogLevel, boolean>;
  
  // 滚动
  logsAutoFollow: boolean;
  logsTruncated: boolean;
  logsCursor: number | null;
  logsLastFetchAt: number | null;
  logsAtBottom: boolean;
  
  // 限制
  logsLimit: number;
  logsMaxBytes: number;
}

export const defaultLogsState: LogsState = {
  logsLoading: false,
  logsError: null,
  logsFile: null,
  logsEntries: [],
  logsFilterText: '',
  logsLevelFilters: { ...DEFAULT_LOG_LEVEL_FILTERS },
  logsAutoFollow: true,
  logsTruncated: false,
  logsCursor: null,
  logsLastFetchAt: null,
  logsAtBottom: true,
  logsLimit: 500,
  logsMaxBytes: 250_000,
};

export const logsStateContext = createContext<LogsState>('logs-state');