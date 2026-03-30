/**
 * UI State Slice
 * 
 * UI 相关状态：导航、弹窗、加载、主题等
 */

import { createContext } from '@lit/context';
import type { Tab } from '../navigation.ts';
import type { ThemeName, ThemeMode, ResolvedTheme } from '../theme.ts';
import type { UiSettings } from '../storage.ts';

export interface UIState {
  // 导航
  tab: Tab;
  navDrawerOpen: boolean;
  
  // 主题
  theme: ThemeName;
  themeMode: ThemeMode;
  themeResolved: ResolvedTheme;
  themeOrder: ThemeName[];
  
  // 设置
  settings: UiSettings;
  splitRatio: number;
  
  // 连接状态
  connected: boolean;
  lastError: string | null;
  lastErrorCode: string | null;
  
  // 侧边栏
  sidebarOpen: boolean;
  sidebarContent: string | null;
  sidebarError: string | null;
  
  // 命令面板
  paletteOpen: boolean;
  paletteQuery: string;
  paletteActiveIndex: number;
  
  // 登录
  password: string;
  loginShowGatewayToken: boolean;
  loginShowGatewayPassword: boolean;
  
  // Onboarding
  onboarding: boolean;
  
  // 更新
  updateRunning: boolean;
  updateAvailable: import('../types.ts').UpdateAvailable | null;
}

export const defaultUIState: UIState = {
  tab: 'chat',
  navDrawerOpen: false,
  theme: 'claw',
  themeMode: 'system',
  themeResolved: 'dark',
  themeOrder: ['claw'],
  settings: {} as UiSettings,
  splitRatio: 0.5,
  connected: false,
  lastError: null,
  lastErrorCode: null,
  sidebarOpen: false,
  sidebarContent: null,
  sidebarError: null,
  paletteOpen: false,
  paletteQuery: '',
  paletteActiveIndex: 0,
  password: '',
  loginShowGatewayToken: false,
  loginShowGatewayPassword: false,
  onboarding: false,
  updateRunning: false,
  updateAvailable: null,
};

export const uiStateContext = createContext<UIState>('ui-state');