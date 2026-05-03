import { html, nothing } from "lit";
import { icons } from "../icons.ts";
import type { AgentsWorkspaceListResult, WorkspaceEntry } from "../types.ts";

export type WorkspacePanelProps = {
  agentId: string;
  entries: AgentsWorkspaceListResult["entries"] | null;
  currentPath: string;
  loading: boolean;
  error: string | null;
  selectedFile: string | null;
  fileContent: string | null;
  editedContent: string | null;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
  onSelectFile: (path: string) => void;
  onContentChange: (content: string) => void;
  onSaveFile: (content: string) => void;
  onDeleteFile: (path: string) => void;
  onMkdir: (name: string) => void;
  onUpload: (files: FileList) => void;
  onDownload: (path: string) => void;
};

export function renderWorkspacePanel(props: WorkspacePanelProps) {
  return html`
    <section class="card workspace-panel">
      <div class="card-title">Workspace Files</div>
      <div class="card-sub">Browse, edit, and manage files in the agent workspace.</div>
      <div class="workspace-content-wrapper">
        ${renderToolbar(props)} ${renderBreadcrumb(props)}
        <div class="workspace-content">${renderFileTree(props)} ${renderFileEditor(props)}</div>
      </div>
    </section>
  `;
}

function renderToolbar(props: WorkspacePanelProps) {
  return html`
    <div class="workspace-toolbar">
      <button
        class="btn btn--sm"
        @click=${() => {
          const name = prompt("Enter folder name:");
          if (name) {
            props.onMkdir(name);
          }
        }}
      >
        <span class="btn-icon">${icons.folder}</span> New Folder
      </button>
      <button
        class="btn btn--sm"
        @click=${() => {
          const input = document.createElement("input");
          input.type = "file";
          input.multiple = true;
          input.addEventListener("change", () => {
            if (input.files) {
              props.onUpload(input.files);
            }
          });
          input.click();
        }}
      >
        <span class="btn-icon">${icons.arrowDown}</span> Upload
      </button>
      <button
        class="btn btn--sm"
        ?disabled=${!props.selectedFile}
        @click=${() => {
          if (props.selectedFile) {
            props.onDownload(props.selectedFile);
          }
        }}
      >
        <span class="btn-icon">${icons.arrowDown}</span> Download
      </button>
      <button class="btn btn--sm" ?disabled=${props.loading} @click=${() => props.onRefresh()}>
        <span class="btn-icon">${icons.refresh}</span> Refresh
      </button>
    </div>
  `;
}

function renderBreadcrumb(props: WorkspacePanelProps) {
  const parts = props.currentPath.split("/").filter(Boolean);
  return html`
    <div class="workspace-breadcrumb">
      <button class="workspace-breadcrumb-item root" @click=${() => props.onNavigate("")}>
        <span class="breadcrumb-icon">${icons.folder}</span>
        <span>Workspace</span>
      </button>
      ${parts.map((part, index) => {
        const path = parts.slice(0, index + 1).join("/");
        return html`
          <span class="workspace-breadcrumb-separator">/</span>
          <button class="workspace-breadcrumb-item" @click=${() => props.onNavigate(path)}>
            ${part}
          </button>
        `;
      })}
    </div>
  `;
}

function getEntryIcon(entry: WorkspaceEntry) {
  if (entry.type === "directory") {
    return icons.folder;
  }
  if (entry.type === "symlink") {
    return icons.link;
  }
  return icons.fileText;
}

function formatFileSize(size: number | undefined): string {
  if (size === undefined) {
    return "";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function renderFileTree(props: WorkspacePanelProps) {
  if (props.loading) {
    return html`
      <div class="workspace-tree">
        <div class="workspace-entry workspace-entry--loading">
          <span class="workspace-entry-icon spinning">${icons.loader}</span>
          <span class="workspace-entry-name muted">Loading...</span>
        </div>
      </div>
    `;
  }

  if (props.error) {
    return html`
      <div class="workspace-tree">
        <div class="callout danger">${props.error}</div>
      </div>
    `;
  }

  if (!props.entries || props.entries.length === 0) {
    return html`
      <div class="workspace-tree">
        <div class="workspace-entry workspace-entry--empty">
          <span class="workspace-entry-icon muted">${icons.folder}</span>
          <span class="workspace-entry-name muted">
            ${props.currentPath === "" ? "Workspace is empty" : "This folder is empty"}
          </span>
        </div>
      </div>
    `;
  }

  // Sort entries: directories first, then files alphabetically
  const sortedEntries = [...props.entries].toSorted((a, b) => {
    if (a.type === "directory" && b.type !== "directory") {
      return -1;
    }
    if (a.type !== "directory" && b.type === "directory") {
      return 1;
    }
    return a.name.localeCompare(b.name);
  });

  return html`
    <div class="workspace-tree">
      ${props.currentPath !== ""
        ? html`
            <div
              class="workspace-entry workspace-entry--parent"
              @click=${() => {
                const parent = props.currentPath.split("/").slice(0, -1).join("/");
                props.onNavigate(parent);
              }}
            >
              <span class="workspace-entry-icon">${icons.folder}</span>
              <span class="workspace-entry-name muted">..</span>
            </div>
          `
        : nothing}
      ${sortedEntries.map(
        (entry) => html`
          <div
            class="workspace-entry ${entry.path === props.selectedFile
              ? "workspace-entry--selected"
              : ""} ${entry.type === "directory" ? "workspace-entry--directory" : ""}"
            @click=${() => {
              if (entry.type === "directory") {
                props.onNavigate(entry.path);
              } else {
                props.onSelectFile(entry.path);
              }
            }}
          >
            <span class="workspace-entry-icon ${entry.type}">${getEntryIcon(entry)}</span>
            <span class="workspace-entry-name">${entry.name}</span>
            ${entry.size !== undefined
              ? html`<span class="workspace-entry-size muted">${formatFileSize(entry.size)}</span>`
              : nothing}
          </div>
        `,
      )}
    </div>
  `;
}

function renderFileEditor(props: WorkspacePanelProps) {
  if (!props.selectedFile) {
    return html`
      <div class="workspace-editor workspace-editor--empty">
        <div class="workspace-editor-placeholder">
          <span class="workspace-editor-placeholder-icon muted">${icons.fileText}</span>
          <span class="muted">Select a file to view or edit</span>
        </div>
      </div>
    `;
  }

  const isDirty = props.editedContent !== null && props.editedContent !== props.fileContent;
  const displayContent = props.editedContent ?? props.fileContent;
  const fileName = props.selectedFile.split("/").pop() || "";

  return html`
    <div class="workspace-editor">
      <div class="workspace-editor-header">
        <div class="workspace-editor-title">
          <span class="workspace-editor-file-icon">${icons.fileText}</span>
          <span class="mono">${fileName}</span>
        </div>
        <div class="workspace-editor-actions">
          <button
            class="btn btn--sm"
            ?disabled=${!isDirty}
            @click=${() => {
              if (displayContent !== null) {
                props.onSaveFile(displayContent);
              }
            }}
          >
            <span class="btn-icon">${icons.check}</span> Save
          </button>
          <button
            class="btn btn--sm btn--danger"
            @click=${() => {
              if (props.selectedFile) {
                if (confirm(`Delete ${fileName}?`)) {
                  props.onDeleteFile(props.selectedFile);
                }
              }
            }}
          >
            <span class="btn-icon">${icons.x}</span> Delete
          </button>
        </div>
      </div>
      <textarea
        class="workspace-editor-textarea"
        .value=${displayContent ?? ""}
        @input=${(e: Event) => {
          const content = (e.target as HTMLTextAreaElement).value;
          props.onContentChange(content);
        }}
        placeholder="File content..."
      ></textarea>
    </div>
  `;
}
