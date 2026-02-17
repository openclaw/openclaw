import { html, type TemplateResult } from "lit";

export type EmptyStateProps = {
  icon: TemplateResult;
  title: string;
  subtitle?: string;
};

export function renderEmptyState(props: EmptyStateProps) {
  return html`
    <div class="empty-state">
      <div class="empty-state__icon">${props.icon}</div>
      <div class="empty-state__title">${props.title}</div>
      ${props.subtitle ? html`<div class="empty-state__subtitle">${props.subtitle}</div>` : ""}
    </div>
  `;
}

export function renderSpinner(label?: string) {
  return html`
    <div class="spinner-container">
      <div class="spinner"></div>
      ${label ? html`<span class="muted">${label}</span>` : ""}
    </div>
  `;
}
