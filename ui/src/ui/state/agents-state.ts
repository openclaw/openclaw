/**
 * Agents State Slice
 * 
 * Agent 相关状态：列表、文件、工具、技能等
 */

import { createContext } from '@lit/context';
import type {
  AgentsListResult,
  AgentsFilesListResult,
  AgentIdentityResult,
  ToolsCatalogResult,
  ToolsEffectiveResult,
  SkillStatusReport,
} from '../types.ts';

export interface AgentsState {
  // Agent 列表
  agentsLoading: boolean;
  agentsList: AgentsListResult | null;
  agentsError: string | null;
  agentsSelectedId: string | null;
  
  // 工具目录
  toolsCatalogLoading: boolean;
  toolsCatalogError: string | null;
  toolsCatalogResult: ToolsCatalogResult | null;
  
  // 有效工具
  toolsEffectiveLoading: boolean;
  toolsEffectiveLoadingKey: string | null;
  toolsEffectiveResultKey: string | null;
  toolsEffectiveError: string | null;
  toolsEffectiveResult: ToolsEffectiveResult | null;
  
  // Agent 面板
  agentsPanel: 'overview' | 'files' | 'tools' | 'skills' | 'channels' | 'cron';
  
  // Agent 文件
  agentFilesLoading: boolean;
  agentFilesError: string | null;
  agentFilesList: AgentsFilesListResult | null;
  agentFileContents: Record<string, string>;
  agentFileDrafts: Record<string, string>;
  agentFileActive: string | null;
  agentFileSaving: boolean;
  
  // Agent 身份
  agentIdentityLoading: boolean;
  agentIdentityError: string | null;
  agentIdentityById: Record<string, AgentIdentityResult>;
  
  // Agent 技能
  agentSkillsLoading: boolean;
  agentSkillsError: string | null;
  agentSkillsReport: SkillStatusReport | null;
  agentSkillsAgentId: string | null;
}

export const defaultAgentsState: AgentsState = {
  agentsLoading: false,
  agentsList: null,
  agentsError: null,
  agentsSelectedId: null,
  toolsCatalogLoading: false,
  toolsCatalogError: null,
  toolsCatalogResult: null,
  toolsEffectiveLoading: false,
  toolsEffectiveLoadingKey: null,
  toolsEffectiveResultKey: null,
  toolsEffectiveError: null,
  toolsEffectiveResult: null,
  agentsPanel: 'files',
  agentFilesLoading: false,
  agentFilesError: null,
  agentFilesList: null,
  agentFileContents: {},
  agentFileDrafts: {},
  agentFileActive: null,
  agentFileSaving: false,
  agentIdentityLoading: false,
  agentIdentityError: null,
  agentIdentityById: {},
  agentSkillsLoading: false,
  agentSkillsError: null,
  agentSkillsReport: null,
  agentSkillsAgentId: null,
};

export const agentsStateContext = createContext<AgentsState>('agents-state');