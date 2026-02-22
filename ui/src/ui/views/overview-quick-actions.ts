import { html } from "lit";
import { t } from "../../i18n/index.ts";
import { icons } from "../icons.ts";

export type OverviewQuickActionsProps = {
  onNavigate: (tab: string) => void;
  onRefresh: () => void;
};

export function renderOverviewQuickActions(props: OverviewQuickActionsProps) {
  return html`
    <section class="ov-quick-actions">
      <button class="btn ov-quick-action-btn" @click=${() => props.onNavigate("chat")}>
        <span class="nav-item__icon">${icons.messageSquare}</span>
        ${t("overview.quickActions.newSession")}
      </button>
      <button class="btn ov-quick-action-btn" @click=${() => props.onNavigate("cron")}>
        <span class="nav-item__icon">${icons.zap}</span>
        ${t("overview.quickActions.automation")}
      </button>
      <button class="btn ov-quick-action-btn" @click=${() => props.onRefresh()}>
        <span class="nav-item__icon">${icons.loader}</span>
        ${t("overview.quickActions.refreshAll")}
      </button>
      <button class="btn ov-quick-action-btn" @click=${() => props.onNavigate("sessions")}>
        <span class="nav-item__icon">${icons.monitor}</span>
        ${t("overview.quickActions.terminal")}
      </button>
    </section>
  `;
}
