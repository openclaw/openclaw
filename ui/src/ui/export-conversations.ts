/**
 * Export conversation sessions to various formats
 * 
 * Supports export to:
 * - Markdown (readable, formatted)
 * - JSON (structured data)
 * - HTML (styled, shareable)
 * - Plain text (simple)
 */

import type { ChatMessage } from "./types.ts";

export type ExportFormat = "markdown" | "json" | "html" | "text";

export type ExportOptions = {
  format: ExportFormat;
  includeThinking?: boolean;
  includeToolCalls?: boolean;
  includeMetadata?: boolean;
  redactSensitive?: boolean;
};

/**
 * Export chat messages to selected format
 */
export async function exportConversation(
  messages: ChatMessage[],
  sessionKey: string,
  options: ExportOptions,
): Promise<{ filename: string; content: string; mimeType: string }> {
  const timestamp = new Date().toISOString().split("T")[0];
  const safeSessionKey = sessionKey.replace(/[^a-zA-Z0-9-_]/g, "_");

  switch (options.format) {
    case "markdown":
      return {
        filename: `conversation-${safeSessionKey}-${timestamp}.md`,
        content: exportToMarkdown(messages, sessionKey, options),
        mimeType: "text/markdown",
      };
    case "json":
      return {
        filename: `conversation-${safeSessionKey}-${timestamp}.json`,
        content: exportToJSON(messages, sessionKey, options),
        mimeType: "application/json",
      };
    case "html":
      return {
        filename: `conversation-${safeSessionKey}-${timestamp}.html`,
        content: exportToHTML(messages, sessionKey, options),
        mimeType: "text/html",
      };
    case "text":
      return {
        filename: `conversation-${safeSessionKey}-${timestamp}.txt`,
        content: exportToText(messages, sessionKey, options),
        mimeType: "text/plain",
      };
    default:
      throw new Error(`Unsupported export format: ${options.format}`);
  }
}

/**
 * Export to Markdown format
 */
function exportToMarkdown(
  messages: ChatMessage[],
  sessionKey: string,
  options: ExportOptions,
): string {
  let output = `# Conversation Export\n\n`;
  output += `**Session:** ${sessionKey}\n`;
  output += `**Exported:** ${new Date().toISOString()}\n`;
  output += `**Messages:** ${messages.length}\n\n`;
  output += `---\n\n`;

  for (const msg of messages) {
    const role = msg.role === "user" ? "**User**" : "**Assistant**";
    const timestamp = msg.timestamp
      ? new Date(msg.timestamp).toLocaleString()
      : "Unknown";

    output += `## ${role}\n`;
    if (options.includeMetadata) {
      output += `*${timestamp}*\n\n`;
    }

    // Main content
    output += `${msg.content || "(empty)"}\n\n`;

    // Thinking (if included)
    if (options.includeThinking && msg.thinking) {
      output += `<details>\n<summary>💭 Thinking</summary>\n\n`;
      output += `${msg.thinking}\n\n`;
      output += `</details>\n\n`;
    }

    // Tool calls (if included)
    if (options.includeToolCalls && msg.toolCalls && msg.toolCalls.length > 0) {
      output += `### 🔧 Tool Calls\n\n`;
      for (const tool of msg.toolCalls) {
        output += `- **${tool.name}**\n`;
        if (tool.input) {
          output += `  \`\`\`json\n  ${JSON.stringify(tool.input, null, 2)}\n  \`\`\`\n`;
        }
      }
      output += `\n`;
    }

    output += `---\n\n`;
  }

  return output;
}

/**
 * Export to JSON format
 */
function exportToJSON(
  messages: ChatMessage[],
  sessionKey: string,
  options: ExportOptions,
): string {
  const data = {
    sessionKey,
    exportedAt: new Date().toISOString(),
    messageCount: messages.length,
    options: {
      includeThinking: options.includeThinking,
      includeToolCalls: options.includeToolCalls,
      includeMetadata: options.includeMetadata,
      redactSensitive: options.redactSensitive,
    },
    messages: messages.map((msg) => {
      const exported: any = {
        role: msg.role,
        content: msg.content,
      };

      if (options.includeMetadata) {
        exported.timestamp = msg.timestamp;
        exported.model = msg.model;
        exported.provider = msg.provider;
      }

      if (options.includeThinking && msg.thinking) {
        exported.thinking = msg.thinking;
      }

      if (options.includeToolCalls && msg.toolCalls) {
        exported.toolCalls = msg.toolCalls;
      }

      if (options.redactSensitive) {
        exported.content = redactSensitiveData(exported.content);
      }

      return exported;
    }),
  };

  return JSON.stringify(data, null, 2);
}

/**
 * Export to HTML format
 */
function exportToHTML(
  messages: ChatMessage[],
  sessionKey: string,
  options: ExportOptions,
): string {
  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Conversation Export - ${escapeHTML(sessionKey)}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 40px 20px;
      background: #f9fafb;
      color: #1f2937;
    }
    h1 { color: #111827; }
    .metadata {
      background: #fff;
      padding: 20px;
      border-radius: 8px;
      margin-bottom: 30px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .message {
      background: #fff;
      padding: 20px;
      border-radius: 8px;
      margin-bottom: 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .message-header {
      display: flex;
      justify-content: space-between;
      margin-bottom: 12px;
      padding-bottom: 12px;
      border-bottom: 1px solid #e5e7eb;
    }
    .role {
      font-weight: 600;
      color: #6366f1;
    }
    .role--user { color: #10b981; }
    .timestamp {
      font-size: 14px;
      color: #6b7280;
    }
    .content {
      line-height: 1.6;
      white-space: pre-wrap;
    }
    .thinking {
      margin-top: 16px;
      padding: 12px;
      background: #fef3c7;
      border-left: 4px solid #f59e0b;
      border-radius: 4px;
      font-size: 14px;
    }
    .tool-calls {
      margin-top: 16px;
      padding: 12px;
      background: #dbeafe;
      border-left: 4px solid #3b82f6;
      border-radius: 4px;
    }
    .tool-call {
      font-family: monospace;
      font-size: 13px;
      margin-bottom: 8px;
    }
    code {
      background: #f3f4f6;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <h1>📝 Conversation Export</h1>
  <div class="metadata">
    <p><strong>Session:</strong> ${escapeHTML(sessionKey)}</p>
    <p><strong>Exported:</strong> ${new Date().toLocaleString()}</p>
    <p><strong>Messages:</strong> ${messages.length}</p>
  </div>
`;

  for (const msg of messages) {
    const roleClass = msg.role === "user" ? "role--user" : "";
    const timestamp = msg.timestamp
      ? new Date(msg.timestamp).toLocaleString()
      : "Unknown";

    html += `  <div class="message">
    <div class="message-header">
      <span class="role ${roleClass}">${msg.role === "user" ? "👤 User" : "🤖 Assistant"}</span>
      ${options.includeMetadata ? `<span class="timestamp">${timestamp}</span>` : ""}
    </div>
    <div class="content">${escapeHTML(msg.content || "(empty)")}</div>
`;

    if (options.includeThinking && msg.thinking) {
      html += `    <div class="thinking">
      <strong>💭 Thinking:</strong><br>
      ${escapeHTML(msg.thinking)}
    </div>
`;
    }

    if (options.includeToolCalls && msg.toolCalls && msg.toolCalls.length > 0) {
      html += `    <div class="tool-calls">
      <strong>🔧 Tool Calls:</strong>
`;
      for (const tool of msg.toolCalls) {
        html += `      <div class="tool-call">→ ${escapeHTML(tool.name)}</div>
`;
      }
      html += `    </div>
`;
    }

    html += `  </div>
`;
  }

  html += `</body>
</html>`;

  return html;
}

/**
 * Export to plain text format
 */
function exportToText(
  messages: ChatMessage[],
  sessionKey: string,
  options: ExportOptions,
): string {
  let output = `CONVERSATION EXPORT\n`;
  output += `Session: ${sessionKey}\n`;
  output += `Exported: ${new Date().toISOString()}\n`;
  output += `Messages: ${messages.length}\n`;
  output += `\n${"=".repeat(60)}\n\n`;

  for (const msg of messages) {
    const role = msg.role === "user" ? "USER" : "ASSISTANT";
    const timestamp = msg.timestamp
      ? new Date(msg.timestamp).toLocaleString()
      : "Unknown";

    output += `${role}`;
    if (options.includeMetadata) {
      output += ` (${timestamp})`;
    }
    output += `:\n`;
    output += `${msg.content || "(empty)"}\n`;

    if (options.includeThinking && msg.thinking) {
      output += `\n[Thinking: ${msg.thinking}]\n`;
    }

    if (options.includeToolCalls && msg.toolCalls && msg.toolCalls.length > 0) {
      output += `\n[Tools used: ${msg.toolCalls.map((t) => t.name).join(", ")}]\n`;
    }

    output += `\n${"-".repeat(60)}\n\n`;
  }

  return output;
}

/**
 * Download exported content as file
 */
export function downloadExport(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Escape HTML special characters
 */
function escapeHTML(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Redact sensitive data (basic implementation)
 */
function redactSensitive(data: string): string {
  return data
    .replace(/([A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27})/g, "[REDACTED_TOKEN]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, "[REDACTED_EMAIL]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[REDACTED_IP]")
    .replace(/sk-[a-zA-Z0-9]{32,}/g, "[REDACTED_API_KEY]");
}
