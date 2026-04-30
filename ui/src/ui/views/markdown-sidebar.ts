import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { resolveCanvasIframeUrl } from "../canvas-url.ts";
import { renderToolDataBlock } from "../chat/tool-cards.ts";
import { resolveEmbedSandbox, type EmbedSandboxMode } from "../embed-sandbox.ts";
import { icons } from "../icons.ts";
import { toSanitizedMarkdownHtml } from "../markdown.ts";
import type { SidebarContent, ToolSidebarContent } from "../sidebar-content.ts";

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
  canvasHostUrl?: string | null;
  embedSandboxMode?: EmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
};

function resolveSidebarTitle(content: SidebarContent | null): string {
  if (!content) {
    return "Tool Details";
  }
  if (content.kind === "canvas") {
    return content.title?.trim() || "Render Preview";
  }
  if (content.kind === "tool") {
    return content.toolLabel?.trim() || content.toolName?.trim() || "Tool Details";
  }
  return "Markdown Preview";
}

function renderToolSidebarBody(content: ToolSidebarContent, onViewRawText: () => void) {
  const inputText = content.inputText?.trim() ? content.inputText : "";
  const outputText = content.outputText?.trim() ? content.outputText : "";
  const showInput = Boolean(inputText);
  const showOutput = Boolean(outputText);
  const canViewRaw = Boolean(content.rawText?.trim());
  return html`
    <section class="sidebar-tool">
      <header class="sidebar-tool__header">
        <div class="sidebar-tool__name-row">
          <span class="sidebar-tool__icon">${icons.zap}</span>
          <span class="sidebar-tool__label">${content.toolLabel || content.toolName}</span>
        </div>
        <code class="sidebar-tool__name mono">${content.toolName}</code>
        ${content.detail
          ? html`<div class="sidebar-tool__detail">${content.detail}</div>`
          : nothing}
      </header>
      <div class="sidebar-tool__section">
        ${showInput
          ? renderToolDataBlock({
              label: "Tool input",
              text: inputText,
              expanded: true,
            })
          : renderToolDataBlock({
              label: "Tool input",
              text: "No input arguments.",
              expanded: true,
              empty: true,
            })}
      </div>
      <div class="sidebar-tool__section">
        ${showOutput
          ? renderToolDataBlock({
              label: "Tool output",
              text: outputText,
              expanded: true,
            })
          : renderToolDataBlock({
              label: "Tool output",
              text: "No output — tool completed successfully.",
              expanded: true,
              empty: true,
            })}
      </div>
      ${canViewRaw
        ? html`
            <div class="sidebar-tool__footer">
              <button @click=${onViewRawText} class="btn btn--sm" type="button">
                View Raw Text
              </button>
            </div>
          `
        : nothing}
    </section>
  `;
}

export function renderMarkdownSidebar(props: MarkdownSidebarProps) {
  const content = props.content;
  return html`
    <div class="sidebar-panel">
      <div class="sidebar-header">
        <div class="sidebar-title">${resolveSidebarTitle(content)}</div>
        <button
          @click=${props.onClose}
          class="btn"
          type="button"
          title="Close sidebar"
          aria-label="Close sidebar"
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
                View Raw Text
              </button>
            `
          : content
            ? content.kind === "tool"
              ? renderToolSidebarBody(content, props.onViewRawText)
              : content.kind === "canvas"
                ? html`
                    <div class="chat-tool-card__preview" data-kind="canvas">
                      <div class="chat-tool-card__preview-panel" data-side="front">
                        <iframe
                          class="chat-tool-card__preview-frame"
                          title=${content.title?.trim() || "Render preview"}
                          sandbox=${resolveSidebarCanvasSandbox(
                            content,
                            props.embedSandboxMode ?? "scripts",
                          )}
                          src=${resolveCanvasIframeUrl(
                            content.entryUrl,
                            props.canvasHostUrl,
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
                                View Raw Text
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
                            <span>Rendered Markdown</span>
                          </div>
                          <div class="sidebar-markdown-shell__hint">
                            Sanitized rich-text preview for quick reading.
                          </div>
                        </div>
                        <button @click=${props.onViewRawText} class="btn btn--sm" type="button">
                          View Raw Text
                        </button>
                      </div>
                      <article class="sidebar-markdown-reader sidebar-markdown">
                        ${unsafeHTML(toSanitizedMarkdownHtml(content.content))}
                      </article>
                    </section>
                  `
            : html` <div class="muted">No content available</div> `}
      </div>
    </div>
  `;
}
