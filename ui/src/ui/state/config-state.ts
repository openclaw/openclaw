/**
 * Config State Slice
 * 
 * 配置相关的状态：config.json、schema、表单等
 */

import { createContext } from '@lit/context';
import type { ConfigSnapshot, ConfigUiHints } from '../types.ts';

export interface ConfigState {
  // 配置加载
  configLoading: boolean;
  configRaw: string;
  configRawOriginal: string;
  configValid: boolean | null;
  configIssues: unknown[];
  configSaving: boolean;
  configApplying: boolean;
  
  // 配置快照
  configSnapshot: ConfigSnapshot | null;
  applySessionKey: string | null;
  
  // Schema
  configSchema: unknown;
  configSchemaVersion: string | null;
  configSchemaLoading: boolean;
  configUiHints: ConfigUiHints;
  
  // 表单模式
  configForm: Record<string, unknown> | null;
  configFormOriginal: Record<string, unknown> | null;
  configFormDirty: boolean;
  configFormMode: 'form' | 'raw';
  
  // 导航
  configSearchQuery: string;
  configActiveSection: string | null;
  configActiveSubsection: string | null;
  
  // 子页面表单模式
  communicationsFormMode: 'form' | 'raw';
  communicationsSearchQuery: string;
  communicationsActiveSection: string | null;
  communicationsActiveSubsection: string | null;
  
  appearanceFormMode: 'form' | 'raw';
  appearanceSearchQuery: string;
  appearanceActiveSection: string | null;
  appearanceActiveSubsection: string | null;
  
  automationFormMode: 'form' | 'raw';
  automationSearchQuery: string;
  automationActiveSection: string | null;
  automationActiveSubsection: string | null;
  
  infrastructureFormMode: 'form' | 'raw';
  infrastructureSearchQuery: string;
  infrastructureActiveSection: string | null;
  infrastructureActiveSubsection: string | null;
  
  aiAgentsFormMode: 'form' | 'raw';
  aiAgentsSearchQuery: string;
  aiAgentsActiveSection: string | null;
  aiAgentsActiveSubsection: string | null;
}

export const defaultConfigState: ConfigState = {
  configLoading: false,
  configRaw: '{\n}\n',
  configRawOriginal: '',
  configValid: null,
  configIssues: [],
  configSaving: false,
  configApplying: false,
  configSnapshot: null,
  applySessionKey: null,
  configSchema: null,
  configSchemaVersion: null,
  configSchemaLoading: false,
  configUiHints: {},
  configForm: null,
  configFormOriginal: null,
  configFormDirty: false,
  configFormMode: 'form',
  configSearchQuery: '',
  configActiveSection: null,
  configActiveSubsection: null,
  communicationsFormMode: 'form',
  communicationsSearchQuery: '',
  communicationsActiveSection: null,
  communicationsActiveSubsection: null,
  appearanceFormMode: 'form',
  appearanceSearchQuery: '',
  appearanceActiveSection: null,
  appearanceActiveSubsection: null,
  automationFormMode: 'form',
  automationSearchQuery: '',
  automationActiveSection: null,
  automationActiveSubsection: null,
  infrastructureFormMode: 'form',
  infrastructureSearchQuery: '',
  infrastructureActiveSection: null,
  infrastructureActiveSubsection: null,
  aiAgentsFormMode: 'form',
  aiAgentsSearchQuery: '',
  aiAgentsActiveSection: null,
  aiAgentsActiveSubsection: null,
};

export const configStateContext = createContext<ConfigState>('config-state');