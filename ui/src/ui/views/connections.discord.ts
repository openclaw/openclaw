import { html, nothing } from "lit";

import { formatAgo } from "../format";
import type { DiscordStatus } from "../types";
import type { ConnectionsProps } from "./connections.types";
import { renderDiscordActionsSection } from "./connections.discord.actions";
import { renderDiscordGuildsEditor } from "./connections.discord.guilds";

export function renderDiscordCard(params: {
  props: ConnectionsProps;
  discord: DiscordStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, discord, accountCountLabel } = params;
  const botName = discord?.probe?.bot?.username;

  return html`
    <div class="card">
      <div class="card-title">Discord</div>
      <div class="card-sub">Bot connection and probe status.</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">Configured</span>
          <span>${discord?.configured ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Running</span>
          <span>${discord?.running ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Bot</span>
          <span>${botName ? `@${botName}` : "n/a"}</span>
        </div>
        <div>
          <span class="label">Last start</span>
          <span>${discord?.lastStartAt ? formatAgo(discord.lastStartAt) : "n/a"}</span>
        </div>
        <div>
          <span class="label">Last probe</span>
          <span>${discord?.lastProbeAt ? formatAgo(discord.lastProbeAt) : "n/a"}</span>
        </div>
      </div>

      ${discord?.lastError
        ? html`<div class="callout danger" style="margin-top: 12px;">
            ${discord.lastError}
          </div>`
        : nothing}

      ${discord?.probe
        ? html`<div class="callout" style="margin-top: 12px;">
            Probe ${discord.probe.ok ? "ok" : "failed"} ·
            ${discord.probe.status ?? ""} ${discord.probe.error ?? ""}
          </div>`
        : nothing}

      <div class="form-grid" style="margin-top: 16px;">
        <label class="field">
          <span>Enabled</span>
          <select
            .value=${props.discordForm.enabled ? "yes" : "no"}
            @change=${(e: Event) =>
              props.onDiscordChange({
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
            .value=${props.discordForm.token}
            ?disabled=${props.discordTokenLocked}
            @input=${(e: Event) =>
              props.onDiscordChange({
                token: (e.target as HTMLInputElement).value,
              })}
          />
        </label>
        <label class="field">
          <span>Allow DMs from</span>
          <input
            .value=${props.discordForm.allowFrom}
            @input=${(e: Event) =>
              props.onDiscordChange({
                allowFrom: (e.target as HTMLInputElement).value,
              })}
            placeholder="123456789, username#1234"
          />
        </label>
        <label class="field">
          <span>DMs enabled</span>
          <select
            .value=${props.discordForm.dmEnabled ? "yes" : "no"}
            @change=${(e: Event) =>
              props.onDiscordChange({
                dmEnabled: (e.target as HTMLSelectElement).value === "yes",
              })}
          >
            <option value="yes">Enabled</option>
            <option value="no">Disabled</option>
          </select>
        </label>
        <label class="field">
          <span>Group DMs</span>
          <select
            .value=${props.discordForm.groupEnabled ? "yes" : "no"}
            @change=${(e: Event) =>
              props.onDiscordChange({
                groupEnabled: (e.target as HTMLSelectElement).value === "yes",
              })}
          >
            <option value="yes">Enabled</option>
            <option value="no">Disabled</option>
          </select>
        </label>
        <label class="field">
          <span>Group channels</span>
          <input
            .value=${props.discordForm.groupChannels}
            @input=${(e: Event) =>
              props.onDiscordChange({
                groupChannels: (e.target as HTMLInputElement).value,
              })}
            placeholder="channelId1, channelId2"
          />
        </label>
        <label class="field">
          <span>Media max MB</span>
          <input
            .value=${props.discordForm.mediaMaxMb}
            @input=${(e: Event) =>
              props.onDiscordChange({
                mediaMaxMb: (e.target as HTMLInputElement).value,
              })}
            placeholder="8"
          />
        </label>
        <label class="field">
          <span>History limit</span>
          <input
            .value=${props.discordForm.historyLimit}
            @input=${(e: Event) =>
              props.onDiscordChange({
                historyLimit: (e.target as HTMLInputElement).value,
              })}
            placeholder="20"
          />
        </label>
        <label class="field">
          <span>Text chunk limit</span>
          <input
            .value=${props.discordForm.textChunkLimit}
            @input=${(e: Event) =>
              props.onDiscordChange({
                textChunkLimit: (e.target as HTMLInputElement).value,
              })}
            placeholder="2000"
          />
        </label>
        <label class="field">
          <span>Reply to mode</span>
          <select
            .value=${props.discordForm.replyToMode}
            @change=${(e: Event) =>
              props.onDiscordChange({
                replyToMode: (e.target as HTMLSelectElement).value as
                  | "off"
                  | "first"
                  | "all",
              })}
          >
            <option value="off">Off</option>
            <option value="first">First</option>
            <option value="all">All</option>
          </select>
        </label>
        ${renderDiscordGuildsEditor(props)}
        <label class="field">
          <span>Slash command</span>
          <select
            .value=${props.discordForm.slashEnabled ? "yes" : "no"}
            @change=${(e: Event) =>
              props.onDiscordChange({
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
            .value=${props.discordForm.slashName}
            @input=${(e: Event) =>
              props.onDiscordChange({
                slashName: (e.target as HTMLInputElement).value,
              })}
            placeholder="clawd"
          />
        </label>
        <label class="field">
          <span>Slash session prefix</span>
          <input
            .value=${props.discordForm.slashSessionPrefix}
            @input=${(e: Event) =>
              props.onDiscordChange({
                slashSessionPrefix: (e.target as HTMLInputElement).value,
              })}
            placeholder="discord:slash"
          />
        </label>
        <label class="field">
          <span>Slash ephemeral</span>
          <select
            .value=${props.discordForm.slashEphemeral ? "yes" : "no"}
            @change=${(e: Event) =>
              props.onDiscordChange({
                slashEphemeral: (e.target as HTMLSelectElement).value === "yes",
              })}
          >
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
      </div>

      ${renderDiscordActionsSection(props)}

      ${props.discordTokenLocked
        ? html`<div class="callout" style="margin-top: 12px;">
            DISCORD_BOT_TOKEN is set in the environment. Config edits will not
            override it.
          </div>`
        : nothing}

      ${props.discordStatus
        ? html`<div class="callout" style="margin-top: 12px;">
            ${props.discordStatus}
          </div>`
        : nothing}

      <div class="row" style="margin-top: 14px;">
        <button
          class="btn primary"
          ?disabled=${props.discordSaving}
          @click=${() => props.onDiscordSave()}
        >
          ${props.discordSaving ? "Saving…" : "Save"}
        </button>
        <button class="btn" @click=${() => props.onRefresh(true)}>Probe</button>
      </div>
    </div>
  `;
}
