/**
 * Top Bar Rendering
 * 
 * 顶部栏渲染逻辑
 */

import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { icons } from "../icons.ts";
import {
  renderChatMobileToggle,
  renderTopbarThemeModeToggle,
} from "../app-render.helpers.ts";
import type { AppViewState } from "../app-view-state.ts";

/**
 * 渲染顶部栏
 */
export function renderTopBar(state: AppViewState) {
  const isChat = state.tab === "chat";
  const chatFocus = isChat && (state.settings.chatFocusMode || state.onboarding);

  return html`
    <header class="topbar ${chatFocus ? "topbar--focus" : ""}">
      <div class="topbar-inner">
        <div class="topbar-start">
          <button
            type="button"
            class="topbar-menu"
            @click=${() => {
              state.navDrawerOpen = !state.navDrawerOpen;
            }}
            aria-label="Toggle navigation"
          >
            ${icons.menu}
          </button>
          <a
            class="topbar-title"
            href=${state.basePath ?? "/"}
            @click=${(e: Event) => {
              e.preventDefault();
              state.setTab("chat");
            }}
          >
            <span class="topbar-title__text">${t("common.appName")}</span>
          </a>
        </div>
        <div class="topbar-end">
          <button
            type="button"
            class="topbar-search"
            @click=${() => {
              state.paletteOpen = !state.paletteOpen;
              if (state.paletteOpen) {
                state.paletteQuery = "";
                state.paletteActiveIndex = 0;
              }
            }}
            aria-label="Open command palette"
          >
            <span class="topbar-search__label">${t("common.search")}</span>
            <kbd class="topbar-search__kbd">⌘K</kbd>
          </button>
          <div class="topbar-status">
            ${isChat ? renderChatMobileToggle(state) : nothing}
            ${renderTopbarThemeModeToggle(state)}
          </div>
        </div>
      </div>
    </header>
  `;
}