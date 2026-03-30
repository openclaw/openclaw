/**
 * App Shell Rendering
 * 
 * 应用外壳渲染（协调各渲染模块）
 */

import { html } from "lit";
import type { AppViewState } from "../app-view-state.ts";
import { renderSidebar } from "./nav-render.ts";
import { renderTopBar } from "./topbar-render.ts";
import { renderMainContent } from "./main-content-render.ts";
import { setPendingUpdate } from "./lazy-helpers.ts";

/**
 * 渲染应用外壳
 */
export function renderAppShell(state: AppViewState) {
  // 设置懒加载更新回调
  const updatableState = state as AppViewState & { requestUpdate?: () => void };
  setPendingUpdate(
    typeof updatableState.requestUpdate === "function"
      ? () => updatableState.requestUpdate?.()
      : undefined
  );

  const chatFocus =
    state.tab === "chat" && (state.settings.chatFocusMode || state.onboarding);
  const navDrawerOpen = Boolean(state.navDrawerOpen && !chatFocus && !state.onboarding);

  return html`
    <div class="app-shell ${chatFocus ? "app-shell--focus" : ""}">
      ${renderTopBar(state)}
      <div class="shell-body">
        ${navDrawerOpen ? html`<div class="nav-drawer-overlay" @click=${() => {
          state.navDrawerOpen = false;
        }}></div>` : null}
        ${renderSidebar(state)}
        ${renderMainContent(state)}
      </div>
    </div>
  `;
}