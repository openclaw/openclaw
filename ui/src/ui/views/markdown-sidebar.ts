import { html } from "lit";
import { t } from "../../i18n/index.ts";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { icons } from "../icons.ts";
import { toSanitizedMarkdownHtml } from "../markdown.ts";

export type MarkdownSidebarProps = {
  content: string | null;
  error: string | null;
  onClose: () => void;
  onViewRawText: () => void;
};

export function renderMarkdownSidebar(props: MarkdownSidebarProps) {
  return html`
    <div class="sidebar-panel">
      <div class="sidebar-header">
        <div class="sidebar-title">${t("markdown.sidebar.title")}</div>
        <button @click=${props.onClose} class="btn" title=${t("markdown.sidebar.close")}>
          ${icons.x}
        </button>
      </div>
      <div class="sidebar-content">
        ${
          props.error
            ? html`
              <div class="callout danger">${props.error}</div>
              <button @click=${props.onViewRawText} class="btn" style="margin-top: 12px;">
                ${t("markdown.sidebar.viewRaw")}
              </button>
            `
            : props.content
              ? html`<div class="sidebar-markdown">${unsafeHTML(toSanitizedMarkdownHtml(props.content))}</div>`
              : html`
                  <div class="muted">${t("markdown.sidebar.noContent")}</div>
                `
        }
      </div>
    </div>
  `;
}
