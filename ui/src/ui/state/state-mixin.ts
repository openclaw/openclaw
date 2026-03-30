/**
 * State Mixin
 * 
 * 帮助组件访问状态切片的 mixin
 * 提供从 OpenClawApp 获取状态的便捷方法
 */

import { LitElement } from 'lit';
import { consume } from '@lit/context';

// 导入状态类型和 context
import type {
  ChatState,
  ConfigState,
  AgentsState,
  UIState,
  SessionsState,
  LogsState,
  CronState,
  UsageState,
} from './index.ts';
import {
  chatStateContext,
  configStateContext,
  agentsStateContext,
  uiStateContext,
  sessionsStateContext,
  logsStateContext,
  cronStateContext,
  usageStateContext,
} from './index.ts';

// 避免循环依赖，使用 any 类型
type OpenClawAppLike = any;

/**
 * 状态访问 Mixin
 * 
 * 用法:
 * class MyComponent extends StateMixin(LitElement) {
 *   render() {
 *     return html`Chat messages: ${this.chatState.chatMessages.length}`;
 *   }
 * }
 */
export function StateMixin<T extends Constructor<LitElement>>(superClass: T) {
  class StateClass extends superClass {
    // Chat State
    @consume({ context: chatStateContext, subscribe: true })
    chatState!: ChatState;

    // Config State
    @consume({ context: configStateContext, subscribe: true })
    configState!: ConfigState;

    // Agents State
    @consume({ context: agentsStateContext, subscribe: true })
    agentsState!: AgentsState;

    // UI State
    @consume({ context: uiStateContext, subscribe: true })
    uiState!: UIState;

    // Sessions State
    @consume({ context: sessionsStateContext, subscribe: true })
    sessionsState!: SessionsState;

    // Logs State
    @consume({ context: logsStateContext, subscribe: true })
    logsState!: LogsState;

    // Cron State
    @consume({ context: cronStateContext, subscribe: true })
    cronState!: CronState;

    // Usage State
    @consume({ context: usageStateContext, subscribe: true })
    usageState!: UsageState;
  }

  return StateClass as T;
}

/**
 * 获取最近的 App 实例
 * 
 * 用于在需要调用方法时访问 app 实例
 */
export function getApp(element: Element): OpenClawAppLike | null {
  let current: Element | null = element;
  while (current) {
    if (current.tagName.toLowerCase() === 'openclaw-app') {
      return current as OpenClawAppLike;
    }
    current = current.parentElement;
  }
  return null;
}

/**
 * 状态更新器接口
 * 
 * 用于更新状态切片
 */
export interface StateUpdater {
  updateChatState(partial: Partial<ChatState>): void;
  updateConfigState(partial: Partial<ConfigState>): void;
  updateAgentsState(partial: Partial<AgentsState>): void;
  updateUIState(partial: Partial<UIState>): void;
  updateSessionsState(partial: Partial<SessionsState>): void;
  updateLogsState(partial: Partial<LogsState>): void;
  updateCronState(partial: Partial<CronState>): void;
  updateUsageState(partial: Partial<UsageState>): void;
}

/**
 * 获取状态更新器
 * 
 * 用于在组件中更新状态
 */
export function getStateUpdater(element: Element): StateUpdater | null {
  const provider = element.closest('state-provider') as StateUpdater | null;
  return provider;
}