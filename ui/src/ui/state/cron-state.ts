/**
 * Cron State Slice
 * 
 * Cron 任务相关状态
 */

import { createContext } from '@lit/context';
import type { CronJob, CronRunLogEntry, CronStatus } from '../types.ts';
import type { CronFieldErrors, CronJobsScheduleKindFilter, CronJobsLastStatusFilter } from '../controllers/cron.ts';
import { DEFAULT_CRON_FORM } from '../app-defaults.ts';
import type { CronFormState } from '../ui-types.ts';

export interface CronState {
  // Jobs 列表
  cronLoading: boolean;
  cronJobsLoadingMore: boolean;
  cronJobs: CronJob[];
  cronJobsTotal: number;
  cronJobsHasMore: boolean;
  cronJobsNextOffset: number | null;
  cronJobsLimit: number;
  cronJobsQuery: string;
  cronJobsEnabledFilter: import('../types.ts').CronJobsEnabledFilter;
  cronJobsScheduleKindFilter: CronJobsScheduleKindFilter;
  cronJobsLastStatusFilter: CronJobsLastStatusFilter;
  cronJobsSortBy: import('../types.ts').CronJobsSortBy;
  cronJobsSortDir: import('../types.ts').CronSortDir;
  
  // 状态
  cronStatus: CronStatus | null;
  cronError: string | null;
  
  // 表单
  cronForm: CronFormState;
  cronFieldErrors: CronFieldErrors;
  cronEditingJobId: string | null;
  
  // Runs
  cronRunsJobId: string | null;
  cronRunsLoadingMore: boolean;
  cronRuns: CronRunLogEntry[];
  cronRunsTotal: number;
  cronRunsHasMore: boolean;
  cronRunsNextOffset: number | null;
  cronRunsLimit: number;
  cronRunsScope: import('../types.ts').CronRunScope;
  cronRunsStatuses: import('../types.ts').CronRunsStatusValue[];
  cronRunsDeliveryStatuses: import('../types.ts').CronDeliveryStatus[];
  cronRunsStatusFilter: import('../types.ts').CronRunsStatusFilter;
  cronRunsQuery: string;
  cronRunsSortDir: import('../types.ts').CronSortDir;
  
  // 其他
  cronModelSuggestions: string[];
  cronBusy: boolean;
}

export const defaultCronState: CronState = {
  cronLoading: false,
  cronJobsLoadingMore: false,
  cronJobs: [],
  cronJobsTotal: 0,
  cronJobsHasMore: false,
  cronJobsNextOffset: null,
  cronJobsLimit: 50,
  cronJobsQuery: '',
  cronJobsEnabledFilter: 'all',
  cronJobsScheduleKindFilter: 'all',
  cronJobsLastStatusFilter: 'all',
  cronJobsSortBy: 'nextRunAtMs',
  cronJobsSortDir: 'asc',
  cronStatus: null,
  cronError: null,
  cronForm: { ...DEFAULT_CRON_FORM },
  cronFieldErrors: {},
  cronEditingJobId: null,
  cronRunsJobId: null,
  cronRunsLoadingMore: false,
  cronRuns: [],
  cronRunsTotal: 0,
  cronRunsHasMore: false,
  cronRunsNextOffset: null,
  cronRunsLimit: 50,
  cronRunsScope: 'all',
  cronRunsStatuses: [],
  cronRunsDeliveryStatuses: [],
  cronRunsStatusFilter: 'all',
  cronRunsQuery: '',
  cronRunsSortDir: 'desc',
  cronModelSuggestions: [],
  cronBusy: false,
};

export const cronStateContext = createContext<CronState>('cron-state');