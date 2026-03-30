/**
 * State Provider
 * 
 * 提供所有状态切片的 Provider 组件
 */

import { LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { provide } from '@lit/context';
import type { UiSettings } from '../storage.ts';

// 导入所有状态切片
import {
  ChatState,
  defaultChatState,
  chatStateContext,
  ConfigState,
  defaultConfigState,
  configStateContext,
  AgentsState,
  defaultAgentsState,
  agentsStateContext,
  UIState,
  defaultUIState,
  uiStateContext,
  SessionsState,
  defaultSessionsState,
  sessionsStateContext,
  LogsState,
  defaultLogsState,
  logsStateContext,
  CronState,
  defaultCronState,
  cronStateContext,
  UsageState,
  defaultUsageState,
  usageStateContext,
} from './index.ts';

/**
 * State Provider Element
 * 
 * 包装在应用根部，提供所有状态上下文
 */
@customElement('state-provider')
export class StateProvider extends LitElement {
  // 从父组件接收的初始设置
  @property({ type: Object }) initialSettings?: UiSettings;

  // ─────────────────────────────────────────────────────────────
  // Chat State
  // ─────────────────────────────────────────────────────────────
  @provide({ context: chatStateContext })
  @state()
  chatState: ChatState = { ...defaultChatState };

  // ─────────────────────────────────────────────────────────────
  // Config State
  // ─────────────────────────────────────────────────────────────
  @provide({ context: configStateContext })
  @state()
  configState: ConfigState = { ...defaultConfigState };

  // ─────────────────────────────────────────────────────────────
  // Agents State
  // ─────────────────────────────────────────────────────────────
  @provide({ context: agentsStateContext })
  @state()
  agentsState: AgentsState = { ...defaultAgentsState };

  // ─────────────────────────────────────────────────────────────
  // UI State
  // ─────────────────────────────────────────────────────────────
  @provide({ context: uiStateContext })
  @state()
  uiState: UIState = { ...defaultUIState };

  // ─────────────────────────────────────────────────────────────
  // Sessions State
  // ─────────────────────────────────────────────────────────────
  @provide({ context: sessionsStateContext })
  @state()
  sessionsState: SessionsState = { ...defaultSessionsState };

  // ─────────────────────────────────────────────────────────────
  // Logs State
  // ─────────────────────────────────────────────────────────────
  @provide({ context: logsStateContext })
  @state()
  logsState: LogsState = { ...defaultLogsState };

  // ─────────────────────────────────────────────────────────────
  // Cron State
  // ─────────────────────────────────────────────────────────────
  @provide({ context: cronStateContext })
  @state()
  cronState: CronState = { ...defaultCronState };

  // ─────────────────────────────────────────────────────────────
  // Usage State
  // ─────────────────────────────────────────────────────────────
  @provide({ context: usageStateContext })
  @state()
  usageState: UsageState = { ...defaultUsageState };

  // 渲染子组件
  render() {
    return this.innerHTML;
  }

  // 更新状态的辅助方法
  updateChatState(partial: Partial<ChatState>) {
    this.chatState = { ...this.chatState, ...partial };
  }

  updateConfigState(partial: Partial<ConfigState>) {
    this.configState = { ...this.configState, ...partial };
  }

  updateAgentsState(partial: Partial<AgentsState>) {
    this.agentsState = { ...this.agentsState, ...partial };
  }

  updateUIState(partial: Partial<UIState>) {
    this.uiState = { ...this.uiState, ...partial };
  }

  updateSessionsState(partial: Partial<SessionsState>) {
    this.sessionsState = { ...this.sessionsState, ...partial };
  }

  updateLogsState(partial: Partial<LogsState>) {
    this.logsState = { ...this.logsState, ...partial };
  }

  updateCronState(partial: Partial<CronState>) {
    this.cronState = { ...this.cronState, ...partial };
  }

  updateUsageState(partial: Partial<UsageState>) {
    this.usageState = { ...this.usageState, ...partial };
  }
}