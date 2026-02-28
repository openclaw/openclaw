import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import type { PtyController } from "../controllers/terminal.ts";

export type TerminalProps = {
  connected: boolean;
  ptyController: PtyController | null;
  ptySpawned: boolean;
  ptyError: string | null;
  onPtySpawn: () => void;
  onPtyKill: () => void;
};

export function renderTerminal(props: TerminalProps) {
  return html`
    <div class="terminal-page">
      <div class="terminal-pty">
        ${
          !props.connected
            ? html`
                <div
                  class="terminal-entry__meta terminal-entry__meta--warn"
                  style="padding: 8px 12px; margin-bottom: 4px"
                >
                  \u26A0 Not connected to gateway
                </div>
              `
            : nothing
        }
        ${
          props.ptyError
            ? html`
              <div class="terminal-entry__meta terminal-entry__meta--error" style="padding:8px 12px;margin-bottom:4px">
                ${props.ptyError}
              </div>
            `
            : nothing
        }
        <div
          class="terminal-pty__xterm"
          id="terminal-pty-container"
          ${ref((el) => {
            if (el instanceof HTMLElement && props.ptyController) {
              props.ptyController.mount(el);
              // Auto-spawn once if connected and not yet spawned (skip if user explicitly killed)
              if (
                props.connected &&
                !props.ptySpawned &&
                !props.ptyError &&
                !props.ptyController.userKilled
              ) {
                // Defer to avoid triggering state update during render
                queueMicrotask(() => props.onPtySpawn());
              }
            }
          })}
        ></div>
        <div class="terminal-toolbar">
          ${
            props.ptySpawned
              ? html`<button class="btn btn--sm btn--danger" @click=${props.onPtyKill}>Kill</button>`
              : html`<button class="btn btn--sm" @click=${props.onPtySpawn} ?disabled=${!props.connected}>Spawn</button>`
          }
        </div>
      </div>
    </div>
  `;
}
