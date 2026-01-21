import { html, type TemplateResult } from "lit";

export function renderEmojiIcon(icon: string, className: string): TemplateResult {
  return html`<span class=${className} aria-hidden="true">${icon}</span>`;
}

export function setEmojiIcon(target: HTMLElement | null, icon: string): void {
  if (!target) return;
  target.textContent = icon;
}
