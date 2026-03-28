import { html, nothing } from "lit";
import { renderProjectsList, type ProjectsListProps } from "./projects-list.ts";
import { renderProjectDashboard, type ProjectDashboardProps } from "./projects-dashboard.ts";
import type { ProjectListEntry, BoardIndex, QueueIndex } from "../controllers/projects.ts";

export type ProjectsProps = {
  // View routing
  view: "list" | "dashboard";
  projectName: string | null;
  subProjectName: string | null;

  // Data
  projectsList: ProjectListEntry[] | null;
  projectsBoards: Record<string, BoardIndex>;
  projectsQueues: Record<string, QueueIndex>;
  projectData: ProjectListEntry | null;
  projectBoard: BoardIndex | null;
  projectQueue: QueueIndex | null;

  // Loading
  projectsLoading: boolean;
  projectsError: string | null;
  projectDashboardLoading: boolean;
  projectDashboardError: string | null;

  // Callbacks
  onSelectProject: (name: string) => void;
  onNavigateList: () => void;
  onRefresh: () => void;
};

/** Route between project list and dashboard based on view state. */
export function renderProjects(props: ProjectsProps) {
  if (props.view === "dashboard" && props.projectName) {
    return renderProjectDashboard({
      loading: props.projectDashboardLoading,
      error: props.projectDashboardError,
      project: props.projectData,
      board: props.projectBoard,
      queue: props.projectQueue,
      projectName: props.projectName,
      subProjectName: props.subProjectName,
      allProjects: props.projectsList,
      allBoards: props.projectsBoards,
      onNavigateList: props.onNavigateList,
      onNavigateProject: props.onSelectProject,
    });
  }

  return renderProjectsList({
    loading: props.projectsLoading,
    error: props.projectsError,
    projects: props.projectsList,
    boards: props.projectsBoards,
    queues: props.projectsQueues,
    onSelectProject: props.onSelectProject,
    onRefresh: props.onRefresh,
  });
}
