/**
 * Channel chat view component for multi-agent chat UI.
 * Main chat area with message list, input, and multi-agent support.
 */

import { getAgentColor } from "./agent-colors.js";
import { formatRelativeTime } from "./thread-view.js";
import { renderTypingIndicator, type TypingAgent } from "./typing-indicator.js";

export type ChatMessage = {
  id: string;
  authorId: string;
  authorName: string;
  authorType: "agent" | "user" | "system" | "external";
  content: string;
  timestamp: number;
  threadId?: string;
  replyCount?: number;
  reactions?: { emoji: string; count: number }[];
  isEdited?: boolean;
  mentions?: string[];
};

export type ChannelChatState = {
  channelId: string;
  channelName: string;
  channelTopic?: string;
  messages: ChatMessage[];
  typing: TypingAgent[];
  isLoading: boolean;
  hasMoreMessages: boolean;
  selectedMessageId?: string;
  inputValue: string;
  replyingTo?: ChatMessage;
};

/**
 * Render a chat message.
 */
export function renderChatMessage(message: ChatMessage, isGrouped = false): string {
  const color = getAgentColor(message.authorId);
  const initial = message.authorName.charAt(0).toUpperCase();
  const time = formatRelativeTime(message.timestamp);

  // Highlight mentions in content
  let content = escapeHtml(message.content);
  if (message.mentions) {
    for (const mention of message.mentions) {
      const mentionRegex = new RegExp(`@${escapeHtml(mention)}`, "g");
      content = content.replace(
        mentionRegex,
        `<span class="mention">@${escapeHtml(mention)}</span>`,
      );
    }
  }

  // Handle special message types
  const typeClass = message.authorType === "system" ? " system-message" : "";
  const externalBadge =
    message.authorType === "external" ? '<span class="external-badge">External</span>' : "";

  if (isGrouped) {
    return `
      <div class="chat-message grouped${typeClass}" data-message-id="${escapeHtml(message.id)}">
        <div class="message-timestamp-inline">${time}</div>
        <div class="message-content">${content}</div>
        ${renderMessageActions(message)}
      </div>
    `;
  }

  return `
    <div class="chat-message${typeClass}" data-message-id="${escapeHtml(message.id)}">
      <div class="message-avatar" style="background: ${color}">
        <span>${initial}</span>
      </div>
      <div class="message-body">
        <div class="message-header">
          <span class="author-name" style="color: ${color}">${escapeHtml(message.authorName)}</span>
          ${externalBadge}
          <span class="message-time">${time}</span>
          ${message.isEdited ? '<span class="edited-label">(edited)</span>' : ""}
        </div>
        <div class="message-content">${content}</div>
        ${renderReactions(message.reactions)}
        ${message.replyCount && message.replyCount > 0 ? renderThreadPreview(message) : ""}
        ${renderMessageActions(message)}
      </div>
    </div>
  `;
}

function renderReactions(reactions?: { emoji: string; count: number }[]): string {
  if (!reactions || reactions.length === 0) {
    return "";
  }

  const reactionHtml = reactions
    .map(
      (r) =>
        `<button class="reaction-btn" data-emoji="${escapeHtml(r.emoji)}">${r.emoji} ${r.count}</button>`,
    )
    .join("");

  return `<div class="message-reactions">${reactionHtml}</div>`;
}

function renderThreadPreview(message: ChatMessage): string {
  return `
    <button class="thread-preview" data-thread-id="${escapeHtml(message.id)}">
      <span class="thread-count">${message.replyCount} ${message.replyCount === 1 ? "reply" : "replies"}</span>
      <span class="view-thread">View thread →</span>
    </button>
  `;
}

function renderMessageActions(_message: ChatMessage): string {
  return `
    <div class="message-actions">
      <button class="action-btn" data-action="react" title="Add reaction">😀</button>
      <button class="action-btn" data-action="reply" title="Reply in thread">💬</button>
      <button class="action-btn" data-action="more" title="More actions">⋯</button>
    </div>
  `;
}

/**
 * Group consecutive messages from same author.
 */
export function groupMessages(
  messages: ChatMessage[],
): { message: ChatMessage; isGrouped: boolean }[] {
  const result: { message: ChatMessage; isGrouped: boolean }[] = [];
  const GROUP_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const prevMessage = messages[i - 1];

    const isGrouped =
      prevMessage &&
      prevMessage.authorId === message.authorId &&
      message.timestamp - prevMessage.timestamp < GROUP_THRESHOLD_MS &&
      !message.threadId &&
      !prevMessage.threadId;

    result.push({ message, isGrouped });
  }

  return result;
}

/**
 * Render channel chat view as HTML.
 */
export function renderChannelChat(state: ChannelChatState): string {
  const groupedMessages = groupMessages(state.messages);

  return `
    <div class="channel-chat" data-channel-id="${escapeHtml(state.channelId)}">
      <div class="chat-header">
        <div class="header-info">
          <h2 class="channel-name"># ${escapeHtml(state.channelName)}</h2>
          ${state.channelTopic ? `<p class="channel-topic">${escapeHtml(state.channelTopic)}</p>` : ""}
        </div>
        <div class="header-actions">
          <button class="header-btn" title="Members">👥</button>
          <button class="header-btn" title="Search">🔍</button>
          <button class="header-btn" title="Settings">⚙️</button>
        </div>
      </div>

      <div class="chat-messages">
        ${state.hasMoreMessages ? '<button class="load-more-btn">Load more messages</button>' : ""}
        ${
          state.isLoading
            ? '<div class="loading">Loading messages...</div>'
            : groupedMessages.map((g) => renderChatMessage(g.message, g.isGrouped)).join("")
        }
      </div>

      ${state.typing.length > 0 ? renderTypingIndicator({ typing: state.typing, maxDisplayNames: 3 }) : ""}

      ${state.replyingTo ? renderReplyingTo(state.replyingTo) : ""}

      <div class="chat-input">
        <button class="input-action-btn" title="Attach file">📎</button>
        <div class="input-wrapper">
          <textarea
            class="message-input"
            placeholder="Message #${escapeHtml(state.channelName)}"
            rows="1"
          >${escapeHtml(state.inputValue)}</textarea>
        </div>
        <button class="input-action-btn emoji-btn" title="Add emoji">😊</button>
        <button class="send-btn" title="Send message">➤</button>
      </div>
    </div>
  `;
}

function renderReplyingTo(message: ChatMessage): string {
  return `
    <div class="replying-to">
      <span class="reply-indicator">Replying to <strong>${escapeHtml(message.authorName)}</strong></span>
      <button class="cancel-reply-btn" title="Cancel reply">✕</button>
    </div>
  `;
}

/**
 * Get CSS styles for channel chat.
 */
export function getChannelChatStyles(): string {
  return `
    .channel-chat {
      display: flex;
      flex-direction: column;
      flex: 1;
      height: 100%;
      background: var(--bg-primary, white);
    }

    .chat-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border-color, #e0e0e0);
    }

    .header-info {
      overflow: hidden;
    }

    .channel-name {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
    }

    .channel-topic {
      margin: 4px 0 0;
      font-size: 12px;
      color: var(--text-secondary, #666);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .header-actions {
      display: flex;
      gap: 8px;
    }

    .header-btn {
      background: none;
      border: none;
      font-size: 16px;
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
    }

    .header-btn:hover {
      background: var(--bg-hover, #f0f0f0);
    }

    .chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
    }

    .load-more-btn {
      width: 100%;
      padding: 8px;
      margin-bottom: 16px;
      background: none;
      border: 1px dashed var(--border-color, #ccc);
      border-radius: 4px;
      color: var(--text-secondary, #666);
      cursor: pointer;
    }

    .load-more-btn:hover {
      background: var(--bg-hover, #f5f5f5);
    }

    .chat-message {
      display: flex;
      padding: 8px 0;
      position: relative;
    }

    .chat-message:hover {
      background: var(--bg-hover, #f9f9f9);
    }

    .chat-message:hover .message-actions {
      opacity: 1;
    }

    .chat-message.grouped {
      padding-left: 48px;
    }

    .chat-message.system-message {
      padding: 4px 0;
      color: var(--text-secondary, #666);
      font-style: italic;
    }

    .message-avatar {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      margin-right: 12px;
    }

    .message-avatar span {
      color: white;
      font-size: 14px;
      font-weight: 600;
    }

    .message-body {
      flex: 1;
      min-width: 0;
    }

    .message-header {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 4px;
    }

    .author-name {
      font-weight: 600;
      font-size: 14px;
    }

    .external-badge {
      font-size: 10px;
      padding: 2px 6px;
      background: var(--bg-secondary, #f0f0f0);
      border-radius: 4px;
      color: var(--text-secondary, #666);
    }

    .message-time {
      font-size: 12px;
      color: var(--text-secondary, #666);
    }

    .message-timestamp-inline {
      position: absolute;
      left: 8px;
      font-size: 10px;
      color: var(--text-tertiary, #999);
      opacity: 0;
    }

    .chat-message.grouped:hover .message-timestamp-inline {
      opacity: 1;
    }

    .edited-label {
      font-size: 11px;
      color: var(--text-tertiary, #999);
      font-style: italic;
    }

    .message-content {
      font-size: 14px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-wrap: break-word;
    }

    .message-content .mention {
      background: var(--mention-bg, #e8f0fe);
      color: var(--accent-color, #1a73e8);
      padding: 0 4px;
      border-radius: 4px;
      font-weight: 500;
    }

    .message-reactions {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 8px;
    }

    .reaction-btn {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border: 1px solid var(--border-color, #e0e0e0);
      border-radius: 12px;
      background: var(--bg-secondary, #f5f5f5);
      cursor: pointer;
      font-size: 12px;
    }

    .reaction-btn:hover {
      background: var(--bg-hover, #e8e8e8);
    }

    .thread-preview {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
      padding: 4px 8px;
      background: none;
      border: none;
      color: var(--accent-color, #1a73e8);
      cursor: pointer;
      font-size: 13px;
    }

    .thread-preview:hover {
      text-decoration: underline;
    }

    .message-actions {
      position: absolute;
      top: 4px;
      right: 8px;
      display: flex;
      gap: 2px;
      background: var(--bg-primary, white);
      border: 1px solid var(--border-color, #e0e0e0);
      border-radius: 4px;
      padding: 2px;
      opacity: 0;
      transition: opacity 0.1s;
    }

    .action-btn {
      background: none;
      border: none;
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    }

    .action-btn:hover {
      background: var(--bg-hover, #f0f0f0);
    }

    .replying-to {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 16px;
      background: var(--bg-secondary, #f5f5f5);
      border-top: 1px solid var(--border-color, #e0e0e0);
      font-size: 13px;
    }

    .cancel-reply-btn {
      background: none;
      border: none;
      cursor: pointer;
      padding: 4px;
    }

    .chat-input {
      display: flex;
      align-items: flex-end;
      padding: 12px 16px;
      border-top: 1px solid var(--border-color, #e0e0e0);
      gap: 8px;
    }

    .input-action-btn {
      background: none;
      border: none;
      font-size: 18px;
      padding: 8px;
      cursor: pointer;
      border-radius: 4px;
    }

    .input-action-btn:hover {
      background: var(--bg-hover, #f0f0f0);
    }

    .input-wrapper {
      flex: 1;
    }

    .message-input {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid var(--border-color, #e0e0e0);
      border-radius: 8px;
      font-size: 14px;
      resize: none;
      max-height: 150px;
      font-family: inherit;
    }

    .message-input:focus {
      outline: none;
      border-color: var(--accent-color, #3b82f6);
    }

    .send-btn {
      background: var(--accent-color, #3b82f6);
      color: white;
      border: none;
      border-radius: 50%;
      width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 16px;
    }

    .send-btn:hover {
      background: var(--accent-hover, #2563eb);
    }

    .loading {
      text-align: center;
      padding: 20px;
      color: var(--text-secondary, #666);
    }
  `;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
