/**
 * Navigation Rendering
 * 
 * 侧边栏和导航相关渲染逻辑
 */

import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../external-link.ts";
import { icons } from "../icons.ts";
import { renderTab, renderSidebarConnectionStatus } from "../app-render.helpers.ts";
import { TAB_GROUPS } from "../navigation.ts";
import type { AppViewState } from "../app-view-state.ts";
import { agentLogoUrl } from "../views/agents-utils.ts";

/**
 * 渲染侧边栏
 */
export function renderSidebar(state: AppViewState) {
  const navCollapsed = Boolean(state.settings.navCollapsed && !state.navDrawerOpen);

  return html`
    <aside class="sidebar ${navCollapsed ? "sidebar--collapsed" : ""}">
      <div class="sidebar-shell">
        ${renderSidebarHeader(state, navCollapsed)}
        ${renderSidebarNav(state, navCollapsed)}
        ${renderSidebarFooter(state, navCollapsed)}
      </div>
    </aside>
  `;
}

/**
 * 侧边栏头部
 */
function renderSidebarHeader(state: AppViewState, navCollapsed: boolean) {
  const basePath = state.basePath ?? "";

  return html`
    <div class="sidebar-shell__header">
      <div class="sidebar-brand">
        ${navCollapsed
          ? nothing
          : html`
              <img
                class="sidebar-brand__logo"
                src="${agentLogoUrl(basePath)}"
                alt="OpenClaw"
              />
              <span class="sidebar-brand__copy">
                <span class="sidebar-brand__eyebrow">${t("nav.control")}</span>
                <span class="sidebar-brand__title">OpenClaw</span>
              </span>
            `}
      </div>
      <button
        type="button"
        class="nav-collapse-toggle"
        @click=${() =>
          state.applySettings({
            ...state.settings,
            navCollapsed: !state.settings.navCollapsed,
          })}
        title="${navCollapsed ? t("nav.expand") : t("nav.collapse")}"
        aria-label="${navCollapsed ? t("nav.expand") : t("nav.collapse")}"
      >
        <span class="nav-collapse-toggle__icon" aria-hidden="true"
          >${navCollapsed ? icons.panelLeftOpen : icons.panelLeftClose}</span
        >
      </button>
    </div>
  `;
}

/**
 * 侧边栏导航
 */
function renderSidebarNav(state: AppViewState, navCollapsed: boolean) {
  return html`
    <div class="sidebar-shell__body">
      <nav class="sidebar-nav">
        ${TAB_GROUPS.map((group) => {
          const isGroupCollapsed = state.settings.navGroupsCollapsed[group.label] ?? false;
          const hasActiveTab = group.tabs.some((tab) => tab === state.tab);
          const showItems = navCollapsed || hasActiveTab || !isGroupCollapsed;

          return html`
            <section class="nav-section ${!showItems ? "nav-section--collapsed" : ""}">
              ${!navCollapsed
                ? html`
                    <button
                      class="nav-section__label"
                      @click=${() => {
                        const next = { ...state.settings.navGroupsCollapsed };
                        next[group.label] = !isGroupCollapsed;
                        state.applySettings({
                          ...state.settings,
                          navGroupsCollapsed: next,
                        });
                      }}
                      aria-expanded=${showItems}
                    >
                      <span class="nav-section__label-text">${t(`nav.${group.label}`)}</span>
                      <span class="nav-section__chevron">${icons.chevronDown}</span>
                    </button>
                  `
                : nothing}
              <div class="nav-section__items">
                ${group.tabs.map((tab) => renderTab(state, tab, { collapsed: navCollapsed }))}
              </div>
            </section>
          `;
        })}
      </nav>
    </div>
  `;
}

/**
 * 侧边栏底部
 */
function renderSidebarFooter(state: AppViewState, navCollapsed: boolean) {
  return html`
    <div class="sidebar-shell__footer">
      <div class="sidebar-utility-group">
        <a
          class="nav-item nav-item--external sidebar-utility-link"
          href="https://docs.openclaw.ai"
          target=${EXTERNAL_LINK_TARGET}
          rel=${buildExternalLinkRel()}
          title="${t("common.docs")} (opens in new tab)"
        >
          <span class="nav-item__icon" aria-hidden="true">${icons.book}</span>
          ${!navCollapsed
            ? html`<span class="nav-item__text">${t("common.docs")}</span>`
            : nothing}
        </a>
      </div>
      ${renderSidebarConnectionStatus(state)}
    </div>
  `;
}