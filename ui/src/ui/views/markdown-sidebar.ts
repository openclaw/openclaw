import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { resolveCanvasIframeUrl } from "../canvas-url.ts";
import { resolveEmbedSandbox, type EmbedSandboxMode } from "../embed-sandbox.ts";
import { icons } from "../icons.ts";
import { toSanitizedMarkdownHtml } from "../markdown.ts";
import type { SidebarContent } from "../sidebar-content.ts";
import { viDashboardText as uiText } from "../vi-dashboard-text.ts";

function resolveSidebarCanvasSandbox(
  content: SidebarContent,
  embedSandboxMode: EmbedSandboxMode,
): string {
  return content.kind === "canvas" ? resolveEmbedSandbox(embedSandboxMode) : "allow-scripts";
}

export type MarkdownSidebarProps = {
  content: SidebarContent | null;
  error: string | null;
  onClose: () => void;
  onViewRawText: () => void;
  canvasPluginSurfaceUrl?: string | null;
  embedSandboxMode?: EmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
};

export function renderMarkdownSidebar(props: MarkdownSidebarProps) {
  const content = props.content;
  return html`
    <div class="sidebar-panel">
      <div class="sidebar-header">
        <div class="sidebar-title">
          ${content?.kind === "canvas"
            ? content.title?.trim() || uiText("Render Preview", "Xem trước render")
            : content?.kind === "markdown"
              ? uiText("Markdown Preview", "Xem trước Markdown")
              : uiText("Tool Details", "Chi tiết công cụ")}
        </div>
        <button
          @click=${props.onClose}
          class="btn"
          type="button"
          title=${uiText("Close sidebar", "Đóng thanh bên")}
          aria-label=${uiText("Close sidebar", "Đóng thanh bên")}
        >
          ${icons.x}
        </button>
      </div>
      <div class="sidebar-content">
        ${props.error
          ? html`
              <div class="callout danger">${props.error}</div>
              <button
                @click=${props.onViewRawText}
                class="btn"
                type="button"
                style="margin-top: 12px;"
              >
                ${uiText("View Raw Text", "Xem văn bản thô")}
              </button>
            `
          : content
            ? content.kind === "canvas"
              ? html`
                  <div class="chat-tool-card__preview" data-kind="canvas">
                    <div class="chat-tool-card__preview-panel" data-side="front">
                      <iframe
                        class="chat-tool-card__preview-frame"
                        title=${content.title?.trim() ||
                        uiText("Render preview", "Xem trước render")}
                        sandbox=${resolveSidebarCanvasSandbox(
                          content,
                          props.embedSandboxMode ?? "scripts",
                        )}
                        src=${resolveCanvasIframeUrl(
                          content.entryUrl,
                          props.canvasPluginSurfaceUrl,
                          props.allowExternalEmbedUrls ?? false,
                        ) ?? nothing}
                        style=${content.preferredHeight
                          ? `height:${content.preferredHeight}px`
                          : ""}
                      ></iframe>
                    </div>
                    ${content.rawText?.trim()
                      ? html`
                          <div style="margin-top: 12px;">
                            <button @click=${props.onViewRawText} class="btn" type="button">
                              ${uiText("View Raw Text", "Xem văn bản thô")}
                            </button>
                          </div>
                        `
                      : nothing}
                  </div>
                `
              : html`
                  <section class="sidebar-markdown-shell">
                    <div class="sidebar-markdown-shell__toolbar">
                      <div class="sidebar-markdown-shell__intro">
                        <div class="sidebar-markdown-shell__eyebrow">
                          ${icons.scrollText}
                          <span>${uiText("Rendered Markdown", "Markdown đã render")}</span>
                        </div>
                        <div class="sidebar-markdown-shell__hint">
                          ${uiText(
                            "Sanitized rich-text preview for quick reading.",
                            "Bản xem trước rich-text đã làm sạch để đọc nhanh.",
                          )}
                        </div>
                      </div>
                      <button @click=${props.onViewRawText} class="btn btn--sm" type="button">
                        ${uiText("View Raw Text", "Xem văn bản thô")}
                      </button>
                    </div>
                    <article class="sidebar-markdown-reader sidebar-markdown">
                      ${unsafeHTML(toSanitizedMarkdownHtml(content.content))}
                    </article>
                  </section>
                `
            : html`
                <div class="muted">${uiText("No content available", "Không có nội dung")}</div>
              `}
      </div>
    </div>
  `;
}
