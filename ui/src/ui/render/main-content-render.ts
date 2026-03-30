/**
 * Main Content Rendering
 * 
 * 主内容区域渲染逻辑
 */

import { html, nothing } from "lit";
import { renderChat } from "../views/chat.ts";
import { renderConfig } from "../views/config.ts";
import { renderUsageTab } from "../app-render-usage-tab.ts";
import type { AppViewState } from "../app-view-state.ts";
import { loadChatHistory } from "../controllers/chat.ts";
import { refreshChatAvatar } from "../app-chat.ts";

// 懒加载模块
import { createLazy, lazyRender } from "./lazy-helpers.ts";

const lazyAgents = createLazy(() => import("../views/agents.ts"));
const lazyChannels = createLazy(() => import("../views/channels.ts"));
const lazyCron = createLazy(() => import("../views/cron.ts"));
const lazyDebug = createLazy(() => import("../views/debug.ts"));
const lazyInstances = createLazy(() => import("../views/instances.ts"));
const lazyLogs = createLazy(() => import("../views/logs.ts"));
const lazyNodes = createLazy(() => import("../views/nodes.ts"));
const lazySessions = createLazy(() => import("../views/sessions.ts"));
const lazySkills = createLazy(() => import("../views/skills.ts"));

/**
 * 渲染主内容区域
 */
export function renderMainContent(state: AppViewState) {
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const showToolCalls = state.onboarding ? true : state.settings.chatShowToolCalls;
  const assistantAvatarUrl = resolveAssistantAvatarUrl(state);
  const chatAvatarUrl = state.chatAvatarUrl ?? assistantAvatarUrl ?? null;

  return html`
    <main class="main-content">
      ${renderTabContent(state, showThinking, showToolCalls, chatAvatarUrl)}
    </main>
  `;
}

/**
 * 渲染 Tab 内容
 */
function renderTabContent(
  state: AppViewState,
  showThinking: boolean,
  showToolCalls: boolean,
  chatAvatarUrl: string | null
) {
  switch (state.tab) {
    case "chat":
      return renderChatContent(state, showThinking, showToolCalls, chatAvatarUrl);

    case "config":
    case "communications":
    case "appearance":
    case "automation":
    case "infrastructure":
    case "ai-agents":
      return renderConfigContent(state);

    case "usage":
      return renderUsageTab(state);

    case "sessions":
      return lazyRender(lazySessions, (m) =>
        m.renderSessions({
          // ... sessions props
        }),
      );

    case "cron":
      return lazyRender(lazyCron, (m) =>
        m.renderCron({
          // ... cron props
        }),
      );

    case "agents":
      return lazyRender(lazyAgents, (m) =>
        m.renderAgents({
          // ... agents props
        }),
      );

    case "channels":
      return lazyRender(lazyChannels, (m) =>
        m.renderChannels({
          // ... channels props
        }),
      );

    case "skills":
      return lazyRender(lazySkills, (m) =>
        m.renderSkills({
          // ... skills props
        }),
      );

    case "instances":
      return lazyRender(lazyInstances, (m) =>
        m.renderInstances({
          // ... instances props
        }),
      );

    case "nodes":
      return lazyRender(lazyNodes, (m) =>
        m.renderNodes({
          // ... nodes props
        }),
      );

    case "debug":
      return lazyRender(lazyDebug, (m) =>
        m.renderDebug({
          // ... debug props
        }),
      );

    case "logs":
      return lazyRender(lazyLogs, (m) =>
        m.renderLogs({
          // ... logs props
        }),
      );

    default:
      return nothing;
  }
}

/**
 * 渲染聊天内容
 */
function renderChatContent(
  state: AppViewState,
  showThinking: boolean,
  showToolCalls: boolean,
  chatAvatarUrl: string | null
) {
  return renderChat({
    sessionKey: state.sessionKey,
    onSessionKeyChange: (next) => {
      state.sessionKey = next;
      state.chatMessage = "";
      state.chatAttachments = [];
      state.chatStream = null;
      state.chatStreamStartedAt = null;
      state.chatRunId = null;
      state.chatQueue = [];
      state.resetToolStream();
      state.resetChatScroll();
      state.applySettings({
        ...state.settings,
        sessionKey: next,
        lastActiveSessionKey: next,
      });
      void state.loadAssistantIdentity();
      void loadChatHistory(state);
      void refreshChatAvatar(state);
    },
    thinkingLevel: state.chatThinkingLevel,
    showThinking,
    showToolCalls,
    // ... 其他 props
  });
}

/**
 * 渲染配置内容
 */
function renderConfigContent(state: AppViewState) {
  return renderConfig({
    // ... config props
  });
}

/**
 * 解析助手头像 URL
 */
function resolveAssistantAvatarUrl(state: AppViewState): string | undefined {
  if (state.assistantAvatar) {
    return state.assistantAvatar;
  }
  return undefined;
}