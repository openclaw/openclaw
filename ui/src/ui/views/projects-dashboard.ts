import { html, nothing } from "lit";
import type { ProjectListEntry, BoardIndex, QueueIndex } from "../controllers/projects.ts";
import {
  renderProjectStatusWidget,
  renderTaskCountsWidget,
  renderActiveAgentsWidget,
  renderRecentActivityWidget,
} from "./projects-widgets.ts";

export type ProjectDashboardProps = {
  loading: boolean;
  error: string | null;
  project: ProjectListEntry | null;
  board: BoardIndex | null;
  queue: QueueIndex | null;
  projectName: string;
  subProjectName: string | null;
  allProjects: ProjectListEntry[] | null;
  allBoards: Record<string, BoardIndex>;
  onNavigateList: () => void;
  onNavigateProject: (name: string) => void;
};

/** Default widget IDs when project config is absent. */
const DEFAULT_WIDGETS = [
  "project-status",
  "task-counts",
  "active-agents",
  "recent-activity",
];

/** Render the project dashboard with breadcrumb, configurable widgets, and sub-projects. */
export function renderProjectDashboard(props: ProjectDashboardProps) {
  const displayName = props.subProjectName ?? props.projectName;

  return html`
    <div class="projects-dashboard">
      ${renderBreadcrumb(props)}
      ${props.error
        ? html`
            <div class="projects-error">
              Failed to load project data. Try refreshing the page.
            </div>
          `
        : props.loading && !props.project
          ? renderLoadingSkeleton()
          : props.project
            ? html`
                ${renderWidgetGrid(props)}
                ${renderSubProjects(props)}
              `
            : nothing}
    </div>
  `;
}

/** Breadcrumb: Projects > [Parent >] Current */
function renderBreadcrumb(props: ProjectDashboardProps) {
  return html`
    <nav class="projects-breadcrumb">
      <a class="projects-breadcrumb__link" @click=${props.onNavigateList}>Projects</a>
      <span class="projects-breadcrumb__sep">\u203A</span>
      ${props.subProjectName
        ? html`
            <a
              class="projects-breadcrumb__link"
              @click=${() => props.onNavigateProject(props.projectName)}
            >${props.projectName}</a>
            <span class="projects-breadcrumb__sep">\u203A</span>
            <span class="projects-breadcrumb__current">${props.subProjectName}</span>
          `
        : html`
            <span class="projects-breadcrumb__current">${props.projectName}</span>
          `}
    </nav>
  `;
}

/** Show skeleton widgets while dashboard data loads. */
function renderLoadingSkeleton() {
  return html`
    <div class="projects-widget-grid">
      <div class="projects-skeleton-widget skeleton"></div>
      <div class="projects-skeleton-widget skeleton"></div>
      <div class="projects-skeleton-widget skeleton"></div>
      <div class="projects-skeleton-widget skeleton"></div>
    </div>
  `;
}

/** Render the widget grid based on project dashboard.widgets configuration. */
function renderWidgetGrid(props: ProjectDashboardProps) {
  const project = props.project!;
  const widgetIds: string[] =
    project.dashboard?.widgets?.length
      ? project.dashboard.widgets
      : DEFAULT_WIDGETS;

  const widgetMap: Record<string, () => unknown> = {
    "project-status": () => renderProjectStatusWidget(project, props.board),
    "task-counts": () => renderTaskCountsWidget(props.board),
    "active-agents": () => renderActiveAgentsWidget(props.queue),
    "recent-activity": () => renderRecentActivityWidget(props.board, props.queue),
  };

  return html`
    <div class="projects-widget-grid">
      ${widgetIds.map((id) => {
        const render = widgetMap[id];
        return render ? render() : nothing;
      })}
    </div>
  `;
}

/**
 * Render sub-project mini cards if any projects have names starting
 * with "{projectName}/". Hidden entirely when no sub-projects exist (D-12).
 */
function renderSubProjects(props: ProjectDashboardProps) {
  const prefix = `${props.projectName}/`;
  const subs = (props.allProjects ?? []).filter((p) => p.name.startsWith(prefix));

  if (subs.length === 0) return nothing;

  return html`
    <div class="projects-subprojects">
      <div class="projects-subprojects__title">SUB-PROJECTS</div>
      <div class="projects-subproject-grid">
        ${subs.map((sub) => {
          const shortName = sub.name.slice(prefix.length);
          const subBoard = props.allBoards[sub.name];
          const taskCount = subBoard
            ? subBoard.columns.reduce((sum, col) => sum + col.tasks.length, 0)
            : 0;

          return html`
            <div
              class="projects-subproject-card"
              @click=${() => props.onNavigateProject(sub.name)}
            >
              <div class="projects-subproject-card__name">${shortName}</div>
              <div class="projects-subproject-card__counts">
                ${taskCount} task${taskCount !== 1 ? "s" : ""}
              </div>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}
