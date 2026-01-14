import { html, nothing } from "lit";

import { formatAgo } from "../format";
import type { SlackStatus } from "../types";
import type { ConnectionsProps } from "./connections.types";
import { slackActionOptions } from "./connections.action-options";

export function renderSlackCard(params: {
  props: ConnectionsProps;
  slack: SlackStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, slack, accountCountLabel } = params;
  const botName = slack?.probe?.bot?.name;
  const teamName = slack?.probe?.team?.name;

  return html`
    <div class="card">
      <div class="card-title">Slack</div>
      <div class="card-sub">Socket mode status and bot details.</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">Configured</span>
          <span>${slack?.configured ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Running</span>
          <span>${slack?.running ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Bot</span>
          <span>${botName ? botName : "n/a"}</span>
        </div>
        <div>
          <span class="label">Team</span>
          <span>${teamName ? teamName : "n/a"}</span>
        </div>
        <div>
          <span class="label">Last start</span>
          <span>${slack?.lastStartAt ? formatAgo(slack.lastStartAt) : "n/a"}</span>
        </div>
        <div>
          <span class="label">Last probe</span>
          <span>${slack?.lastProbeAt ? formatAgo(slack.lastProbeAt) : "n/a"}</span>
        </div>
      </div>

      ${slack?.lastError
        ? html`<div class="callout danger" style="margin-top: 12px;">
            ${slack.lastError}
          </div>`
        : nothing}

      ${slack?.probe
        ? html`<div class="callout" style="margin-top: 12px;">
            Probe ${slack.probe.ok ? "ok" : "failed"} · ${slack.probe.status ?? ""}
            ${slack.probe.error ?? ""}
          </div>`
        : nothing}

      <div class="form-grid" style="margin-top: 16px;">
        <label class="field">
          <span>Enabled</span>
          <select
            .value=${props.slackForm.enabled ? "yes" : "no"}
            @change=${(e: Event) =>
              props.onSlackChange({
                enabled: (e.target as HTMLSelectElement).value === "yes",
              })}
          >
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
        <label class="field">
          <span>Bot token</span>
          <input
            type="password"
            .value=${props.slackForm.botToken}
            ?disabled=${props.slackTokenLocked}
            @input=${(e: Event) =>
              props.onSlackChange({
                botToken: (e.target as HTMLInputElement).value,
              })}
          />
        </label>
        <label class="field">
          <span>App token</span>
          <input
            type="password"
            .value=${props.slackForm.appToken}
            ?disabled=${props.slackAppTokenLocked}
            @input=${(e: Event) =>
              props.onSlackChange({
                appToken: (e.target as HTMLInputElement).value,
              })}
          />
        </label>
        <label class="field">
          <span>DMs enabled</span>
          <select
            .value=${props.slackForm.dmEnabled ? "yes" : "no"}
            @change=${(e: Event) =>
              props.onSlackChange({
                dmEnabled: (e.target as HTMLSelectElement).value === "yes",
              })}
          >
            <option value="yes">Enabled</option>
            <option value="no">Disabled</option>
          </select>
        </label>
        <label class="field">
          <span>Allow DMs from</span>
          <input
            .value=${props.slackForm.allowFrom}
            @input=${(e: Event) =>
              props.onSlackChange({
                allowFrom: (e.target as HTMLInputElement).value,
              })}
            placeholder="U123, U456, *"
          />
        </label>
        <label class="field">
          <span>Group DMs enabled</span>
          <select
            .value=${props.slackForm.groupEnabled ? "yes" : "no"}
            @change=${(e: Event) =>
              props.onSlackChange({
                groupEnabled: (e.target as HTMLSelectElement).value === "yes",
              })}
          >
            <option value="yes">Enabled</option>
            <option value="no">Disabled</option>
          </select>
        </label>
        <label class="field">
          <span>Group DM channels</span>
          <input
            .value=${props.slackForm.groupChannels}
            @input=${(e: Event) =>
              props.onSlackChange({
                groupChannels: (e.target as HTMLInputElement).value,
              })}
            placeholder="G123, #team"
          />
        </label>
        <label class="field">
          <span>Reaction notifications</span>
          <select
            .value=${props.slackForm.reactionNotifications}
            @change=${(e: Event) =>
              props.onSlackChange({
                reactionNotifications: (e.target as HTMLSelectElement)
                  .value as "off" | "own" | "all" | "allowlist",
              })}
          >
            <option value="off">Off</option>
            <option value="own">Own</option>
            <option value="all">All</option>
            <option value="allowlist">Allowlist</option>
          </select>
        </label>
        <label class="field">
          <span>Reaction allowlist</span>
          <input
            .value=${props.slackForm.reactionAllowlist}
            @input=${(e: Event) =>
              props.onSlackChange({
                reactionAllowlist: (e.target as HTMLInputElement).value,
              })}
            placeholder="U123, U456"
          />
        </label>
        <label class="field">
          <span>Text chunk limit</span>
          <input
            .value=${props.slackForm.textChunkLimit}
            @input=${(e: Event) =>
              props.onSlackChange({
                textChunkLimit: (e.target as HTMLInputElement).value,
              })}
            placeholder="4000"
          />
        </label>
        <label class="field">
          <span>Media max (MB)</span>
          <input
            .value=${props.slackForm.mediaMaxMb}
            @input=${(e: Event) =>
              props.onSlackChange({
                mediaMaxMb: (e.target as HTMLInputElement).value,
              })}
            placeholder="20"
          />
        </label>
      </div>

      <div class="card-sub" style="margin-top: 16px;">Slash command</div>
      <div class="form-grid" style="margin-top: 8px;">
        <label class="field">
          <span>Slash enabled</span>
          <select
            .value=${props.slackForm.slashEnabled ? "yes" : "no"}
            @change=${(e: Event) =>
              props.onSlackChange({
                slashEnabled: (e.target as HTMLSelectElement).value === "yes",
              })}
          >
            <option value="yes">Enabled</option>
            <option value="no">Disabled</option>
          </select>
        </label>
        <label class="field">
          <span>Slash name</span>
          <input
            .value=${props.slackForm.slashName}
            @input=${(e: Event) =>
              props.onSlackChange({
                slashName: (e.target as HTMLInputElement).value,
              })}
            placeholder="clawd"
          />
        </label>
        <label class="field">
          <span>Slash session prefix</span>
          <input
            .value=${props.slackForm.slashSessionPrefix}
            @input=${(e: Event) =>
              props.onSlackChange({
                slashSessionPrefix: (e.target as HTMLInputElement).value,
              })}
            placeholder="slack:slash"
          />
        </label>
        <label class="field">
          <span>Slash ephemeral</span>
          <select
            .value=${props.slackForm.slashEphemeral ? "yes" : "no"}
            @change=${(e: Event) =>
              props.onSlackChange({
                slashEphemeral: (e.target as HTMLSelectElement).value === "yes",
              })}
          >
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
      </div>

      <div class="card-sub" style="margin-top: 16px;">Channels</div>
      <div class="card-sub">Add channel ids or #names and optionally require mentions.</div>
      <div class="list">
        ${props.slackForm.channels.map(
          (channel, channelIndex) => html`
            <div class="list-item">
              <div class="list-main">
                <div class="form-grid">
                  <label class="field">
                    <span>Channel id / name</span>
                    <input
                      .value=${channel.key}
                      @input=${(e: Event) => {
                        const next = [...props.slackForm.channels];
                        next[channelIndex] = {
                          ...next[channelIndex],
                          key: (e.target as HTMLInputElement).value,
                        };
                        props.onSlackChange({ channels: next });
                      }}
                    />
                  </label>
                  <label class="field">
                    <span>Allow</span>
                    <select
                      .value=${channel.allow ? "yes" : "no"}
                      @change=${(e: Event) => {
                        const next = [...props.slackForm.channels];
                        next[channelIndex] = {
                          ...next[channelIndex],
                          allow: (e.target as HTMLSelectElement).value === "yes",
                        };
                        props.onSlackChange({ channels: next });
                      }}
                    >
                      <option value="yes">Yes</option>
                      <option value="no">No</option>
                    </select>
                  </label>
                  <label class="field">
                    <span>Require mention</span>
                    <select
                      .value=${channel.requireMention ? "yes" : "no"}
                      @change=${(e: Event) => {
                        const next = [...props.slackForm.channels];
                        next[channelIndex] = {
                          ...next[channelIndex],
                          requireMention:
                            (e.target as HTMLSelectElement).value === "yes",
                        };
                        props.onSlackChange({ channels: next });
                      }}
                    >
                      <option value="yes">Yes</option>
                      <option value="no">No</option>
                    </select>
                  </label>
                  <label class="field">
                    <span>&nbsp;</span>
                    <button
                      class="btn"
                      @click=${() => {
                        const next = [...props.slackForm.channels];
                        next.splice(channelIndex, 1);
                        props.onSlackChange({ channels: next });
                      }}
                    >
                      Remove
                    </button>
                  </label>
                </div>
              </div>
            </div>
          `,
        )}
      </div>
      <button
        class="btn"
        style="margin-top: 8px;"
        @click=${() =>
          props.onSlackChange({
            channels: [
              ...props.slackForm.channels,
              { key: "", allow: true, requireMention: false },
            ],
          })}
      >
        Add channel
      </button>

      <div class="card-sub" style="margin-top: 16px;">Tool actions</div>
      <div class="form-grid" style="margin-top: 8px;">
        ${slackActionOptions.map(
          (action) => html`<label class="field">
            <span>${action.label}</span>
            <select
              .value=${props.slackForm.actions[action.key] ? "yes" : "no"}
              @change=${(e: Event) =>
                props.onSlackChange({
                  actions: {
                    ...props.slackForm.actions,
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

      ${props.slackTokenLocked || props.slackAppTokenLocked
        ? html`<div class="callout" style="margin-top: 12px;">
            ${props.slackTokenLocked ? "SLACK_BOT_TOKEN " : ""}
            ${props.slackAppTokenLocked ? "SLACK_APP_TOKEN " : ""} is set in the
            environment. Config edits will not override it.
          </div>`
        : nothing}

      ${props.slackStatus
        ? html`<div class="callout" style="margin-top: 12px;">
            ${props.slackStatus}
          </div>`
        : nothing}

      <div class="row" style="margin-top: 14px;">
        <button
          class="btn primary"
          ?disabled=${props.slackSaving}
          @click=${() => props.onSlackSave()}
        >
          ${props.slackSaving ? "Saving…" : "Save"}
        </button>
        <button class="btn" @click=${() => props.onRefresh(true)}>Probe</button>
      </div>
    </div>
  `;
}

