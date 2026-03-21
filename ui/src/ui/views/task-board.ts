import { renderTaskBoardPage, type TaskBoardPageProps } from "../components/task-board/page.ts";

export type TaskBoardProps = TaskBoardPageProps;

export function renderTaskBoard(props: TaskBoardProps) {
  return renderTaskBoardPage(props);
}
