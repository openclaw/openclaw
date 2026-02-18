/**
 * Chat message types for the UI layer.
 */

/** Union type for items in the chat thread */
export type ChatItem =
  | { kind: "message"; key: string; message: unknown }
  | { kind: "divider"; key: string; label: string; timestamp: number }
  | { kind: "stream"; key: string; text: string; startedAt: number }
  | { kind: "reading-indicator"; key: string };

/** A group of consecutive messages from the same role (Slack-style layout) */
export type MessageGroup = {
  kind: "group";
  key: string;
  role: string;
  messages: Array<{ message: unknown; key: string }>;
  timestamp: number;
  isStreaming: boolean;
};

/** Content item types in a normalized message */
export type MessageContentItem = {
  type: "text" | "tool_call" | "tool_result";
  text?: string;
  name?: string;
  args?: unknown;
};

/** Normalized message structure for rendering */
export type NormalizedMessage = {
  role: string;
  content: MessageContentItem[];
  timestamp: number;
  id?: string;
};

/** Tool card representation for tool calls and results */
export type ToolCard = {
  kind: "call" | "result";
  name: string;
  args?: unknown;
  text?: string;
};
