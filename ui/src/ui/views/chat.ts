import { html, nothing } from "lit";

import type { SessionsListResult } from "../types";
import { resolveToolDisplay, formatToolDetail } from "../tool-display";

export type ChatProps = {
  sessionKey: string;
  onSessionKeyChange: (next: string) => void;
  thinkingLevel: string | null;
  loading: boolean;
  sending: boolean;
  messages: unknown[];
  stream: string | null;
  draft: string;
  connected: boolean;
  canSend: boolean;
  disabledReason: string | null;
  sessions: SessionsListResult | null;
  onRefresh: () => void;
  onDraftChange: (next: string) => void;
  onSend: () => void;
};

export function renderChat(props: ChatProps) {
  const canInteract = props.connected;
  const canCompose = props.canSend && !props.sending;
  const sessionOptions = resolveSessionOptions(props.sessionKey, props.sessions);
  const composePlaceholder = (() => {
    if (!props.connected) return "Connect to the gateway to start chatting…";
    if (!props.canSend) return "Connect an iOS/Android node to enable Web Chat + Talk…";
    return "Message (⌘↩ to send)";
  })();

  return html`
    <section class="card chat">
      <div class="chat-header">
        <div class="chat-header__left">
          <label class="field chat-session">
            <span>Session Key</span>
            <select
              .value=${props.sessionKey}
              ?disabled=${!canInteract}
              @change=${(e: Event) =>
                props.onSessionKeyChange((e.target as HTMLSelectElement).value)}
            >
              ${sessionOptions.map(
                (entry) =>
                  html`<option value=${entry.key}>
                    ${entry.displayName ?? entry.key}
                  </option>`,
              )}
            </select>
          </label>
          <button
            class="btn"
            ?disabled=${props.loading || !canInteract}
            @click=${props.onRefresh}
          >
            ${props.loading ? "Loading…" : "Refresh"}
          </button>
        </div>
        <div class="chat-header__right">
          <div class="muted">Thinking: ${props.thinkingLevel ?? "inherit"}</div>
        </div>
      </div>

      ${props.disabledReason
        ? html`<div class="callout" style="margin-top: 12px;">
            ${props.disabledReason}
          </div>`
        : nothing}

      <div class="chat-thread" role="log" aria-live="polite">
        ${props.loading ? html`<div class="muted">Loading chat…</div>` : nothing}
        ${props.messages.map((m) => renderMessage(m))}
        ${props.stream
          ? renderMessage(
              {
                role: "assistant",
                content: [{ type: "text", text: props.stream }],
                timestamp: Date.now(),
              },
              { streaming: true },
            )
          : nothing}
      </div>

      <div class="chat-compose">
        <label class="field chat-compose__field">
          <span>Message</span>
          <textarea
            .value=${props.draft}
            ?disabled=${!props.canSend}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key !== "Enter") return;
              if (!e.metaKey && !e.ctrlKey) return;
              e.preventDefault();
              if (canCompose) props.onSend();
            }}
            @input=${(e: Event) =>
              props.onDraftChange((e.target as HTMLTextAreaElement).value)}
            placeholder=${composePlaceholder}
          ></textarea>
        </label>
        <div class="row chat-compose__actions">
          <button
            class="btn primary"
            ?disabled=${!props.canSend || props.sending}
            @click=${props.onSend}
          >
            ${props.sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </section>
  `;
}

type SessionOption = {
  key: string;
  updatedAt?: number | null;
  displayName?: string;
};

function resolveSessionOptions(
  currentKey: string,
  sessions: SessionsListResult | null,
) {
  const now = Date.now();
  const cutoff = now - 24 * 60 * 60 * 1000;
  const entries = Array.isArray(sessions?.sessions) ? sessions?.sessions ?? [] : [];
  const sorted = [...entries].sort(
    (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
  );
  const recent: SessionOption[] = [];
  const seen = new Set<string>();
  for (const entry of sorted) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    if ((entry.updatedAt ?? 0) < cutoff) continue;
    recent.push(entry);
  }

  const result: SessionOption[] = [];
  const included = new Set<string>();
  const mainKey = "main";
  const mainEntry = sorted.find((entry) => entry.key === mainKey);
  if (mainEntry) {
    result.push(mainEntry);
    included.add(mainKey);
  } else if (currentKey === mainKey) {
    result.push({ key: mainKey, updatedAt: null });
    included.add(mainKey);
  }

  for (const entry of recent) {
    if (included.has(entry.key)) continue;
    result.push(entry);
    included.add(entry.key);
  }

  if (!included.has(currentKey)) {
    result.push({ key: currentKey, updatedAt: null });
  }

  return result;
}

function renderMessage(message: unknown, opts?: { streaming?: boolean }) {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "unknown";
  const toolCards = extractToolCards(message);
  const isToolResult = isToolResultMessage(message);
  const text =
    !isToolResult
      ? extractText(message) ??
        (typeof m.content === "string"
          ? m.content
          : JSON.stringify(message, null, 2))
      : null;

  const timestamp =
    typeof m.timestamp === "number" ? new Date(m.timestamp).toLocaleTimeString() : "";
  const klass = role === "assistant" ? "assistant" : role === "user" ? "user" : "other";
  const who = role === "assistant" ? "Assistant" : role === "user" ? "You" : role;
  return html`
    <div class="chat-line ${klass}">
      <div class="chat-msg">
        <div class="chat-bubble ${opts?.streaming ? "streaming" : ""}">
          ${text ? html`<div class="chat-text">${text}</div>` : nothing}
          ${toolCards.map((card) => renderToolCard(card))}
        </div>
        <div class="chat-stamp mono">
          ${who}${timestamp ? html` · ${timestamp}` : nothing}
        </div>
      </div>
    </div>
  `;
}

function extractText(message: unknown): string | null {
  const m = message as Record<string, unknown>;
  const content = m.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => {
        const item = p as Record<string, unknown>;
        if (item.type === "text" && typeof item.text === "string") return item.text;
        return null;
      })
      .filter((v): v is string => typeof v === "string");
    if (parts.length > 0) return parts.join("\n");
  }
  if (typeof m.text === "string") return m.text;
  return null;
}

type ToolCard = {
  kind: "call" | "result";
  name: string;
  args?: unknown;
  text?: string;
};

function extractToolCards(message: unknown): ToolCard[] {
  const m = message as Record<string, unknown>;
  const content = normalizeContent(m.content);
  const cards: ToolCard[] = [];

  for (const item of content) {
    const kind = String(item.type ?? "").toLowerCase();
    const isToolCall =
      ["toolcall", "tool_call", "tooluse", "tool_use"].includes(kind) ||
      (typeof item.name === "string" && item.arguments != null);
    if (isToolCall) {
      cards.push({
        kind: "call",
        name: (item.name as string) ?? "tool",
        args: coerceArgs(item.arguments ?? item.args),
      });
    }
  }

  for (const item of content) {
    const kind = String(item.type ?? "").toLowerCase();
    if (kind !== "toolresult" && kind !== "tool_result") continue;
    const text = extractToolText(item);
    const name = typeof item.name === "string" ? item.name : "tool";
    cards.push({ kind: "result", name, text });
  }

  if (isToolResultMessage(message) && !cards.some((card) => card.kind === "result")) {
    const name =
      (typeof m.toolName === "string" && m.toolName) ||
      (typeof m.tool_name === "string" && m.tool_name) ||
      "tool";
    const text = extractText(message) ?? undefined;
    cards.push({ kind: "result", name, text });
  }

  return cards;
}

function renderToolCard(card: ToolCard) {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);
  return html`
    <div class="chat-tool-card">
      <div class="chat-tool-card__title">${display.emoji} ${display.label}</div>
      ${detail
        ? html`<div class="chat-tool-card__detail">${detail}</div>`
        : nothing}
      ${card.text
        ? html`<div class="chat-tool-card__output">${card.text}</div>`
        : nothing}
    </div>
  `;
}

function normalizeContent(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content.filter(Boolean) as Array<Record<string, unknown>>;
}

function coerceArgs(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function extractToolText(item: Record<string, unknown>): string | undefined {
  if (typeof item.text === "string") return item.text;
  if (typeof item.content === "string") return item.content;
  return undefined;
}

function isToolResultMessage(message: unknown): boolean {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role.toLowerCase() : "";
  return role === "toolresult" || role === "tool_result";
}
