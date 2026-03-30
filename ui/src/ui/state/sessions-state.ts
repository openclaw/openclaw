/**
 * Sessions State Slice
 * 
 * 会话列表相关状态
 */

import { createContext } from '@lit/context';
import type { SessionsListResult } from '../types.ts';

export interface SessionsState {
  sessionsLoading: boolean;
  sessionsResult: SessionsListResult | null;
  sessionsError: string | null;
  
  // 过滤
  sessionsFilterActive: string;
  sessionsFilterLimit: string;
  sessionsIncludeGlobal: boolean;
  sessionsIncludeUnknown: boolean;
  sessionsHideCron: boolean;
  sessionsSearchQuery: string;
  
  // 排序
  sessionsSortColumn: 'key' | 'kind' | 'updated' | 'tokens';
  sessionsSortDir: 'asc' | 'desc';
  
  // 分页
  sessionsPage: number;
  sessionsPageSize: number;
  sessionsSelectedKeys: Set<string>;
}

export const defaultSessionsState: SessionsState = {
  sessionsLoading: false,
  sessionsResult: null,
  sessionsError: null,
  sessionsFilterActive: '',
  sessionsFilterLimit: '120',
  sessionsIncludeGlobal: true,
  sessionsIncludeUnknown: false,
  sessionsHideCron: true,
  sessionsSearchQuery: '',
  sessionsSortColumn: 'updated',
  sessionsSortDir: 'desc',
  sessionsPage: 0,
  sessionsPageSize: 25,
  sessionsSelectedKeys: new Set(),
};

export const sessionsStateContext = createContext<SessionsState>('sessions-state');