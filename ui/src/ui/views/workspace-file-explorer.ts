// Control UI workspace file explorer component.
// Renders a tree of files/directories in the agent workspace for browsing.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { icons } from "../icons.ts";
import { formatRelativeTimestamp } from "../format.ts";
import { formatBytes } from "./agents-utils.ts";
import type {
  AgentsFilesBrowseResult,
  WorkspaceFileBrowseEntry,
} from "../types.ts";

export type WorkspaceExplorerProps = {
  agentId: string;
  result: AgentsFilesBrowseResult | null;
  loading: boolean;
  error: string | null;
  selectedPath: string | null;
  onBrowse: (agentId: string, path: string) => void;
  onSelect: (path: string) => void;
};

function entryIcon(kind: "file" | "directory"): string {
  return kind === "directory" ? icons.folder : icons.fileText;
}

function sortedEntries(
  entries: readonly WorkspaceFileBrowseEntry[],
): WorkspaceFileBrowseEntry[] {
  return [...entries].sort((a, b) => {
    // Directories first, then alphabetical
    if (a.kind !== b.kind) {
      return a.kind === "directory" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

function renderBreadcrumb(
  workspace: string,
  path: string,
  onNavigate: (path: string) => void,
) {
  const parts = path === "." ? [] : path.split("/");
  const crumbs: Array<{ label: string; path: string }> = [
    { label: "~", path: "." },
  ];
  for (let i = 0; i < parts.length; i++) {
    const cumulative = parts.slice(0, i + 1).join("/");
    crumbs.push({ label: parts[i], path: cumulative });
  }

  return html`
    <nav class="workspace-breadcrumb" style="display:flex; flex-wrap:wrap; gap:4px; align-items:center; margin-bottom:12px;">
      ${crumbs.map((crumb, idx) => html`
        ${idx > 0 ? html`<span class="muted" style="margin:0 2px;">/</span>` : nothing}
        <button
          type="button"
          class="btn btn--sm btn--ghost"
          style="font-family:monospace;"
          @click=${() => onNavigate(crumb.path)}
        >
          ${crumb.label}
        </button>
      `)}
    </nav>
  `;
}

export function renderWorkspaceExplorer(props: WorkspaceExplorerProps) {
  const { result, loading, error, selectedPath, onBrowse, onSelect } = props;

  return html`
    <section class="card" style="margin-top:16px;">
      <div class="row" style="justify-content:space-between; align-items:center;">
        <div>
          <div class="card-title">${t("agents.files.allFilesTitle", "All Files")}</div>
          <div class="card-sub">${t("agents.files.allFilesSubtitle", "Browse every file in the workspace")}</div>
        </div>
        <button
          class="btn btn--sm"
          ?disabled=${loading}
          @click=${() => onBrowse(props.agentId, result?.path ?? ".")}
        >
          ${loading ? t("common.loading") : t("common.refresh")}
        </button>
      </div>

      ${error
        ? html`<div class="callout danger" style="margin-top:12px;">${error}</div>`
        : nothing}

      ${!result
        ? html`<div class="callout info" style="margin-top:12px">${t("agents.files.loadHint")}</div>`
        : html`
          <div class="muted mono" style="margin-top:8px;">
            ${t("agents.files.workspace")}: <span>${result.workspace}</span>
          </div>
          ${renderBreadcrumb(result.workspace, result.path, (p) => onBrowse(props.agentId, p))}
          ${result.truncated
            ? html`<div class="callout warn" style="margin-bottom:8px;">${t("agents.files.truncated", "Showing first 500 entries")}</div>`
            : nothing}
          <div class="workspace-file-list" style="max-height:400px; overflow-y:auto; border:1px solid var(--border-color); border-radius:6px;">
            ${sortedEntries(result.entries).length === 0
              ? html`<div class="muted" style="padding:16px; text-align:center;">${t("agents.files.empty", "No files")}</div>`
              : html`
                <table style="width:100%; border-collapse:collapse;">
                  <thead>
                    <tr class="muted mono" style="font-size:12px; border-bottom:1px solid var(--border-color);">
                      <th style="padding:8px 12px; text-align:left; width:60%;">${t("agents.files.name", "Name")}</th>
                      <th style="padding:8px 12px; text-align:right; width:20%;">${t("agents.files.size", "Size")}</th>
                      <th style="padding:8px 12px; text-align:right; width:20%;">${t("agents.files.updated", "Updated")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${sortedEntries(result.entries).map((entry) => {
                      const isSelected = selectedPath === entry.path;
                      const isDir = entry.kind === "directory";
                      return html`
                        <tr
                          class="workspace-file-row ${isSelected ? "selected" : ""}"
                          style="cursor:pointer; border-bottom:1px solid var(--border-color); background:${isSelected ? "var(--accent-bg, rgba(0,0,0,0.05))" : "transparent"};"
                          @click=${() => {
                            if (isDir) {
                              onBrowse(props.agentId, entry.path);
                            } else {
                              onSelect(entry.path);
                            }
                          }}
                        >
                          <td style="padding:6px 12px; font-family:monospace;">
                            ${isDir ? icons.folder : icons.file}
                            <span style="margin-left:6px;">${entry.name}</span>
                          </td>
                          <td style="padding:6px 12px; text-align:right; font-family:monospace; font-size:12px;">
                            ${isDir ? "—" : (entry.size != null ? formatBytes(entry.size) : "—")}
                          </td>
                          <td style="padding:6px 12px; text-align:right; font-family:monospace; font-size:12px; color:var(--muted-color);">
                            ${entry.updatedAtMs ? formatRelativeTimestamp(entry.updatedAtMs) : "—"}
                          </td>
                        </tr>
                      `;
                    })}
                  </tbody>
                </table>
              `}
          </div>
        `}
    </section>
  `;
}