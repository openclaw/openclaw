import { msg } from "@lit/localize";
import { html, nothing } from "lit";
import type { GoogleChatStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { formatAgo } from "../format.ts";
import { renderChannelConfigSection } from "./channels.config.ts";

export function renderGoogleChatCard(params: {
  props: ChannelsProps;
  googleChat?: GoogleChatStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, googleChat, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">${msg("Google Chat", { id: "channels.googlechat.title" })}</div>
      <div class="card-sub">${msg("Chat API webhook status and channel configuration.", {
        id: "channels.googlechat.sub",
      })}</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">${msg("Configured", { id: "channels.googlechat.configured" })}</span>
          <span>${googleChat ? (googleChat.configured ? msg("Yes", { id: "channels.googlechat.yes" }) : msg("No", { id: "channels.googlechat.no" })) : msg("n/a", { id: "channels.googlechat.na" })}</span>
        </div>
        <div>
          <span class="label">${msg("Running", { id: "channels.googlechat.running" })}</span>
          <span>${googleChat ? (googleChat.running ? msg("Yes", { id: "channels.googlechat.yes" }) : msg("No", { id: "channels.googlechat.no" })) : msg("n/a", { id: "channels.googlechat.na" })}</span>
        </div>
        <div>
          <span class="label">${msg("Credential", { id: "channels.googlechat.credential" })}</span>
          <span>${googleChat?.credentialSource ?? msg("n/a", { id: "channels.googlechat.na" })}</span>
        </div>
        <div>
          <span class="label">${msg("Audience", { id: "channels.googlechat.audience" })}</span>
          <span>
            ${
              googleChat?.audienceType
                ? `${googleChat.audienceType}${googleChat.audience ? ` · ${googleChat.audience}` : ""}`
                : msg("n/a", { id: "channels.googlechat.na" })
            }
          </span>
        </div>
        <div>
          <span class="label">${msg("Last start", { id: "channels.googlechat.lastStart" })}</span>
          <span>${googleChat?.lastStartAt ? formatAgo(googleChat.lastStartAt) : msg("n/a", { id: "channels.googlechat.na" })}</span>
        </div>
        <div>
          <span class="label">${msg("Last probe", { id: "channels.googlechat.lastProbe" })}</span>
          <span>${googleChat?.lastProbeAt ? formatAgo(googleChat.lastProbeAt) : msg("n/a", { id: "channels.googlechat.na" })}</span>
        </div>
      </div>

      ${
        googleChat?.lastError
          ? html`<div class="callout danger" style="margin-top: 12px;">
            ${googleChat.lastError}
          </div>`
          : nothing
      }

      ${
        googleChat?.probe
          ? html`<div class="callout" style="margin-top: 12px;">
            ${msg("Probe", { id: "channels.googlechat.probe" })} ${googleChat.probe.ok ? msg("ok", { id: "channels.googlechat.probeOk" }) : msg("failed", { id: "channels.googlechat.probeFailed" })} ·
            ${googleChat.probe.status ?? ""} ${googleChat.probe.error ?? ""}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({ channelId: "googlechat", props })}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${() => props.onRefresh(true)}>
          ${msg("Probe", { id: "channels.googlechat.probeButton" })}
        </button>
      </div>
    </div>
  `;
}
