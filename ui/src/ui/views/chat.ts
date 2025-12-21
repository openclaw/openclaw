import { html, nothing } from "lit";

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
  onRefresh: () => void;
  onDraftChange: (next: string) => void;
  onSend: () => void;
};

export function renderChat(props: ChatProps) {
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div class="row">
          <label class="field" style="min-width: 220px;">
            <span>Session Key</span>
            <input
              .value=${props.sessionKey}
              @input=${(e: Event) =>
                props.onSessionKeyChange((e.target as HTMLInputElement).value)}
            />
          </label>
          <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? "Loading…" : "Refresh"}
          </button>
        </div>
        <div class="muted">
          Thinking: ${props.thinkingLevel ?? "inherit"}
        </div>
      </div>

      <div class="messages" style="margin-top: 12px;">
        ${props.loading ? html`<div class="muted">Loading chat…</div>` : nothing}
        ${props.messages.map((m) => renderMessage(m))}
        ${props.stream
          ? html`${renderMessage({
              role: "assistant",
              content: [{ type: "text", text: props.stream }],
            })}`
          : nothing}
      </div>

      <div class="compose" style="margin-top: 12px;">
        <label class="field">
          <span>Message</span>
          <textarea
            .value=${props.draft}
            @input=${(e: Event) =>
              props.onDraftChange((e.target as HTMLTextAreaElement).value)}
            placeholder="Ask the model…"
          ></textarea>
        </label>
        <div class="row" style="justify-content: flex-end;">
          <button
            class="btn primary"
            ?disabled=${props.sending || !props.connected}
            @click=${props.onSend}
          >
            ${props.sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </section>
  `;
}

function renderMessage(message: unknown) {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "unknown";
  const text =
    extractText(message) ??
    (typeof m.content === "string"
      ? m.content
      : JSON.stringify(message, null, 2));

  const ts =
    typeof m.timestamp === "number"
      ? new Date(m.timestamp).toLocaleTimeString()
      : "";
  const klass = role === "assistant" ? "assistant" : role === "user" ? "user" : "";
  return html`
    <div class="msg ${klass}">
      <div class="meta">
        <span class="mono">${role}</span>
        <span class="mono">${ts}</span>
      </div>
      <div class="msgContent">${text}</div>
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
