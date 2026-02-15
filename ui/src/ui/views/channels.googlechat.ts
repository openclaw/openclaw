import { html, nothing } from "lit";
import type { GoogleChatStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { formatRelativeTimestamp } from "../format.ts";
import { icons } from "../icons.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import { statusChip } from "./channels.shared.ts";

export function renderGoogleChatCard(params: {
  props: ChannelsProps;
  googleChat?: GoogleChatStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, googleChat, accountCountLabel } = params;

  return html`
    <div class="card" style="padding: 0;">
      <div style="padding: 12px 14px; border-bottom: 1px solid var(--border);">
        <div class="card-title" style="margin: 0; display: flex; align-items: center; gap: 8px;">
          <span class="icon" style="width: 16px; height: 16px;">${icons.messageSquare}</span>
          Google Chat
        </div>
        <div class="card-sub" style="margin: 0;">Chat API webhook status and channel configuration.</div>
        ${accountCountLabel}
      </div>

      <div style="padding: 12px 14px;">
        <div class="status-list">
          <div>
            <span class="label">Configured</span>
            ${statusChip(googleChat?.configured)}
          </div>
          <div>
            <span class="label">Running</span>
            ${statusChip(googleChat?.running)}
          </div>
          <div>
            <span class="label">Credential</span>
            <span>${googleChat?.credentialSource ?? "n/a"}</span>
          </div>
          <div>
            <span class="label">Audience</span>
            <span>
              ${
                googleChat?.audienceType
                  ? `${googleChat.audienceType}${googleChat.audience ? ` · ${googleChat.audience}` : ""}`
                  : "n/a"
              }
            </span>
          </div>
          <div>
            <span class="label">Last start</span>
            <span>${googleChat?.lastStartAt ? formatRelativeTimestamp(googleChat.lastStartAt) : "n/a"}</span>
          </div>
          <div>
            <span class="label">Last probe</span>
            <span>${googleChat?.lastProbeAt ? formatRelativeTimestamp(googleChat.lastProbeAt) : "n/a"}</span>
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
              Probe ${googleChat.probe.ok ? "ok" : "failed"} ·
              ${googleChat.probe.status ?? ""} ${googleChat.probe.error ?? ""}
            </div>`
            : nothing
        }

        ${renderChannelConfigSection({ channelId: "googlechat", props })}

        <div class="row" style="margin-top: 12px;">
          <button class="btn" @click=${() => props.onRefresh(true)}>
            Probe
          </button>
        </div>
      </div>
    </div>
  `;
}
