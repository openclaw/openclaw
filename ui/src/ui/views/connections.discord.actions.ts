import { html } from "lit";

import type { ConnectionsProps } from "./connections.types";
import { discordActionOptions } from "./connections.action-options";

export function renderDiscordActionsSection(props: ConnectionsProps) {
  return html`
    <div class="card-sub" style="margin-top: 16px;">Tool actions</div>
    <div class="form-grid" style="margin-top: 8px;">
      ${discordActionOptions.map(
        (action) => html`<label class="field">
          <span>${action.label}</span>
          <select
            .value=${props.discordForm.actions[action.key] ? "yes" : "no"}
            @change=${(e: Event) =>
              props.onDiscordChange({
                actions: {
                  ...props.discordForm.actions,
                  [action.key]: (e.target as HTMLSelectElement).value === "yes",
                },
              })}
          >
            <option value="yes">Enabled</option>
            <option value="no">Disabled</option>
          </select>
        </label>`,
      )}
    </div>
  `;
}

