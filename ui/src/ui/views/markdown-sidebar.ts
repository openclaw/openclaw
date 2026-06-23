// Control UI view renders markdown sidebar screen content.
import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { resolveCanvasIframeUrl } from "../canvas-url.ts";
import { resolveEmbedSandbox, type EmbedSandboxMode } from "../embed-sandbox.ts";
import { icons } from "../icons.ts";
import { toSanitizedMarkdownHtml } from "../markdown.ts";
import type { SidebarContent } from "../sidebar-content.ts";

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
  const editableTextFile = content?.kind === "markdown" ? content.editableTextFile : undefined;
  const markdownHtml =
    content?.kind === "markdown" && !editableTextFile && content.content.trim()
      ? toSanitizedMarkdownHtml(content.content)
      : "";
  const canvasSandbox =
    content?.kind === "canvas"
      ? resolveSidebarCanvasSandbox(content, props.embedSandboxMode ?? "scripts")
      : "";
  const canvasSrc =
    content?.kind === "canvas"
      ? resolveCanvasIframeUrl(
          content.entryUrl,
          props.canvasPluginSurfaceUrl,
          props.allowExternalEmbedUrls ?? false,
        )
      : null;
  const title =
    content?.kind === "canvas"
      ? content.title?.trim() || "Render Preview"
      : content?.kind === "image"
        ? content.title.trim() || "Image Preview"
        : content?.kind === "markdown"
          ? content.title?.trim() || "Markdown Preview"
          : "Tool Details";
  return html`
    <div class="sidebar-panel">
      <div class="sidebar-header">
        <div class="sidebar-title">${title}</div>
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
              ${content?.rawText?.trim()
                ? html`
                    <button
                      @click=${props.onViewRawText}
                      class="btn"
                      type="button"
                      style="margin-top: 12px;"
                    >
                      View Raw Text
                    </button>
                  `
                : nothing}
            `
          : content
            ? content.kind === "canvas"
              ? html`
                  <div class="chat-tool-card__preview" data-kind="canvas">
                    <div class="chat-tool-card__preview-panel" data-side="front">
                      ${keyed(
                        `${canvasSandbox}\u0000${canvasSrc ?? ""}\u0000${content.preferredHeight ?? ""}`,
                        html`
                          <iframe
                            class="chat-tool-card__preview-frame"
                            title=${content.title?.trim() || "Render preview"}
                            sandbox=${canvasSandbox}
                            src=${canvasSrc ?? nothing}
                            style=${content.preferredHeight
                              ? `height:${content.preferredHeight}px`
                              : ""}
                          ></iframe>
                        `,
                      )}
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
              : content.kind === "image"
                ? html`
                    <div class="chat-tool-card__preview" data-kind="image">
                      <div class="chat-tool-card__preview-panel" data-side="front">
                        <img
                          class="chat-tool-card__preview-image"
                          src=${content.src}
                          alt=${title}
                          style="display:block;max-width:100%;height:auto;border-radius:8px;"
                        />
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
                : editableTextFile
                  ? html`
                      <section class="sidebar-file-editor">
                        <div class="sidebar-markdown-shell__toolbar">
                          <div class="sidebar-markdown-shell__intro">
                            <div class="sidebar-markdown-shell__eyebrow">
                              ${icons.edit}
                              <span>Text File</span>
                            </div>
                            <div class="sidebar-markdown-shell__hint" translate="no">
                              ${editableTextFile.path}
                            </div>
                          </div>
                          <div style="display:flex; gap:8px; align-items:center;">
                            <button
                              @click=${editableTextFile.onReset}
                              class="btn btn--sm"
                              type="button"
                              ?disabled=${!editableTextFile.dirty || editableTextFile.saving}
                            >
                              Reset
                            </button>
                            <button
                              @click=${editableTextFile.onSave}
                              class="btn btn--sm primary"
                              type="button"
                              ?disabled=${!editableTextFile.dirty || editableTextFile.saving}
                            >
                              ${editableTextFile.saving ? "Saving" : "Save"}
                            </button>
                          </div>
                        </div>
                        <div
                          style="display:flex; gap:8px; flex-wrap:wrap; margin:12px 0;"
                          aria-label="File metadata"
                        >
                          ${editableTextFile.dirty
                            ? html`<span class="chip chip-warn">Unsaved</span>`
                            : html`<span class="chip">Saved</span>`}
                          ${editableTextFile.sizeLabel
                            ? html`<span class="chip">${editableTextFile.sizeLabel}</span>`
                            : nothing}
                          ${editableTextFile.updatedLabel
                            ? html`<span class="chip">${editableTextFile.updatedLabel}</span>`
                            : nothing}
                        </div>
                        <textarea
                          class="sidebar-file-editor__textarea"
                          spellcheck="false"
                          .value=${editableTextFile.draft}
                          @input=${(event: Event) =>
                            editableTextFile.onDraftChange(
                              (event.target as HTMLTextAreaElement).value,
                            )}
                          style="width:100%; min-height: min(58vh, 720px); resize: vertical; font-family: var(--mono); font-size: 13px; line-height: 1.5; color: var(--text); background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 8px; padding: 12px;"
                        ></textarea>
                      </section>
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
                        ${markdownHtml
                          ? html`
                              <article class="sidebar-markdown-reader sidebar-markdown">
                                ${unsafeHTML(markdownHtml)}
                              </article>
                            `
                          : html`
                              <div class="sidebar-markdown-empty">
                                No previewable markdown content.
                              </div>
                            `}
                      </section>
                    `
            : html` <div class="muted">No content available</div> `}
      </div>
    </div>
  `;
}
