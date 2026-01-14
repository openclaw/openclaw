import { html, nothing } from "lit";

import type { ConnectionsProps } from "./connections.types";

export function renderDiscordGuildsEditor(props: ConnectionsProps) {
  return html`
    <div class="field full">
      <span>Guilds</span>
      <div class="card-sub">
        Add each guild (id or slug) and optional channel rules. Empty channel
        entries still allow that channel.
      </div>
      <div class="list">
        ${props.discordForm.guilds.map(
          (guild, guildIndex) => html`
            <div class="list-item">
              <div class="list-main">
                <div class="form-grid">
                  <label class="field">
                    <span>Guild id / slug</span>
                    <input
                      .value=${guild.key}
                      @input=${(e: Event) => {
                        const next = [...props.discordForm.guilds];
                        next[guildIndex] = {
                          ...next[guildIndex],
                          key: (e.target as HTMLInputElement).value,
                        };
                        props.onDiscordChange({ guilds: next });
                      }}
                    />
                  </label>
                  <label class="field">
                    <span>Slug</span>
                    <input
                      .value=${guild.slug}
                      @input=${(e: Event) => {
                        const next = [...props.discordForm.guilds];
                        next[guildIndex] = {
                          ...next[guildIndex],
                          slug: (e.target as HTMLInputElement).value,
                        };
                        props.onDiscordChange({ guilds: next });
                      }}
                    />
                  </label>
                  <label class="field">
                    <span>Require mention</span>
                    <select
                      .value=${guild.requireMention ? "yes" : "no"}
                      @change=${(e: Event) => {
                        const next = [...props.discordForm.guilds];
                        next[guildIndex] = {
                          ...next[guildIndex],
                          requireMention:
                            (e.target as HTMLSelectElement).value === "yes",
                        };
                        props.onDiscordChange({ guilds: next });
                      }}
                    >
                      <option value="yes">Yes</option>
                      <option value="no">No</option>
                    </select>
                  </label>
                  <label class="field">
                    <span>Reaction notifications</span>
                    <select
                      .value=${guild.reactionNotifications}
                      @change=${(e: Event) => {
                        const next = [...props.discordForm.guilds];
                        next[guildIndex] = {
                          ...next[guildIndex],
                          reactionNotifications: (e.target as HTMLSelectElement)
                            .value as "off" | "own" | "all" | "allowlist",
                        };
                        props.onDiscordChange({ guilds: next });
                      }}
                    >
                      <option value="off">Off</option>
                      <option value="own">Own</option>
                      <option value="all">All</option>
                      <option value="allowlist">Allowlist</option>
                    </select>
                  </label>
                  <label class="field">
                    <span>Users allowlist</span>
                    <input
                      .value=${guild.users}
                      @input=${(e: Event) => {
                        const next = [...props.discordForm.guilds];
                        next[guildIndex] = {
                          ...next[guildIndex],
                          users: (e.target as HTMLInputElement).value,
                        };
                        props.onDiscordChange({ guilds: next });
                      }}
                      placeholder="123456789, username#1234"
                    />
                  </label>
                </div>
                ${guild.channels.length
                  ? html`
                      <div class="form-grid" style="margin-top: 8px;">
                        ${guild.channels.map(
                          (channel, channelIndex) => html`
                            <label class="field">
                              <span>Channel id / slug</span>
                              <input
                                .value=${channel.key}
                                @input=${(e: Event) => {
                                  const next = [...props.discordForm.guilds];
                                  const channels = [
                                    ...(next[guildIndex].channels ?? []),
                                  ];
                                  channels[channelIndex] = {
                                    ...channels[channelIndex],
                                    key: (e.target as HTMLInputElement).value,
                                  };
                                  next[guildIndex] = {
                                    ...next[guildIndex],
                                    channels,
                                  };
                                  props.onDiscordChange({ guilds: next });
                                }}
                              />
                            </label>
                            <label class="field">
                              <span>Allow</span>
                              <select
                                .value=${channel.allow ? "yes" : "no"}
                                @change=${(e: Event) => {
                                  const next = [...props.discordForm.guilds];
                                  const channels = [
                                    ...(next[guildIndex].channels ?? []),
                                  ];
                                  channels[channelIndex] = {
                                    ...channels[channelIndex],
                                    allow:
                                      (e.target as HTMLSelectElement).value ===
                                      "yes",
                                  };
                                  next[guildIndex] = {
                                    ...next[guildIndex],
                                    channels,
                                  };
                                  props.onDiscordChange({ guilds: next });
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
                                  const next = [...props.discordForm.guilds];
                                  const channels = [
                                    ...(next[guildIndex].channels ?? []),
                                  ];
                                  channels[channelIndex] = {
                                    ...channels[channelIndex],
                                    requireMention:
                                      (e.target as HTMLSelectElement).value ===
                                      "yes",
                                  };
                                  next[guildIndex] = {
                                    ...next[guildIndex],
                                    channels,
                                  };
                                  props.onDiscordChange({ guilds: next });
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
                                  const next = [...props.discordForm.guilds];
                                  const channels = [
                                    ...(next[guildIndex].channels ?? []),
                                  ];
                                  channels.splice(channelIndex, 1);
                                  next[guildIndex] = {
                                    ...next[guildIndex],
                                    channels,
                                  };
                                  props.onDiscordChange({ guilds: next });
                                }}
                              >
                                Remove
                              </button>
                            </label>
                          `,
                        )}
                      </div>
                    `
                  : nothing}
              </div>
              <div class="list-meta">
                <span>Channels</span>
                <button
                  class="btn"
                  @click=${() => {
                    const next = [...props.discordForm.guilds];
                    const channels = [
                      ...(next[guildIndex].channels ?? []),
                      { key: "", allow: true, requireMention: false },
                    ];
                    next[guildIndex] = {
                      ...next[guildIndex],
                      channels,
                    };
                    props.onDiscordChange({ guilds: next });
                  }}
                >
                  Add channel
                </button>
                <button
                  class="btn danger"
                  @click=${() => {
                    const next = [...props.discordForm.guilds];
                    next.splice(guildIndex, 1);
                    props.onDiscordChange({ guilds: next });
                  }}
                >
                  Remove guild
                </button>
              </div>
            </div>
          `,
        )}
      </div>
      <button
        class="btn"
        style="margin-top: 8px;"
        @click=${() =>
          props.onDiscordChange({
            guilds: [
              ...props.discordForm.guilds,
              {
                key: "",
                slug: "",
                requireMention: false,
                reactionNotifications: "own",
                users: "",
                channels: [],
              },
            ],
          })}
      >
        Add guild
      </button>
    </div>
  `;
}

