/**
 * Chat message types for the UI layer.
 */

/** Box render state, mirroring the durable conversational-memory store. */
export type ChatAccordionBoxState = "live" | "collapsed";

/** One durable topic box surfaced to the UI for collapse/expand controls. */
export type ChatAccordionBox = {
  id: string;
  label: string | null;
  state: ChatAccordionBoxState;
  summary: string | null;
};

/** A span's box → seq-range mapping (carried for a later inline-fold consumer). */
export type ChatAccordionSpan = {
  boxId: string | null;
  startSeq: number;
  endSeq: number;
  topic: string | null;
};

/** The topic accordion projection delivered with chat history (Phase 2, 02-03). */
export type ChatAccordionView = {
  boxes: ChatAccordionBox[];
  spans: ChatAccordionSpan[];
};

/** Union type for items in the chat thread */
export type ChatItem =
  | { kind: "message"; key: string; message: unknown; duplicateCount?: number }
  | {
      kind: "divider";
      key: string;
      label: string;
      description?: string;
      action?: { kind: "session-checkpoints"; label: string };
      timestamp: number;
    }
  | { kind: "stream"; key: string; text: string; startedAt: number; isStreaming: boolean }
  | { kind: "reading-indicator"; key: string };

/** A group of consecutive messages from the same role (Slack-style layout) */
export type MessageGroup = {
  kind: "group";
  key: string;
  role: string;
  senderLabel?: string | null;
  messages: Array<{ message: unknown; key: string; duplicateCount?: number }>;
  timestamp: number;
  isStreaming: boolean;
  // Tool groups only: true when the turn still produced a successful assistant
  // reply, so a failed internal tool (Codex marks any non-zero exit as failed)
  // renders collapsed instead of as a primary red error banner. Undefined for
  // non-tool groups and for terminal/in-progress tool failures.
  turnSucceeded?: boolean;
};

/** Content item types in a normalized message */
export type MessageContentItem =
  | {
      type: "text" | "tool_call" | "tool_result";
      text?: string;
      name?: string;
      args?: unknown;
    }
  | {
      type: "attachment";
      attachment: {
        url: string;
        kind: "image" | "audio" | "video" | "document";
        label: string;
        mimeType?: string;
        isVoiceNote?: boolean;
      };
    }
  | {
      type: "canvas";
      preview: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>;
      rawText?: string | null;
    };

/** Normalized message structure for rendering */
export type NormalizedMessage = {
  role: string;
  content: MessageContentItem[];
  timestamp: number;
  id?: string;
  senderLabel?: string | null;
  audioAsVoice?: boolean;
  replyTarget?:
    | {
        kind: "current";
      }
    | {
        kind: "id";
        id: string;
      }
    | null;
};

/** Tool card representation for inline tool call/result rendering */
export type ToolCard = {
  id: string;
  name: string;
  args?: unknown;
  inputText?: string;
  outputText?: string;
  isError?: boolean;
  messageId?: string;
  preview?: {
    kind: "canvas";
    surface: "assistant_message";
    render: "url";
    title?: string;
    preferredHeight?: number;
    url?: string;
    viewId?: string;
    className?: string;
    style?: string;
  };
};
