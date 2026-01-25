/**
 * Task-related type definitions for the Chat Task Sidebar.
 */

/** Status values for a chat task */
export type TaskStatus =
  | "not-started"
  | "in-progress"
  | "completed"
  | "error"
  | "user-feedback";

/** A task derived from tool stream entries */
export type ChatTask = {
  id: string;
  name: string;
  status: TaskStatus;
  startedAt: number;
  completedAt: number | null;
  error: string | null;
  children: ChatTask[];
  toolCallId?: string;
  args?: unknown;
  output?: string;
};

/** Activity log entry type */
export type ChatActivityLogType =
  | "tool-start"
  | "tool-result"
  | "tool-error"
  | "user-message"
  | "assistant-message";

/** Activity log entry */
export type ChatActivityLog = {
  id: string;
  type: ChatActivityLogType;
  timestamp: number;
  title: string;
  details?: string;
  toolCallId?: string;
};

/** Combined state for the task sidebar */
export type TaskSidebarState = {
  tasks: ChatTask[];
  activityLog: ChatActivityLog[];
  expandedIds: Set<string>;
};
