import { html, nothing } from "lit";
import type { FsEntry } from "../controllers/files.ts";

export type FilesProps = {
  connected: boolean;
  fsPath: string;
  fsLoading: boolean;
  fsEntries: FsEntry[];
  fsError: string | null;
  fsFileContent: string | null;
  fsFilePath: string | null;
  fsFileLoading: boolean;
  onFsNavigate: (path: string) => void;
  onFsUp: () => void;
  onFsRefresh: () => void;
  onFsFileOpen: (path: string) => void;
  onFsFileClose: () => void;
};

function renderFsEntry(entry: FsEntry, props: FilesProps) {
  const isDir = entry.type === "directory";
  const icon = isDir ? "📁" : entry.type === "symlink" ? "🔗" : "📄";

  return html`
    <tr
      class="fs-entry ${isDir ? "fs-entry--dir" : "fs-entry--file"}"
      @click=${() => {
        if (isDir) {
          props.onFsNavigate(entry.path);
        } else {
          props.onFsFileOpen(entry.path);
        }
      }}
    >
      <td class="fs-entry__icon">${icon}</td>
      <td class="fs-entry__name">${entry.name}${isDir ? "/" : ""}</td>
      <td class="fs-entry__type">${entry.type}</td>
    </tr>
  `;
}

function renderFileViewer(props: FilesProps) {
  if (!props.fsFilePath) {
    return nothing;
  }

  return html`
    <div class="fs-file-viewer">
      <div class="fs-file-viewer__header">
        <div class="fs-file-viewer__path">${props.fsFilePath}</div>
        <button class="btn btn--sm" @click=${props.onFsFileClose}>Close</button>
      </div>
      ${
        props.fsFileLoading
          ? html`
              <div class="fs-file-viewer__loading">Loading…</div>
            `
          : html`<pre class="fs-file-viewer__content">${props.fsFileContent}</pre>`
      }
    </div>
  `;
}

export function renderFiles(props: FilesProps) {
  return html`
    <div class="terminal-page">
      ${
        !props.connected
          ? html`
              <div
                class="terminal-entry__meta terminal-entry__meta--warn"
                style="padding: 8px 12px; margin-bottom: 4px"
              >
                \u26A0 Not connected to gateway
              </div>
            `
          : nothing
      }
      <div class="terminal-files">
        <div class="fs-toolbar">
          <button class="btn btn--sm" @click=${props.onFsUp} title="Go up">⬆ Up</button>
          <div class="fs-path-bar">
            <span class="fs-path-bar__label">Path:</span>
            <input
              class="fs-path-bar__input"
              type="text"
              .value=${props.fsPath}
              placeholder=${props.fsPath}
              ?disabled=${props.fsLoading}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  const input = e.target as HTMLInputElement;
                  const path = input.value.trim();
                  if (path) {
                    props.onFsNavigate(path);
                  }
                }
              }}
              @focus=${(e: Event) => {
                const input = e.target as HTMLInputElement;
                input.select();
              }}
            />
          </div>
          <button class="btn btn--sm" @click=${props.onFsRefresh} ?disabled=${props.fsLoading}>
            ${props.fsLoading ? "Loading…" : "Refresh"}
          </button>
        </div>

        ${props.fsError ? html`<div class="callout danger">${props.fsError}</div>` : nothing}

        ${props.fsFilePath ? renderFileViewer(props) : nothing}

        ${
          !props.fsFilePath
            ? html`
              <div class="fs-list-container">
                ${
                  props.fsEntries.length === 0 && !props.fsLoading
                    ? html`
                        <div class="fs-empty">Directory is empty</div>
                      `
                    : nothing
                }
                ${
                  props.fsEntries.length > 0
                    ? html`
                      <table class="fs-table">
                        <thead>
                          <tr>
                            <th></th>
                            <th>Name</th>
                            <th>Type</th>
                          </tr>
                        </thead>
                        <tbody>
                          ${props.fsEntries.map((entry) => renderFsEntry(entry, props))}
                        </tbody>
                      </table>
                    `
                    : nothing
                }
              </div>
            `
            : nothing
        }
      </div>
    </div>
  `;
}
