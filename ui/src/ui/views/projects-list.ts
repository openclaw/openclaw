import { html, nothing } from "lit";
import type { ProjectListEntry, BoardIndex, QueueIndex } from "../controllers/projects.ts";

export type ProjectsListProps = {
  loading: boolean;
  error: string | null;
  projects: ProjectListEntry[] | null;
  boards: Record<string, BoardIndex>;
  queues: Record<string, QueueIndex>;
  onSelectProject: (name: string) => void;
  onRefresh: () => void;
};

/** Render the project list table with status badges, task counts, and agent counts. */
export function renderProjectsList(props: ProjectsListProps) {
  // Error state
  if (props.error) {
    return html`
      <div class="projects-error">
        Failed to load project data. Try refreshing the page.
        <button class="btn btn-sm" @click=${props.onRefresh}>Retry</button>
      </div>
    `;
  }

  // Loading state (projects is null and no error)
  if (props.projects == null) {
    return html`
      <div class="data-table-wrapper">
        <div class="projects-skeleton-row"></div>
        <div class="projects-skeleton-row"></div>
        <div class="projects-skeleton-row"></div>
        <div class="projects-skeleton-row"></div>
      </div>
    `;
  }

  // Filter out sub-projects (names containing "/")
  const topLevel = props.projects.filter((p) => !p.name.includes("/"));

  // Empty state
  if (topLevel.length === 0) {
    return html`
      <div class="projects-empty">
        <div class="projects-empty__title">No projects yet</div>
        <div class="projects-empty__hint">
          Create your first project to start tracking tasks and agent activity.
        </div>
        <code class="projects-empty__command">openclaw projects create &lt;name&gt;</code>
      </div>
    `;
  }

  return html`
    <div class="data-table-wrapper">
      <div class="data-table-container">
        <table class="data-table">
          <thead>
            <tr>
              <th style="flex:2">NAME</th>
              <th style="width:80px">STATUS</th>
              <th style="flex:1">TASKS</th>
              <th style="width:60px">AGENTS</th>
              <th class="projects-col-owner" style="width:100px">OWNER</th>
            </tr>
          </thead>
          <tbody>
            ${topLevel.map((project) => {
              const board = props.boards[project.name];
              const queue = props.queues[project.name];
              const agentCount = queue?.claimed?.length ?? 0;
              const statusClass = resolveStatusClass(project.status);

              return html`
                <tr
                  class="list-item-clickable"
                  @click=${() => props.onSelectProject(project.name)}
                >
                  <td style="flex:2">${project.name}</td>
                  <td style="width:80px">
                    <span class="projects-badge ${statusClass}">${project.status}</span>
                  </td>
                  <td style="flex:1">
                    <span class="projects-task-counts">
                      ${renderTaskCounts(board)}
                    </span>
                  </td>
                  <td style="width:60px">${agentCount}</td>
                  <td class="projects-col-owner" style="width:100px">
                    ${project.owner ?? "\u2014"}
                  </td>
                </tr>
              `;
            })}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

/** Map project status to badge modifier class. */
function resolveStatusClass(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "active") return "projects-badge--active";
  if (normalized === "paused") return "projects-badge--paused";
  if (normalized === "complete" || normalized === "completed") return "projects-badge--complete";
  return "projects-badge--active";
}

/** Render per-column task counts from board data. */
function renderTaskCounts(board: BoardIndex | undefined) {
  if (!board?.columns?.length) return html`<span class="muted">0</span>`;

  return board.columns
    .filter((col) => col.tasks.length > 0)
    .map(
      (col) =>
        html`<span class="projects-task-count">${col.tasks.length} ${col.name}</span>`,
    );
}
