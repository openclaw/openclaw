import { html, nothing } from "lit";

/** Strip characters that tmux session names cannot contain (spaces, dots, colons, etc.) */
function sanitizeSessionName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "");
}

export type TerminalProps = {
  loading: boolean;
  error: string | null;
  sessions: Array<{ name: string; windows: number; attached: boolean }>;
  onRefresh: () => void;
  newSessionName: string;
  onNewSessionNameChange: (v: string) => void;
  onCreate: () => void;
  onKill: (name: string) => void;
  actionBusy: boolean;
  autoRefreshActive: boolean;
};

export function renderTerminal(props: TerminalProps) {
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: center;">
        <div>
          <div class="card-title">Terminal Sessions</div>
          <div class="card-subtitle">
            Agent-managed tmux sessions. Attach from your terminal to observe or take over.
          </div>
        </div>
        <div class="row" style="gap: 8px; align-items: center;">
          ${
            props.autoRefreshActive
              ? html`
                  <span style="font-size: 0.75rem; color: var(--fg-muted)">Auto-refresh on</span>
                `
              : nothing
          }
          <button class="btn btn-sm" @click=${props.onRefresh} ?disabled=${props.loading}>
            ${props.loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      <div class="row" style="margin-top:12px; gap:8px; flex-direction:column;">
        <div class="row" style="gap:8px;">
          <input
            class="input input-sm"
            style="flex:1;"
            placeholder="Session name (letters, numbers, - and _ only)"
            .value=${props.newSessionName}
            @input=${(e: Event) => {
              const raw = (e.target as HTMLInputElement).value;
              const sanitized = sanitizeSessionName(raw);
              // Update the input value to the sanitized version in place
              (e.target as HTMLInputElement).value = sanitized;
              props.onNewSessionNameChange(sanitized);
            }}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") {
                props.onCreate();
              }
            }}
            ?disabled=${props.actionBusy}
          />
          <button
            class="btn btn-sm btn-primary"
            @click=${props.onCreate}
            ?disabled=${props.actionBusy || !props.newSessionName.trim()}
          >
            ${props.actionBusy ? "Working…" : "New Session"}
          </button>
        </div>
        <div style="font-size:0.78rem; color:var(--fg-muted); margin-top:-4px;">
          Only letters, numbers, hyphens <code>-</code> and underscores <code>_</code> are
          allowed. Spaces and special characters are removed automatically.
        </div>
      </div>

      ${
        props.error
          ? html`<div class="alert alert-error" style="margin-top:12px;">${props.error}</div>`
          : nothing
      }

      ${
        !props.loading && props.sessions.length === 0
          ? html`
              <div class="empty-state" style="margin-top: 24px; text-align: center; color: var(--fg-muted)">
                <div style="font-size: 2rem">🖥️</div>
                <div style="margin-top: 8px">No active tmux sessions.</div>
                <div style="font-size: 0.85rem; margin-top: 4px">
                  Sessions appear here when an agent starts work via the agent-terminal skill, or when you create
                  one above.
                </div>
              </div>
            `
          : nothing
      }

      ${props.sessions.map(
        (s) => html`
          <div class="card" style="margin-top:12px; border:1px solid var(--border);">
            <div class="row" style="justify-content: space-between; align-items: center;">
              <div>
                <div style="font-weight:600; font-size:0.95rem;">${s.name}</div>
                <div style="font-size:0.8rem; color:var(--fg-muted); margin-top:2px;">
                  ${s.windows} window${s.windows !== 1 ? "s" : ""}
                </div>
                <div style="margin-top:4px;">
                  <span
                    class="badge ${s.attached ? "badge-warn" : "badge-ok"}"
                    style="font-size:0.75rem;"
                  >
                    ${s.attached ? "🟠 Human Attached" : "🟢 Agent Running"}
                  </span>
                </div>
              </div>
              <div class="row" style="gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end;">
                <code
                  style="background:var(--bg-muted); padding:4px 8px; border-radius:4px; font-size:0.8rem; user-select:all;"
                >
                  tmux attach -t ${s.name}
                </code>
                <button
                  class="btn btn-sm"
                  title="Copy attach command to clipboard"
                  @click=${() => {
                    void navigator.clipboard.writeText(`tmux attach -t ${s.name}`);
                  }}
                >
                  Copy
                </button>
                <button
                  class="btn btn-sm btn-danger"
                  @click=${() => props.onKill(s.name)}
                  ?disabled=${props.actionBusy}
                  title="Kill this session"
                >
                  Kill
                </button>
              </div>
            </div>
          </div>
        `,
      )}

      <div style="margin-top:16px; font-size:0.8rem; color:var(--fg-muted);">
        <strong>To observe or take over:</strong> run
        <code>tmux attach -t &lt;session-name&gt;</code> in your terminal. Detach with
        <kbd>Ctrl+B</kbd> then <kbd>D</kbd> to return control to the agent. Sessions follow the
        naming convention <code>{agentname}-{task}</code>.
      </div>
    </section>
  `;
}
