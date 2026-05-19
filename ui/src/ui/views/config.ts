import JSON5 from "json5";
import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import { icons } from "../icons.ts";
import {
  BORDER_RADIUS_STOPS,
  TEXT_SCALE_STOPS,
  type BorderRadiusStop,
  type TextScaleStop,
} from "../storage.ts";
import type { ThemeTransitionContext } from "../theme-transition.ts";
import type { ThemeMode, ThemeName } from "../theme.ts";
import type { ConfigUiHints } from "../types.ts";
import { viDashboardText as uiText } from "../vi-dashboard-text.ts";
import {
  countSensitiveConfigValues,
  hintForPath,
  humanize,
  isSensitiveConfigPath,
  pathKey,
  REDACTED_PLACEHOLDER,
  schemaType,
  translateConfigLabel,
  type JsonSchema,
} from "./config-form.shared.ts";
import { analyzeConfigSchema, renderConfigForm, SECTION_META } from "./config-form.ts";

const BORDER_RADIUS_LABELS: Record<BorderRadiusStop, string> = {
  0: uiText("None", "Không bo"),
  25: uiText("Slight", "Nhẹ"),
  50: uiText("Default", "Mặc định"),
  75: uiText("Round", "Bo tròn"),
  100: uiText("Full", "Tròn hẳn"),
};

const TEXT_SCALE_LABELS: Record<TextScaleStop, string> = {
  90: uiText("Small", "Nhỏ"),
  100: uiText("Default", "Mặc định"),
  110: uiText("Large", "Lớn"),
  125: "XL",
  140: "XXL",
};

export type WebPushUiState = {
  supported: boolean;
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
  loading: boolean;
};

export type ConfigProps = {
  raw: string;
  originalRaw: string;
  valid: boolean | null;
  issues: unknown[];
  loading: boolean;
  saving: boolean;
  applying: boolean;
  updating: boolean;
  connected: boolean;
  schema: unknown;
  schemaLoading: boolean;
  uiHints: ConfigUiHints;
  formMode: "form" | "raw";
  rawAvailable?: boolean;
  showModeToggle?: boolean;
  formValue: Record<string, unknown> | null;
  originalValue: Record<string, unknown> | null;
  searchQuery: string;
  activeSection: string | null;
  activeSubsection: string | null;
  onRawChange: (next: string) => void;
  onFormModeChange: (mode: "form" | "raw") => void;
  onFormPatch: (path: Array<string | number>, value: unknown) => void;
  onSearchChange: (query: string) => void;
  onSectionChange: (section: string | null) => void;
  onSubsectionChange: (section: string | null) => void;
  onReload: () => void;
  onReset: () => void;
  onSave: () => void;
  onApply: () => void;
  onUpdate: () => void;
  onOpenFile?: () => void;
  version: string;
  theme: ThemeName;
  themeMode: ThemeMode;
  setTheme: (theme: ThemeName, context?: ThemeTransitionContext) => void;
  setThemeMode: (mode: ThemeMode, context?: ThemeTransitionContext) => void;
  hasCustomTheme: boolean;
  customThemeLabel: string | null;
  customThemeSourceUrl: string | null;
  customThemeImportUrl: string;
  customThemeImportBusy: boolean;
  customThemeImportMessage: { kind: "success" | "error"; text: string } | null;
  customThemeImportExpanded?: boolean;
  customThemeImportFocusToken?: number;
  onCustomThemeImportUrlChange: (next: string) => void;
  onImportCustomTheme: () => void;
  onClearCustomTheme: () => void;
  onOpenCustomThemeImport?: () => void;
  borderRadius: number;
  setBorderRadius: (value: number) => void;
  textScale: number;
  setTextScale: (value: number) => void;
  gatewayUrl: string;
  assistantName: string;
  configPath?: string | null;
  navRootLabel?: string;
  showRootTab?: boolean;
  includeSections?: string[];
  excludeSections?: string[];
  includeVirtualSections?: boolean;
  /** Layout mode: "tabs" (default flat scroll) or "accordion" (grouped collapsible). */
  settingsLayout?: "tabs" | "accordion";
  /** Callback to navigate back to Quick Settings. Shown in accordion mode. */
  onBackToQuick?: () => void;
  webPush?: WebPushUiState;
  onWebPushSubscribe?: () => void;
  onWebPushUnsubscribe?: () => void;
  onWebPushTest?: () => void;
  onRequestUpdate?: () => void;
};

// SVG Icons for sidebar (Lucide-style)
const sidebarIcons = {
  all: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="3" width="7" height="7"></rect>
      <rect x="14" y="3" width="7" height="7"></rect>
      <rect x="14" y="14" width="7" height="7"></rect>
      <rect x="3" y="14" width="7" height="7"></rect>
    </svg>
  `,
  env: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="3"></circle>
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
      ></path>
    </svg>
  `,
  update: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
      <polyline points="7 10 12 15 17 10"></polyline>
      <line x1="12" y1="15" x2="12" y2="3"></line>
    </svg>
  `,
  agents: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path
        d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"
      ></path>
      <circle cx="8" cy="14" r="1"></circle>
      <circle cx="16" cy="14" r="1"></circle>
    </svg>
  `,
  auth: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
    </svg>
  `,
  channels: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
    </svg>
  `,
  messages: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
      <polyline points="22,6 12,13 2,6"></polyline>
    </svg>
  `,
  commands: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="4 17 10 11 4 5"></polyline>
      <line x1="12" y1="19" x2="20" y2="19"></line>
    </svg>
  `,
  hooks: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
    </svg>
  `,
  skills: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polygon
        points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
      ></polygon>
    </svg>
  `,
  tools: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path
        d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
      ></path>
    </svg>
  `,
  gateway: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="2" y1="12" x2="22" y2="12"></line>
      <path
        d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"
      ></path>
    </svg>
  `,
  wizard: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M15 4V2"></path>
      <path d="M15 16v-2"></path>
      <path d="M8 9h2"></path>
      <path d="M20 9h2"></path>
      <path d="M17.8 11.8 19 13"></path>
      <path d="M15 9h0"></path>
      <path d="M17.8 6.2 19 5"></path>
      <path d="m3 21 9-9"></path>
      <path d="M12.2 6.2 11 5"></path>
    </svg>
  `,
  // Additional sections
  meta: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 20h9"></path>
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
    </svg>
  `,
  logging: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
      <polyline points="14 2 14 8 20 8"></polyline>
      <line x1="16" y1="13" x2="8" y2="13"></line>
      <line x1="16" y1="17" x2="8" y2="17"></line>
      <polyline points="10 9 9 9 8 9"></polyline>
    </svg>
  `,
  browser: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"></circle>
      <circle cx="12" cy="12" r="4"></circle>
      <line x1="21.17" y1="8" x2="12" y2="8"></line>
      <line x1="3.95" y1="6.06" x2="8.54" y2="14"></line>
      <line x1="10.88" y1="21.94" x2="15.46" y2="14"></line>
    </svg>
  `,
  ui: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
      <line x1="3" y1="9" x2="21" y2="9"></line>
      <line x1="9" y1="21" x2="9" y2="9"></line>
    </svg>
  `,
  models: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path
        d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"
      ></path>
      <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
      <line x1="12" y1="22.08" x2="12" y2="12"></line>
    </svg>
  `,
  bindings: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
      <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
      <line x1="6" y1="6" x2="6.01" y2="6"></line>
      <line x1="6" y1="18" x2="6.01" y2="18"></line>
    </svg>
  `,
  broadcast: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"></path>
      <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"></path>
      <circle cx="12" cy="12" r="2"></circle>
      <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"></path>
      <path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"></path>
    </svg>
  `,
  audio: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M9 18V5l12-2v13"></path>
      <circle cx="6" cy="18" r="3"></circle>
      <circle cx="18" cy="16" r="3"></circle>
    </svg>
  `,
  session: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
      <circle cx="9" cy="7" r="4"></circle>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
    </svg>
  `,
  cron: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"></circle>
      <polyline points="12 6 12 12 16 14"></polyline>
    </svg>
  `,
  web: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="2" y1="12" x2="22" y2="12"></line>
      <path
        d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"
      ></path>
    </svg>
  `,
  discovery: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="11" cy="11" r="8"></circle>
      <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
    </svg>
  `,
  canvasHost: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
      <circle cx="8.5" cy="8.5" r="1.5"></circle>
      <polyline points="21 15 16 10 5 21"></polyline>
    </svg>
  `,
  talk: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
      <line x1="12" y1="19" x2="12" y2="23"></line>
      <line x1="8" y1="23" x2="16" y2="23"></line>
    </svg>
  `,
  plugins: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 2v6"></path>
      <path d="m4.93 10.93 4.24 4.24"></path>
      <path d="M2 12h6"></path>
      <path d="m4.93 13.07 4.24-4.24"></path>
      <path d="M12 22v-6"></path>
      <path d="m19.07 13.07-4.24-4.24"></path>
      <path d="M22 12h-6"></path>
      <path d="m19.07 10.93-4.24 4.24"></path>
    </svg>
  `,
  diagnostics: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
    </svg>
  `,
  cli: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="4 17 10 11 4 5"></polyline>
      <line x1="12" y1="19" x2="20" y2="19"></line>
    </svg>
  `,
  secrets: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path
        d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"
      ></path>
    </svg>
  `,
  acp: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
      <circle cx="9" cy="7" r="4"></circle>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
    </svg>
  `,
  mcp: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
      <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
      <line x1="6" y1="6" x2="6.01" y2="6"></line>
      <line x1="6" y1="18" x2="6.01" y2="18"></line>
    </svg>
  `,
  __appearance__: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="5"></circle>
      <line x1="12" y1="1" x2="12" y2="3"></line>
      <line x1="12" y1="21" x2="12" y2="23"></line>
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
      <line x1="1" y1="12" x2="3" y2="12"></line>
      <line x1="21" y1="12" x2="23" y2="12"></line>
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
    </svg>
  `,
  default: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
      <polyline points="14 2 14 8 20 8"></polyline>
    </svg>
  `,
};

// Categorised section definitions
type SectionCategory = {
  id: string;
  label: string;
  sections: Array<{ key: string; label: string }>;
};

const SECTION_CATEGORIES: SectionCategory[] = [
  {
    id: "core",
    label: "Core",
    sections: [
      { key: "env", label: "Environment" },
      { key: "auth", label: "Authentication" },
      { key: "update", label: "Updates" },
      { key: "meta", label: "Meta" },
      { key: "logging", label: "Logging" },
      { key: "diagnostics", label: "Diagnostics" },
      { key: "cli", label: "Cli" },
      { key: "secrets", label: "Secrets" },
    ],
  },
  {
    id: "ai",
    label: "AI & Agents",
    sections: [
      { key: "agents", label: "Agents" },
      { key: "models", label: "Models" },
      { key: "skills", label: "Skills" },
      { key: "tools", label: "Tools" },
      { key: "memory", label: "Memory" },
      { key: "session", label: "Session" },
    ],
  },
  {
    id: "communication",
    label: uiText("Communication", "Liên lạc"),
    sections: [
      { key: "channels", label: "Channels" },
      { key: "messages", label: "Messages" },
      { key: "broadcast", label: "Broadcast" },
      { key: "talk", label: "Talk" },
      { key: "audio", label: "Audio" },
    ],
  },
  {
    id: "automation",
    label: "Automation",
    sections: [
      { key: "commands", label: uiText("Commands", "Lệnh") },
      { key: "hooks", label: uiText("Hooks", "Hook") },
      { key: "bindings", label: uiText("Bindings", "Liên kết") },
      { key: "cron", label: uiText("Cron", "Tác vụ Cron") },
      { key: "approvals", label: uiText("Approvals", "Phê duyệt") },
      { key: "plugins", label: uiText("Plugins", "Tiện ích") },
    ],
  },
  {
    id: "infrastructure",
    label: "Infrastructure",
    sections: [
      { key: "gateway", label: uiText("Gateway", "Gateway") },
      { key: "web", label: "Web" },
      { key: "browser", label: uiText("Browser", "Trình duyệt") },
      { key: "nodeHost", label: uiText("Node Host", "Máy chủ node") },
      { key: "canvasHost", label: uiText("Canvas Host", "Máy chủ canvas") },
      { key: "discovery", label: uiText("Discovery", "Khám phá") },
      { key: "media", label: uiText("Media", "Phương tiện") },
      { key: "acp", label: "ACP" },
      { key: "mcp", label: "MCP" },
    ],
  },
  {
    id: "appearance",
    label: t("tabs.appearance"),
    sections: [
      { key: "__appearance__", label: uiText("Theme", "Chủ đề") },
      { key: "ui", label: uiText("UI", "Giao diện UI") },
      { key: "wizard", label: uiText("Setup Wizard", "Trình hướng dẫn thiết lập") },
    ],
  },
];

// Flat lookup: all categorised keys
const CATEGORISED_KEYS = new Set(SECTION_CATEGORIES.flatMap((c) => c.sections.map((s) => s.key)));

function getSectionIcon(key: string) {
  return sidebarIcons[key as keyof typeof sidebarIcons] ?? sidebarIcons.default;
}

function scopeSchemaSections(
  schema: JsonSchema | null,
  params: { include?: ReadonlySet<string> | null; exclude?: ReadonlySet<string> | null },
): JsonSchema | null {
  if (!schema || schemaType(schema) !== "object" || !schema.properties) {
    return schema;
  }
  const include = params.include;
  const exclude = params.exclude;
  const nextProps: Record<string, JsonSchema> = {};
  for (const key of Object.keys(schema.properties)) {
    if (include && include.size > 0 && !include.has(key)) {
      continue;
    }
    if (exclude && exclude.size > 0 && exclude.has(key)) {
      continue;
    }
    nextProps[key] = schema.properties[key];
  }
  return { ...schema, properties: nextProps };
}

function asConfigSchema(value: unknown): JsonSchema | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonSchema;
}

function resolveSectionMeta(
  key: string,
  schema?: JsonSchema,
): {
  label: string;
  description?: string;
} {
  const meta = SECTION_META[key];
  if (meta) {
    return meta;
  }
  return {
    label: schema?.title ?? humanize(key),
    description: schema?.description ?? "",
  };
}

const MAX_CONFIG_DIFF_DEPTH = 64;
const MAX_CONFIG_DIFF_NODES = 20_000;
const MAX_CONFIG_DIFF_CHANGES = 1_000;
const MAX_CONFIG_DIFF_ARRAY_COMPARE_ITEMS = 2_000;
const MAX_RAW_DIFF_CHARS = 200_000;

type ConfigDiffPath = string[];
type ConfigDiffEntry = { path: ConfigDiffPath; from: unknown; to: unknown };

let rawDiffCache:
  | {
      original: string;
      current: string;
      diff: ConfigDiffEntry[];
    }
  | undefined;

function formatConfigDiffPath(path: ConfigDiffPath): string {
  return path.length > 0 ? path.join(".") : "<root>";
}

function computeDiff(
  original: Record<string, unknown> | null,
  current: Record<string, unknown> | null,
): ConfigDiffEntry[] {
  if (!original || !current) {
    return [];
  }
  const changes: ConfigDiffEntry[] = [];
  let visited = 0;

  function pushChange(path: ConfigDiffPath, from: unknown, to: unknown) {
    if (changes.length < MAX_CONFIG_DIFF_CHANGES) {
      changes.push({ path, from, to });
    }
  }

  function arrayValuesDiffer(orig: unknown[], curr: unknown[], depth: number): boolean {
    if (orig.length !== curr.length) {
      return true;
    }
    if (orig.length > MAX_CONFIG_DIFF_ARRAY_COMPARE_ITEMS) {
      return true;
    }
    for (let index = 0; index < orig.length; index += 1) {
      if (valuesDiffer(orig[index], curr[index], depth + 1)) {
        return true;
      }
    }
    return false;
  }

  function objectValuesDiffer(
    orig: Record<string, unknown>,
    curr: Record<string, unknown>,
    depth: number,
  ): boolean {
    const origKeys = Object.keys(orig);
    const currKeys = Object.keys(curr);
    if (origKeys.length !== currKeys.length) {
      return true;
    }
    for (const key of origKeys) {
      if (
        !Object.prototype.hasOwnProperty.call(curr, key) ||
        valuesDiffer(orig[key], curr[key], depth + 1)
      ) {
        return true;
      }
    }
    return false;
  }

  function valuesDiffer(orig: unknown, curr: unknown, depth: number): boolean {
    visited += 1;
    if (visited > MAX_CONFIG_DIFF_NODES || depth > MAX_CONFIG_DIFF_DEPTH) {
      return true;
    }
    if (orig === curr) {
      return false;
    }
    if (typeof orig !== typeof curr) {
      return true;
    }
    if (typeof orig !== "object" || orig === null || curr === null) {
      return orig !== curr;
    }
    if (Array.isArray(orig) || Array.isArray(curr)) {
      return Array.isArray(orig) && Array.isArray(curr)
        ? arrayValuesDiffer(orig, curr, depth + 1)
        : true;
    }
    return objectValuesDiffer(
      orig as Record<string, unknown>,
      curr as Record<string, unknown>,
      depth + 1,
    );
  }

  function compare(orig: unknown, curr: unknown, path: ConfigDiffPath, depth: number) {
    visited += 1;
    if (
      visited > MAX_CONFIG_DIFF_NODES ||
      depth > MAX_CONFIG_DIFF_DEPTH ||
      changes.length >= MAX_CONFIG_DIFF_CHANGES
    ) {
      return;
    }
    if (orig === curr) {
      return;
    }
    if (typeof orig !== typeof curr) {
      pushChange(path, orig, curr);
      return;
    }
    if (typeof orig !== "object" || orig === null || curr === null) {
      if (orig !== curr) {
        pushChange(path, orig, curr);
      }
      return;
    }
    if (Array.isArray(orig) || Array.isArray(curr)) {
      if (Array.isArray(orig) && Array.isArray(curr) && arrayValuesDiffer(orig, curr, depth + 1)) {
        pushChange(path, orig, curr);
      } else if (!Array.isArray(orig) || !Array.isArray(curr)) {
        pushChange(path, orig, curr);
      }
      return;
    }
    const origObj = orig as Record<string, unknown>;
    const currObj = curr as Record<string, unknown>;
    const allKeys = new Set([...Object.keys(origObj), ...Object.keys(currObj)]);
    for (const key of allKeys) {
      compare(origObj[key], currObj[key], [...path, key], depth + 1);
    }
  }

  compare(original, current, [], 0);
  return changes;
}

function computeRawDiff(original: string, current: string): ConfigDiffEntry[] {
  if (rawDiffCache?.original === original && rawDiffCache.current === current) {
    return rawDiffCache.diff;
  }
  if (original.length > MAX_RAW_DIFF_CHARS || current.length > MAX_RAW_DIFF_CHARS) {
    rawDiffCache = { original, current, diff: [] };
    return rawDiffCache.diff;
  }
  try {
    const originalValue = JSON5.parse(original) as unknown;
    const currentValue = JSON5.parse(current) as unknown;
    if (
      !originalValue ||
      !currentValue ||
      typeof originalValue !== "object" ||
      typeof currentValue !== "object" ||
      Array.isArray(originalValue) ||
      Array.isArray(currentValue)
    ) {
      rawDiffCache = { original, current, diff: [] };
      return [];
    }
    const diff = computeDiff(
      originalValue as Record<string, unknown>,
      currentValue as Record<string, unknown>,
    );
    rawDiffCache = { original, current, diff };
    return diff;
  } catch {
    rawDiffCache = { original, current, diff: [] };
    return [];
  }
}

function truncateValue(value: unknown, maxLen = 40): string {
  if (Array.isArray(value)) {
    return uiText(
      `[${value.length} item${value.length === 1 ? "" : "s"}]`,
      `[${value.length} mục]`,
    );
  }
  let str: string;
  try {
    const json = JSON.stringify(value);
    str = json ?? String(value);
  } catch {
    str = String(value);
  }
  if (str.length <= maxLen) {
    return str;
  }
  return str.slice(0, maxLen - 3) + "...";
}

function renderDiffValue(path: ConfigDiffPath, value: unknown, _uiHints: ConfigUiHints): string {
  if (
    isSensitiveConfigPath(formatConfigDiffPath(path)) &&
    value != null &&
    truncateValue(value).trim() !== ""
  ) {
    return REDACTED_PLACEHOLDER;
  }
  return truncateValue(value);
}

function hintKeyMatchesPathPrefix(hintKey: string, path: ConfigDiffPath): boolean {
  const hintSegments = hintKey.split(".");
  if (hintSegments.length !== path.length) {
    return false;
  }
  return hintSegments.every((segment, index) => segment === "*" || segment === path[index]);
}

function hasSensitiveHintForPathPrefix(path: ConfigDiffPath, uiHints: ConfigUiHints): boolean {
  return Object.entries(uiHints).some(
    ([hintKey, hint]) => Boolean(hint.sensitive) && hintKeyMatchesPathPrefix(hintKey, path),
  );
}

function isSensitiveDiffPath(path: ConfigDiffPath, uiHints: ConfigUiHints): boolean {
  for (let index = 1; index <= path.length; index += 1) {
    const prefix = path.slice(0, index);
    const key = formatConfigDiffPath(prefix);
    if (
      (hintForPath(prefix, uiHints)?.sensitive ?? false) ||
      hasSensitiveHintForPathPrefix(prefix, uiHints) ||
      isSensitiveConfigPath(key)
    ) {
      return true;
    }
  }
  return false;
}

function renderRawDiffValue(
  path: ConfigDiffPath,
  value: unknown,
  uiHints: ConfigUiHints,
  rawRevealed: boolean,
): string {
  const hasSensitiveValue = countSensitiveConfigValues(value, path, uiHints) > 0;
  if (!rawRevealed && value != null && (isSensitiveDiffPath(path, uiHints) || hasSensitiveValue)) {
    return REDACTED_PLACEHOLDER;
  }
  return truncateValue(value);
}

type ThemeOption = {
  id: ThemeName;
  label: string;
  description: string;
  icon: TemplateResult;
};
const BUILTIN_THEME_OPTIONS: ThemeOption[] = [
  { id: "claw", label: "Claw", description: uiText("Chroma family", "Họ Chroma"), icon: icons.zap },
  { id: "knot", label: "Knot", description: uiText("Black & red", "Đen & đỏ"), icon: icons.link },
  {
    id: "dash",
    label: "Dash",
    description: uiText("Chocolate blueprint", "Bản thiết kế chocolate"),
    icon: icons.barChart,
  },
];

function importedThemeName(props: Pick<ConfigProps, "hasCustomTheme" | "customThemeLabel">) {
  return props.hasCustomTheme && props.customThemeLabel
    ? props.customThemeLabel
    : uiText("Imported theme", "Theme đã import");
}

function focusCustomThemeImportInput() {
  const schedule =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0);
  schedule(() => {
    const input = globalThis.document?.querySelector<HTMLInputElement>(
      "[data-custom-theme-import-input]",
    );
    if (!input) {
      return;
    }
    if (typeof input.scrollIntoView === "function") {
      input.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    input.focus();
    input.select();
  });
}

function renderNotificationsSection(props: ConfigProps) {
  const push = props.webPush;
  if (!push) {
    return html`
      <div class="settings-appearance">
        <div class="settings-appearance__section">
          <h3 class="settings-appearance__heading">
            ${uiText("Push Notifications", "Thông báo đẩy")}
          </h3>
          <p class="settings-appearance__hint">
            ${uiText("Not available in this browser.", "Không khả dụng trong trình duyệt này.")}
          </p>
        </div>
      </div>
    `;
  }

  const permissionLabel =
    push.permission === "granted"
      ? uiText("Granted", "Đã cấp")
      : push.permission === "denied"
        ? uiText("Denied", "Đã từ chối")
        : push.permission === "default"
          ? uiText("Not requested", "Chưa yêu cầu")
          : uiText("Unsupported", "Không hỗ trợ");
  const statusDot = push.subscribed ? "settings-status-dot--ok" : "";

  return html`
    <div class="settings-appearance">
      <div class="settings-appearance__section">
        <h3 class="settings-appearance__heading">
          ${uiText("Push Notifications", "Thông báo đẩy")}
        </h3>
        <p class="settings-appearance__hint">
          ${uiText(
            "Subscribe to receive browser push notifications from your gateway.",
            "Đăng ký để nhận thông báo đẩy từ Gateway trong trình duyệt.",
          )}
        </p>

        <div class="settings-info-grid">
          <div class="settings-info-row">
            <span class="settings-info-row__label">
              ${uiText("Browser support", "Hỗ trợ trình duyệt")}
            </span>
            <span class="settings-info-row__value"
              >${push.supported
                ? uiText("Available", "Khả dụng")
                : uiText("Not supported", "Không hỗ trợ")}</span
            >
          </div>
          <div class="settings-info-row">
            <span class="settings-info-row__label">${uiText("Permission", "Quyền")}</span>
            <span class="settings-info-row__value">${permissionLabel}</span>
          </div>
          <div class="settings-info-row">
            <span class="settings-info-row__label">${uiText("Status", "Trạng thái")}</span>
            <span class="settings-info-row__value">
              <span class="settings-status-dot ${statusDot}"></span>
              ${push.subscribed
                ? uiText("Subscribed", "Đã đăng ký")
                : uiText("Not subscribed", "Chưa đăng ký")}
            </span>
          </div>
        </div>
      </div>

      ${push.supported && push.permission !== "denied"
        ? html`
            <div class="settings-appearance__section">
              <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                ${push.subscribed
                  ? html`
                      <button
                        class="config-bar__btn"
                        ?disabled=${push.loading || !props.connected}
                        @click=${() => props.onWebPushUnsubscribe?.()}
                      >
                        ${uiText("Unsubscribe", "Hủy đăng ký")}
                      </button>
                      <button
                        class="config-bar__btn"
                        ?disabled=${push.loading || !props.connected}
                        @click=${() => props.onWebPushTest?.()}
                      >
                        ${uiText("Send test", "Gửi thử")}
                      </button>
                    `
                  : html`
                      <button
                        class="config-bar__btn config-bar__btn--primary"
                        ?disabled=${push.loading || !props.connected}
                        @click=${() => props.onWebPushSubscribe?.()}
                      >
                        ${push.loading
                          ? uiText("Subscribing...", "Đang đăng ký...")
                          : uiText("Enable notifications", "Bật thông báo")}
                      </button>
                    `}
              </div>
            </div>
          `
        : push.permission === "denied"
          ? html`
              <div class="settings-appearance__section">
                <p class="settings-appearance__hint">
                  ${uiText(
                    "Notifications are blocked. Update your browser site permissions to allow notifications.",
                    "Thông báo đang bị chặn. Hãy cập nhật quyền của trang trong trình duyệt để cho phép thông báo.",
                  )}
                </p>
              </div>
            `
          : nothing}
    </div>
  `;
}

function renderAppearanceSection(props: ConfigProps) {
  const showCustomThemeImport = props.hasCustomTheme || props.customThemeImportExpanded === true;
  if (
    showCustomThemeImport &&
    props.customThemeImportFocusToken != null &&
    props.customThemeImportFocusToken !== cvs.lastCustomThemeImportFocusToken
  ) {
    cvs.lastCustomThemeImportFocusToken = props.customThemeImportFocusToken;
    focusCustomThemeImportInput();
  }
  const importedName = importedThemeName(props);
  const themeOptions: ThemeOption[] = [
    ...BUILTIN_THEME_OPTIONS,
    {
      id: "custom",
      label: props.hasCustomTheme ? importedName : uiText("Import", "Import"),
      description: props.hasCustomTheme
        ? uiText(`Imported from tweakcn: ${importedName}`, `Đã import từ tweakcn: ${importedName}`)
        : uiText(
            "Import a tweakcn theme into this browser-local slot",
            "Import theme tweakcn vào vị trí chỉ lưu trong trình duyệt này",
          ),
      icon: icons.spark,
    },
  ];
  return html`
    <div class="settings-appearance">
      <div class="settings-appearance__section">
        <h3 class="settings-appearance__heading">${uiText("Theme", "Theme")}</h3>
        <p class="settings-appearance__hint">
          ${uiText("Choose a theme family.", "Chọn họ theme.")}
        </p>
        <div class="settings-theme-grid">
          ${themeOptions.map(
            (opt) => html`
              <button
                class="settings-theme-card ${opt.id === props.theme
                  ? "settings-theme-card--active"
                  : ""}"
                title=${opt.description}
                @click=${(e: Event) => {
                  if (opt.id === "custom" && !props.hasCustomTheme) {
                    props.onOpenCustomThemeImport?.();
                    return;
                  }
                  if (opt.id !== props.theme) {
                    const context: ThemeTransitionContext = {
                      element: (e.currentTarget as HTMLElement) ?? undefined,
                    };
                    props.setTheme(opt.id, context);
                  }
                }}
              >
                <span class="settings-theme-card__icon" aria-hidden="true">${opt.icon}</span>
                <span class="settings-theme-card__label">${opt.label}</span>
                ${opt.id === props.theme
                  ? html`<span class="settings-theme-card__check" aria-hidden="true"
                      >${icons.check}</span
                    >`
                  : nothing}
              </button>
            `,
          )}
        </div>
        ${showCustomThemeImport
          ? html`
              <div class="settings-theme-import">
                <div class="settings-theme-import__copy">
                  <div class="settings-theme-import__title">
                    ${uiText("Import from tweakcn", "Import từ tweakcn")}
                  </div>
                  <p class="settings-theme-import__hint">
                    ${uiText(
                      "Open tweakcn.com, choose or create a theme, click Share, then paste the copied theme link here. Share links, editor URLs, registry URLs, theme IDs, and default theme names like amethyst-haze are accepted.",
                      "Mở tweakcn.com, chọn hoặc tạo theme, bấm Share rồi dán link đã sao chép vào đây. Chấp nhận link chia sẻ, URL editor, URL registry, ID theme và tên theme mặc định như amethyst-haze.",
                    )}
                  </p>
                </div>
                <a
                  class="settings-theme-import__external"
                  href="https://tweakcn.com/editor/theme"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  ${uiText("Browse tweakcn themes", "Duyệt theme tweakcn")} ${icons.externalLink}
                </a>
                <label class="settings-theme-import__field">
                  <span class="settings-theme-import__label">
                    ${uiText("Theme link or ID", "Link hoặc ID theme")}
                  </span>
                  <input
                    class="settings-theme-import__input"
                    data-custom-theme-import-input
                    type="text"
                    spellcheck="false"
                    placeholder=${uiText(
                      "https://tweakcn.com/editor/theme?theme=... or amethyst-haze",
                      "https://tweakcn.com/editor/theme?theme=... hoặc amethyst-haze",
                    )}
                    .value=${props.customThemeImportUrl}
                    @input=${(e: Event) =>
                      props.onCustomThemeImportUrlChange(
                        (e.currentTarget as HTMLInputElement).value,
                      )}
                  />
                </label>
                <div class="settings-theme-import__actions">
                  <button
                    class="btn btn--sm primary"
                    ?disabled=${props.customThemeImportBusy ||
                    props.customThemeImportUrl.trim().length === 0}
                    @click=${props.onImportCustomTheme}
                  >
                    ${props.customThemeImportBusy
                      ? uiText("Importing…", "Đang import…")
                      : props.hasCustomTheme
                        ? uiText(`Replace ${importedName}`, `Thay ${importedName}`)
                        : uiText("Import theme", "Import theme")}
                  </button>
                  ${props.hasCustomTheme
                    ? html`
                        <button class="btn btn--sm danger" @click=${props.onClearCustomTheme}>
                          ${uiText(`Clear ${importedName}`, `Xóa ${importedName}`)}
                        </button>
                      `
                    : nothing}
                </div>
                ${props.hasCustomTheme
                  ? html`
                      <div class="settings-theme-import__meta">
                        <span class="settings-theme-import__meta-label">
                          ${uiText("Loaded", "Đã tải")}
                        </span>
                        <span class="settings-theme-import__meta-value"
                          >${importedName} · ${props.customThemeSourceUrl ?? "tweakcn"}</span
                        >
                      </div>
                    `
                  : nothing}
                ${props.customThemeImportMessage
                  ? html`
                      <div
                        class="settings-theme-import__message settings-theme-import__message--${props
                          .customThemeImportMessage.kind}"
                      >
                        ${props.customThemeImportMessage.text}
                      </div>
                    `
                  : nothing}
              </div>
            `
          : html`
              <p class="settings-theme-import__inline-hint">
                ${uiText("Click", "Bấm")} <strong>${uiText("Import", "Import")}</strong>
                ${uiText(
                  "to add one browser-local tweakcn theme. In tweakcn, use Share and paste the copied link here.",
                  "để thêm một theme tweakcn chỉ lưu trong trình duyệt. Trong tweakcn, dùng Share rồi dán link đã sao chép vào đây.",
                )}
              </p>
            `}
      </div>

      <div class="settings-appearance__section">
        <h3 class="settings-appearance__heading">${uiText("Roundness", "Độ bo góc")}</h3>
        <p class="settings-appearance__hint">
          ${uiText("Adjust corner radius across the UI.", "Điều chỉnh bo góc trên toàn UI.")}
        </p>
        <div class="settings-roundness">
          <div class="settings-roundness__options">
            ${BORDER_RADIUS_STOPS.map(
              (stop) => html`
                <button
                  type="button"
                  class="settings-roundness__btn ${stop === props.borderRadius ? "active" : ""}"
                  @click=${() => props.setBorderRadius(stop)}
                >
                  <span
                    class="settings-roundness__swatch"
                    style="border-radius: ${Math.round(10 * (stop / 50))}px"
                  ></span>
                  <span class="settings-roundness__label">${BORDER_RADIUS_LABELS[stop]}</span>
                </button>
              `,
            )}
          </div>
        </div>
      </div>

      <div class="settings-appearance__section">
        <h3 class="settings-appearance__heading">${uiText("Text size", "Cỡ chữ")}</h3>
        <div class="settings-text-scale">
          <div class="settings-text-scale__options">
            ${TEXT_SCALE_STOPS.map(
              (stop) => html`
                <button
                  type="button"
                  class="settings-text-scale__btn ${stop === props.textScale ? "active" : ""}"
                  @click=${() => props.setTextScale(stop)}
                >
                  <span class="settings-text-scale__sample">${TEXT_SCALE_LABELS[stop]}</span>
                  <span class="settings-text-scale__label">${stop}%</span>
                </button>
              `,
            )}
          </div>
        </div>
      </div>

      <div class="settings-appearance__section">
        <h3 class="settings-appearance__heading">${uiText("Connection", "Kết nối")}</h3>
        <div class="settings-info-grid">
          <div class="settings-info-row">
            <span class="settings-info-row__label">Gateway</span>
            <span class="settings-info-row__value mono">${props.gatewayUrl || "-"}</span>
          </div>
          <div class="settings-info-row">
            <span class="settings-info-row__label">${uiText("Status", "Trạng thái")}</span>
            <span class="settings-info-row__value">
              <span
                class="settings-status-dot ${props.connected ? "settings-status-dot--ok" : ""}"
              ></span>
              ${props.connected ? t("common.connected") : t("common.offline")}
            </span>
          </div>
          ${props.assistantName
            ? html`
                <div class="settings-info-row">
                  <span class="settings-info-row__label">${uiText("Assistant", "Trợ lý")}</span>
                  <span class="settings-info-row__value">${props.assistantName}</span>
                </div>
              `
            : nothing}
        </div>
      </div>
    </div>
  `;
}

interface ConfigEphemeralState {
  rawRevealed: boolean;
  rawDiffOpen: boolean;
  envRevealed: boolean;
  validityDismissed: boolean;
  revealedSensitivePaths: Set<string>;
  lastCustomThemeImportFocusToken: number | null;
}

function createConfigEphemeralState(): ConfigEphemeralState {
  return {
    rawRevealed: false,
    rawDiffOpen: false,
    envRevealed: false,
    validityDismissed: false,
    revealedSensitivePaths: new Set(),
    lastCustomThemeImportFocusToken: null,
  };
}

const cvs = createConfigEphemeralState();
let lastConfigContextKey: string | null = null;

function resetConfigEphemeralState() {
  Object.assign(cvs, createConfigEphemeralState());
  rawDiffCache = undefined;
}

function configContextKey(props: ConfigProps): string {
  const include = props.includeSections?.join("\u001f") ?? "";
  const exclude = props.excludeSections?.join("\u001f") ?? "";
  return [
    props.configPath ?? "",
    props.gatewayUrl,
    props.navRootLabel ?? "",
    include,
    exclude,
  ].join("\u001e");
}

function isSensitivePathRevealed(path: Array<string | number>): boolean {
  const key = pathKey(path);
  return key ? cvs.revealedSensitivePaths.has(key) : false;
}

function toggleSensitivePathReveal(path: Array<string | number>) {
  const key = pathKey(path);
  if (!key) {
    return;
  }
  if (cvs.revealedSensitivePaths.has(key)) {
    cvs.revealedSensitivePaths.delete(key);
  } else {
    cvs.revealedSensitivePaths.add(key);
  }
}

export function resetConfigViewStateForTests() {
  resetConfigEphemeralState();
  lastConfigContextKey = null;
}

export function renderConfig(props: ConfigProps) {
  const showModeToggle = props.showModeToggle ?? false;
  const showRootTab = props.showRootTab ?? true;
  const validity = props.valid == null ? "unknown" : props.valid ? "valid" : "invalid";
  const includeVirtualSections = props.includeVirtualSections ?? true;
  const include = props.includeSections?.length ? new Set(props.includeSections) : null;
  const exclude = props.excludeSections?.length ? new Set(props.excludeSections) : null;
  const scopedSchema = scopeSchemaSections(asConfigSchema(props.schema), { include, exclude });
  const analysis = analyzeConfigSchema(scopedSchema);
  const formUnsafe = analysis.schema ? analysis.unsupportedPaths.length > 0 : false;
  const rawAvailable = props.rawAvailable ?? true;
  const formMode = showModeToggle && rawAvailable ? props.formMode : "form";
  const requestUpdate = props.onRequestUpdate ?? (() => {});
  const currentContextKey = configContextKey(props);
  if (lastConfigContextKey !== currentContextKey) {
    resetConfigEphemeralState();
    lastConfigContextKey = currentContextKey;
  }
  const envSensitiveVisible = cvs.envRevealed;

  // Build categorised nav from schema - only include sections that exist in the schema
  const schemaProps = analysis.schema?.properties ?? {};

  const VIRTUAL_SECTIONS = new Set(["__appearance__", "__notifications__"]);
  const localizedCategories = SECTION_CATEGORIES.map((cat) =>
    Object.assign({}, cat, {
      label: translateConfigLabel(cat.label) ?? cat.label,
      sections: cat.sections.map((section) =>
        Object.assign({}, section, {
          label: translateConfigLabel(section.label) ?? section.label,
        }),
      ),
    }),
  );

  const visibleCategories = localizedCategories
    .map((cat) =>
      Object.assign({}, cat, {
        sections: cat.sections.filter(
          (s) =>
            ((includeVirtualSections && VIRTUAL_SECTIONS.has(s.key)) || s.key in schemaProps) &&
            (!include || include.has(s.key)) &&
            (!exclude || !exclude.has(s.key)),
        ),
      }),
    )
    .filter((cat) => cat.sections.length > 0);

  // Catch any schema keys not in our categories
  const extraSections = Object.keys(schemaProps)
    .filter((k) => !CATEGORISED_KEYS.has(k))
    .map((k) => ({ key: k, label: k.charAt(0).toUpperCase() + k.slice(1) }));

  const otherCategory: SectionCategory | null =
    extraSections.length > 0
      ? { id: "other", label: uiText("Other", "Khác"), sections: extraSections }
      : null;

  const isVirtualSection =
    includeVirtualSections &&
    props.activeSection != null &&
    VIRTUAL_SECTIONS.has(props.activeSection);
  const activeSectionSchema =
    props.activeSection &&
    !isVirtualSection &&
    analysis.schema &&
    schemaType(analysis.schema) === "object"
      ? analysis.schema.properties?.[props.activeSection]
      : undefined;
  const activeSectionMeta =
    props.activeSection && !isVirtualSection
      ? resolveSectionMeta(props.activeSection, activeSectionSchema)
      : null;
  // Config subsections are always rendered as a single page per section.
  const effectiveSubsection = null;

  const topTabs = [
    ...(showRootTab
      ? [{ key: null as string | null, label: props.navRootLabel ?? uiText("Settings", "Cài đặt") }]
      : []),
    ...[...visibleCategories, ...(otherCategory ? [otherCategory] : [])].flatMap((cat) =>
      cat.sections.map((s) => ({ key: s.key, label: s.label })),
    ),
  ];

  const settingsLayout = props.settingsLayout ?? "tabs";
  const allCategories = [...visibleCategories, ...(otherCategory ? [otherCategory] : [])];

  const resetContentScroll = (target: EventTarget | null) => {
    queueMicrotask(() => {
      const origin = target instanceof Element ? target : null;
      const content = origin
        ?.closest(".config-main")
        ?.querySelector<HTMLElement>(".config-content");
      if (!content) {
        return;
      }
      if (typeof content.scrollTo === "function") {
        content.scrollTo({ top: 0, left: 0, behavior: "auto" });
        return;
      }
      content.scrollTop = 0;
      content.scrollLeft = 0;
    });
  };

  function renderAccordionNav() {
    return html`
      <div class="config-accordion-nav">
        ${props.onBackToQuick
          ? html`
              <button class="config-accordion-nav__back" @click=${props.onBackToQuick}>
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  width="14"
                  height="14"
                >
                  <polyline points="15 18 9 12 15 6"></polyline>
                </svg>
                ${uiText("Quick Settings", "Cài đặt nhanh")}
              </button>
            `
          : nothing}
        ${allCategories.map(
          (cat) => html`
            <div class="config-accordion-group">
              <button
                class="config-accordion-group__header ${props.activeSection != null &&
                cat.sections.some((s) => s.key === props.activeSection)
                  ? "config-accordion-group__header--active"
                  : ""}"
                @click=${(e: Event) => {
                  const firstKey = cat.sections[0]?.key ?? null;
                  const isCurrentlyInGroup = cat.sections.some(
                    (s) => s.key === props.activeSection,
                  );
                  props.onSectionChange(isCurrentlyInGroup ? null : firstKey);
                  resetContentScroll(e.currentTarget);
                }}
              >
                <span class="config-accordion-group__icon">
                  ${getSectionIcon(cat.sections[0]?.key ?? "default")}
                </span>
                <span>${cat.label}</span>
                <svg
                  class="config-accordion-group__chevron ${cat.sections.some(
                    (s) => s.key === props.activeSection,
                  )
                    ? "config-accordion-group__chevron--open"
                    : ""}"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  width="14"
                  height="14"
                >
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </button>
              ${cat.sections.some((s) => s.key === props.activeSection)
                ? html`
                    <div class="config-accordion-group__items">
                      ${cat.sections.map(
                        (s) => html`
                          <button
                            class="config-accordion-group__item ${props.activeSection === s.key
                              ? "config-accordion-group__item--active"
                              : ""}"
                            @click=${(e: Event) => {
                              props.onSectionChange(s.key);
                              resetContentScroll(e.currentTarget);
                            }}
                          >
                            <span class="config-accordion-group__item-icon">
                              ${getSectionIcon(s.key)}
                            </span>
                            ${s.label}
                          </button>
                        `,
                      )}
                    </div>
                  `
                : nothing}
            </div>
          `,
        )}
      </div>
    `;
  }

  // Compute diff for showing changes (works for both form and raw modes)
  const diff = formMode === "form" ? computeDiff(props.originalValue, props.formValue) : [];
  const hasRawChanges = formMode === "raw" && props.raw !== props.originalRaw;
  if ((!hasRawChanges || formMode !== "raw") && cvs.rawDiffOpen) {
    cvs.rawDiffOpen = false;
  }
  if (!hasRawChanges || formMode !== "raw" || !cvs.rawDiffOpen) {
    rawDiffCache = undefined;
  }
  const rawDiff =
    formMode === "raw" && hasRawChanges && cvs.rawDiffOpen
      ? computeRawDiff(props.originalRaw, props.raw)
      : [];
  const hasChanges = formMode === "form" ? diff.length > 0 : hasRawChanges;

  // Save/apply buttons require actual changes to be enabled.
  // Note: formUnsafe warns about unsupported schema paths but shouldn't block saving.
  const canSaveForm = Boolean(props.formValue) && !props.loading && Boolean(analysis.schema);
  const canSave =
    props.connected && !props.saving && hasChanges && (formMode === "raw" ? true : canSaveForm);
  const canApply =
    props.connected &&
    !props.applying &&
    !props.updating &&
    hasChanges &&
    (formMode === "raw" ? true : canSaveForm);
  const canUpdate = props.connected && !props.applying && !props.updating;
  const renderActionButtonContent = (busy: boolean, label: string, busyLabel: string) =>
    busy
      ? html`<span class="config-action-spinner" aria-hidden="true">${icons.loader}</span
          >${busyLabel}`
      : label;

  const showAppearanceOnRoot =
    includeVirtualSections &&
    formMode === "form" &&
    props.activeSection === null &&
    Boolean(include?.has("__appearance__"));

  return html`
    <div class="config-layout">
      <main class="config-main">
        <div class="config-actions">
          <div class="config-actions__left">
            ${showModeToggle
              ? html`
                  <div class="config-mode-toggle">
                    <button
                      class="config-mode-toggle__btn ${formMode === "form" ? "active" : ""}"
                      ?disabled=${props.schemaLoading || !props.schema}
                      title=${formUnsafe
                        ? uiText(
                            "Form view can't safely edit some fields",
                            "Chế độ form không thể sửa an toàn một số trường",
                          )
                        : ""}
                      @click=${() => props.onFormModeChange("form")}
                    >
                      ${uiText("Form", "Form")}
                    </button>
                    <button
                      class="config-mode-toggle__btn ${formMode === "raw" ? "active" : ""}"
                      ?disabled=${!rawAvailable}
                      title=${rawAvailable
                        ? uiText("Edit raw JSON/JSON5 config", "Sửa cấu hình JSON/JSON5 thô")
                        : uiText(
                            "Raw mode unavailable for this snapshot",
                            "Chế độ thô không khả dụng cho snapshot này",
                          )}
                      @click=${() => props.onFormModeChange("raw")}
                    >
                      ${uiText("Raw", "Thô")}
                    </button>
                  </div>
                `
              : nothing}
            ${hasChanges
              ? html`
                  <span class="config-changes-badge"
                    >${formMode === "raw"
                      ? uiText("Unsaved changes", "Thay đổi chưa lưu")
                      : uiText(
                          `${diff.length} unsaved change${diff.length !== 1 ? "s" : ""}`,
                          `${diff.length} thay đổi chưa lưu`,
                        )}</span
                  >
                `
              : html`
                  <span class="config-status muted"
                    >${uiText("No changes", "Không có thay đổi")}</span
                  >
                `}
          </div>
          <div class="config-actions__right">
            ${!rawAvailable
              ? html`
                  <span class="config-status muted config-actions__notice"
                    >${uiText(
                      "Raw mode disabled (snapshot cannot safely round-trip raw text).",
                      "Chế độ thô đã tắt (snapshot không thể round-trip text thô an toàn).",
                    )}</span
                  >
                `
              : nothing}
            <div class="config-actions__buttons">
              ${props.onOpenFile
                ? html`
                    <button
                      class="btn btn--sm"
                      title=${props.configPath
                        ? uiText(`Open ${props.configPath}`, `Mở ${props.configPath}`)
                        : uiText("Open config file", "Mở tệp cấu hình")}
                      @click=${props.onOpenFile}
                    >
                      ${icons.fileText} ${uiText("Open", "Mở")}
                    </button>
                  `
                : nothing}
              <button class="btn btn--sm" ?disabled=${props.loading} @click=${props.onReload}>
                ${props.loading ? t("common.loading") : t("common.reload")}
              </button>
              <button class="btn btn--sm" ?disabled=${!hasChanges} @click=${props.onReset}>
                ${uiText("Clear", "Xóa")}
              </button>
              <button
                class="btn btn--sm primary"
                ?disabled=${!canSave}
                aria-busy=${props.saving ? "true" : "false"}
                @click=${props.onSave}
              >
                ${renderActionButtonContent(
                  props.saving,
                  uiText("Save", "Lưu"),
                  uiText("Saving…", "Đang lưu…"),
                )}
              </button>
              <button
                class="btn btn--sm"
                ?disabled=${!canApply}
                aria-busy=${props.applying ? "true" : "false"}
                @click=${props.onApply}
              >
                ${renderActionButtonContent(
                  props.applying,
                  uiText("Apply", "Áp dụng"),
                  uiText("Applying…", "Đang áp dụng…"),
                )}
              </button>
              <button
                class="btn btn--sm"
                ?disabled=${!canUpdate}
                aria-busy=${props.updating ? "true" : "false"}
                @click=${props.onUpdate}
              >
                ${renderActionButtonContent(
                  props.updating,
                  uiText("Update", "Cập nhật"),
                  uiText("Updating…", "Đang cập nhật…"),
                )}
              </button>
            </div>
          </div>
        </div>

        ${settingsLayout === "accordion"
          ? renderAccordionNav()
          : html`
              <div class="config-top-tabs">
                ${formMode === "form"
                  ? html`
                      <div class="config-search config-search--top">
                        <div class="config-search__input-row">
                          <svg
                            class="config-search__icon"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                          >
                            <circle cx="11" cy="11" r="8"></circle>
                            <path d="M21 21l-4.35-4.35"></path>
                          </svg>
                          <input
                            type="text"
                            class="config-search__input"
                            placeholder=${uiText("Search settings...", "Tìm cài đặt...")}
                            aria-label=${uiText("Search settings", "Tìm cài đặt")}
                            .value=${props.searchQuery}
                            @input=${(e: Event) =>
                              props.onSearchChange((e.target as HTMLInputElement).value)}
                          />
                          ${props.searchQuery
                            ? html`
                                <button
                                  class="config-search__clear"
                                  aria-label=${uiText("Clear search", "Xóa tìm kiếm")}
                                  @click=${() => props.onSearchChange("")}
                                >
                                  ×
                                </button>
                              `
                            : nothing}
                        </div>
                      </div>
                    `
                  : nothing}

                <div
                  class="config-top-tabs__scroller"
                  role="tablist"
                  aria-label="${t("common.settingsSections")}"
                >
                  ${topTabs.map(
                    (tab) => html`
                      <button
                        class="config-top-tabs__tab ${props.activeSection === tab.key
                          ? "active"
                          : ""}"
                        role="tab"
                        aria-selected=${props.activeSection === tab.key}
                        @click=${(e: Event) => {
                          props.onSectionChange(tab.key);
                          resetContentScroll(e.currentTarget);
                        }}
                        title=${tab.label}
                      >
                        ${tab.label}
                      </button>
                    `,
                  )}
                </div>
              </div>
            `}
        ${validity === "invalid" && !cvs.validityDismissed
          ? html`
              <div class="config-validity-warning">
                <svg
                  class="config-validity-warning__icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  width="16"
                  height="16"
                >
                  <path
                    d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
                  ></path>
                  <line x1="12" y1="9" x2="12" y2="13"></line>
                  <line x1="12" y1="17" x2="12.01" y2="17"></line>
                </svg>
                <span class="config-validity-warning__text"
                  >${uiText(
                    "Your configuration is invalid. Some settings may not work as expected.",
                    "Cấu hình của bạn không hợp lệ. Một số cài đặt có thể không hoạt động như mong đợi.",
                  )}</span
                >
                <button
                  class="btn btn--sm"
                  @click=${() => {
                    cvs.validityDismissed = true;
                    requestUpdate();
                  }}
                >
                  ${uiText("Don't remind again", "Đừng nhắc lại")}
                </button>
              </div>
            `
          : nothing}

        <!-- Diff panel -->
        ${hasChanges && formMode === "form"
          ? html`
              <details class="config-diff">
                <summary class="config-diff__summary">
                  <span>
                    ${uiText(
                      `View ${diff.length} pending change${diff.length !== 1 ? "s" : ""}`,
                      `Xem ${diff.length} thay đổi đang chờ`,
                    )}
                  </span>
                  <svg
                    class="config-diff__chevron"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <polyline points="6 9 12 15 18 9"></polyline>
                  </svg>
                </summary>
                <div class="config-diff__content">
                  ${diff.map(
                    (change) => html`
                      <div class="config-diff__item">
                        <div class="config-diff__path">${formatConfigDiffPath(change.path)}</div>
                        <div class="config-diff__values">
                          <span class="config-diff__from"
                            >${renderDiffValue(change.path, change.from, props.uiHints)}</span
                          >
                          <span class="config-diff__arrow">→</span>
                          <span class="config-diff__to"
                            >${renderDiffValue(change.path, change.to, props.uiHints)}</span
                          >
                        </div>
                      </div>
                    `,
                  )}
                </div>
              </details>
            `
          : nothing}
        ${hasRawChanges && formMode === "raw"
          ? html`
              <details
                class="config-diff"
                ?open=${cvs.rawDiffOpen}
                @toggle=${(e: Event) => {
                  const details = e.target as HTMLDetailsElement;
                  if (cvs.rawDiffOpen === details.open) {
                    return;
                  }
                  cvs.rawDiffOpen = details.open;
                  if (!details.open) {
                    rawDiffCache = undefined;
                  }
                  requestUpdate();
                }}
              >
                <summary class="config-diff__summary">
                  <span>${uiText("View pending changes", "Xem thay đổi đang chờ")}</span>
                  <svg
                    class="config-diff__chevron"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <polyline points="6 9 12 15 18 9"></polyline>
                  </svg>
                </summary>
                <div class="config-diff__content">
                  ${rawDiff.length > 0
                    ? rawDiff.map(
                        (change) => html`
                          <div class="config-diff__item">
                            <div class="config-diff__path">
                              ${formatConfigDiffPath(change.path)}
                            </div>
                            <div class="config-diff__values">
                              <span class="config-diff__from"
                                >${renderRawDiffValue(
                                  change.path,
                                  change.from,
                                  props.uiHints,
                                  cvs.rawRevealed,
                                )}</span
                              >
                              <span class="config-diff__arrow">→</span>
                              <span class="config-diff__to"
                                >${renderRawDiffValue(
                                  change.path,
                                  change.to,
                                  props.uiHints,
                                  cvs.rawRevealed,
                                )}</span
                              >
                            </div>
                          </div>
                        `,
                      )
                    : html`
                        <div class="config-diff__item">
                          ${uiText(
                            "Changes detected (JSON diff not available)",
                            "Đã phát hiện thay đổi (không có diff JSON)",
                          )}
                        </div>
                      `}
                </div>
              </details>
            `
          : nothing}
        ${activeSectionMeta && formMode === "form"
          ? html`
              <div class="config-section-hero">
                <div class="config-section-hero__icon">
                  ${getSectionIcon(props.activeSection ?? "")}
                </div>
                <div class="config-section-hero__text">
                  <div class="config-section-hero__title">${activeSectionMeta.label}</div>
                  ${activeSectionMeta.description
                    ? html`<div class="config-section-hero__desc">
                        ${activeSectionMeta.description}
                      </div>`
                    : nothing}
                </div>
                ${props.activeSection === "env"
                  ? html`
                      <button
                        class="config-env-peek-btn ${envSensitiveVisible
                          ? "config-env-peek-btn--active"
                          : ""}"
                        title=${envSensitiveVisible
                          ? uiText("Hide env values", "Ẩn giá trị env")
                          : uiText("Reveal env values", "Hiện giá trị env")}
                        @click=${() => {
                          cvs.envRevealed = !cvs.envRevealed;
                          requestUpdate();
                        }}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          width="16"
                          height="16"
                        >
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                          <circle cx="12" cy="12" r="3"></circle>
                        </svg>
                        ${uiText("Peek", "Xem nhanh")}
                      </button>
                    `
                  : nothing}
              </div>
            `
          : nothing}
        <!-- Form content -->
        <div class="config-content">
          ${props.activeSection === "__appearance__"
            ? includeVirtualSections
              ? renderAppearanceSection(props)
              : nothing
            : props.activeSection === "__notifications__"
              ? includeVirtualSections
                ? renderNotificationsSection(props)
                : nothing
              : formMode === "form"
                ? html`
                    ${showAppearanceOnRoot ? renderAppearanceSection(props) : nothing}
                    ${props.schemaLoading
                      ? html`
                          <div class="config-loading">
                            <div class="config-loading__spinner"></div>
                            <span>${uiText("Loading schema…", "Đang tải schema…")}</span>
                          </div>
                        `
                      : renderConfigForm({
                          schema: analysis.schema,
                          uiHints: props.uiHints,
                          value: props.formValue,
                          rawAvailable,
                          disabled: props.loading || !props.formValue,
                          unsupportedPaths: analysis.unsupportedPaths,
                          onPatch: props.onFormPatch,
                          searchQuery: props.searchQuery,
                          activeSection: props.activeSection,
                          activeSubsection: effectiveSubsection,
                          revealSensitive:
                            props.activeSection === "env" ? envSensitiveVisible : false,
                          isSensitivePathRevealed,
                          onToggleSensitivePath: (path) => {
                            toggleSensitivePathReveal(path);
                            requestUpdate();
                          },
                        })}
                  `
                : (() => {
                    const sensitiveCount = countSensitiveConfigValues(
                      props.formValue,
                      [],
                      props.uiHints,
                    );
                    const blurred = sensitiveCount > 0 && !cvs.rawRevealed;
                    return html`
                      ${formUnsafe
                        ? html`
                            <div class="callout info" style="margin-bottom: 12px">
                              ${uiText(
                                "Your config contains fields the form editor can't safely represent. Use Raw mode to edit those entries.",
                                "Cấu hình của bạn có trường mà trình sửa form không thể biểu diễn an toàn. Hãy dùng chế độ thô để sửa các mục đó.",
                              )}
                            </div>
                          `
                        : nothing}
                      <div class="field config-raw-field">
                        <span style="display:flex;align-items:center;gap:8px;">
                          ${uiText("Raw config (JSON/JSON5)", "Cấu hình thô (JSON/JSON5)")}
                          ${sensitiveCount > 0
                            ? html`
                                <span class="pill pill--sm"
                                  >${uiText(
                                    `${sensitiveCount} secret${sensitiveCount === 1 ? "" : "s"} ${blurred ? "redacted" : "visible"}`,
                                    `${sensitiveCount} giá trị nhạy cảm ${blurred ? "đã che" : "đang hiển thị"}`,
                                  )}</span
                                >
                                <button
                                  class="btn btn--icon config-raw-toggle ${blurred ? "" : "active"}"
                                  title=${blurred
                                    ? uiText("Reveal sensitive values", "Hiện giá trị nhạy cảm")
                                    : uiText("Hide sensitive values", "Ẩn giá trị nhạy cảm")}
                                  aria-label=${uiText(
                                    "Toggle raw config redaction",
                                    "Bật/tắt che cấu hình thô",
                                  )}
                                  aria-pressed=${!blurred}
                                  @click=${() => {
                                    cvs.rawRevealed = !cvs.rawRevealed;
                                    requestUpdate();
                                  }}
                                >
                                  ${blurred ? icons.eyeOff : icons.eye}
                                </button>
                              `
                            : nothing}
                        </span>
                        ${blurred
                          ? html`
                              <div class="callout info" style="margin-top: 12px">
                                ${uiText(
                                  `${sensitiveCount} sensitive value${sensitiveCount === 1 ? "" : "s"} hidden. Use the reveal button above to edit the raw config.`,
                                  `${sensitiveCount} giá trị nhạy cảm đang bị ẩn. Dùng nút hiện ở trên để sửa cấu hình thô.`,
                                )}
                              </div>
                            `
                          : html`
                              <textarea
                                placeholder=${uiText(
                                  "Raw config (JSON/JSON5)",
                                  "Cấu hình thô (JSON/JSON5)",
                                )}
                                .value=${props.raw}
                                @input=${(e: Event) => {
                                  props.onRawChange((e.target as HTMLTextAreaElement).value);
                                }}
                              ></textarea>
                            `}
                      </div>
                    `;
                  })()}
        </div>

        ${props.issues.length > 0
          ? html`<div class="callout danger" style="margin-top: 12px;">
              <pre class="code-block">${JSON.stringify(props.issues, null, 2)}</pre>
            </div>`
          : nothing}
      </main>
    </div>
  `;
}
