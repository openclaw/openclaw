/**
 * App Types
 * 
 * 应用级类型定义（统一整理）
 */

import type { Tab } from '../navigation.ts';
import type { ThemeName, ThemeMode, ResolvedTheme } from '../theme.ts';

// ─────────────────────────────────────────────────────────────
// Re-export from existing types
// ─────────────────────────────────────────────────────────────

export type {
  GatewayBrowserClient,
  GatewayHelloOk,
} from '../gateway.ts';

export type {
  SessionsListResult,
  SessionEntry,
  ModelCatalogEntry,
  ChatModelOverride,
} from '../types.ts';

export type {
  ChatAttachment,
  ChatQueueItem,
} from '../ui-types.ts';

// ─────────────────────────────────────────────────────────────
// App State Types (Consolidated)
// ─────────────────────────────────────────────────────────────

/**
 * 应用连接状态
 */
export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'error';

/**
 * 应用状态（简化版）
 */
export interface AppState {
  // 连接
  connectionStatus: ConnectionStatus;
  connected: boolean;
  lastError: string | null;
  lastErrorCode: string | null;

  // 导航
  tab: Tab;
  navDrawerOpen: boolean;

  // 主题
  theme: ThemeName;
  themeMode: ThemeMode;
  themeResolved: ResolvedTheme;

  // 用户
  sessionKey: string;

  // 加载状态
  loading: boolean;
}

/**
 * 视图状态（用于渲染）
 */
export interface ViewState extends AppState {
  // 派生状态
  isChat: boolean;
  chatFocus: boolean;
  navCollapsed: boolean;

  // 方法
  setTab(tab: Tab): void;
  applySettings(settings: Partial<import('../storage.ts').UiSettings>): void;
  requestUpdate(): void;
}

// ─────────────────────────────────────────────────────────────
// Event Payload Types
// ─────────────────────────────────────────────────────────────

/**
 * Tab 切换事件数据
 */
export interface TabChangePayload {
  tab: Tab;
  previousTab?: Tab;
}

/**
 * 主题变更事件数据
 */
export interface ThemeChangePayload {
  theme: ThemeName;
  mode?: ThemeMode;
}

/**
 * 连接状态变更事件数据
 */
export interface ConnectionChangePayload {
  status: ConnectionStatus;
  hello?: GatewayHelloOk;
  error?: string;
  errorCode?: string;
}

// ─────────────────────────────────────────────────────────────
// Component Props Types
// ─────────────────────────────────────────────────────────────

/**
 * 基础组件属性
 */
export interface BaseComponentProps {
  class?: string;
  style?: string;
  hidden?: boolean;
}

/**
 * 可聚焦组件属性
 */
export interface FocusableProps extends BaseComponentProps {
  tabindex?: number;
  disabled?: boolean;
}

/**
 * 可点击组件属性
 */
export interface ClickableProps extends FocusableProps {
  onClick?: (event: MouseEvent) => void;
}

// ─────────────────────────────────────────────────────────────
// Form Types
// ─────────────────────────────────────────────────────────────

/**
 * 表单字段状态
 */
export interface FormFieldState<T = unknown> {
  value: T;
  dirty: boolean;
  touched: boolean;
  error?: string;
}

/**
 * 表单状态
 */
export interface FormState<T extends Record<string, unknown>> {
  values: T;
  errors: Partial<Record<keyof T, string>>;
  dirty: boolean;
  submitting: boolean;
}

/**
 * 表单变更处理器
 */
export type FormChangeHandler<T> = (path: string, value: unknown) => void;