import { html, nothing } from "lit";
import type { ConvosStatus } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { formatAgo } from "../format.ts";
import { renderChannelConfigSection } from "./channels.config.ts";

export function renderConvosCard(params: {
  props: ChannelsProps;
  convos?: ConvosStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, convos, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">Convos</div>
      <div class="card-sub">E2E encrypted messaging via XMTP.</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">Configured</span>
          <span>${convos?.configured ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Running</span>
          <span>${convos?.running ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Environment</span>
          <span>${convos?.env ?? "n/a"}</span>
        </div>
        <div>
          <span class="label">Last start</span>
          <span>${convos?.lastStartAt ? formatAgo(convos.lastStartAt) : "n/a"}</span>
        </div>
        <div>
          <span class="label">Last probe</span>
          <span>${convos?.lastProbeAt ? formatAgo(convos.lastProbeAt) : "n/a"}</span>
        </div>
      </div>

      ${
        convos?.lastError
          ? html`<div class="callout danger" style="margin-top: 12px;">
            ${convos.lastError}
          </div>`
          : nothing
      }

      ${
        convos?.probe
          ? html`<div class="callout" style="margin-top: 12px;">
            Probe ${convos.probe.ok ? "ok" : "failed"} ${convos.probe.error ?? ""}
          </div>`
          : nothing
      }

      ${
        props.convosMessage
          ? html`<div class="callout" style="margin-top: 12px;">
            ${props.convosMessage}
          </div>`
          : nothing
      }

      ${
        props.convosInviteUrl
          ? html`<div class="callout" style="margin-top: 12px;">
            <div style="text-align: center; padding: 12px;">
              <p style="font-weight: bold; margin-bottom: 12px;">Open with Convos iOS App</p>
              <div style="margin-bottom: 12px;">
                <input
                  type="text"
                  readonly
                  .value=${props.convosInviteUrl}
                  style="width: 100%; font-family: monospace; font-size: 0.85rem; padding: 8px; border: 1px solid #ccc; border-radius: 4px;"
                  @click=${(e: Event) => (e.target as HTMLInputElement).select()}
                />
              </div>
              <div>
                <a
                  href=${props.convosInviteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="btn"
                  style="display: inline-block; text-decoration: none;"
                >
                  Open Invite Link
                </a>
              </div>
              <p style="margin-top: 12px; font-size: 0.85rem; color: #666;">
                Copy this link and open it on your phone, or click to open in a new tab.
                After joining, accept the request in the Convos app.
              </p>
            </div>
          </div>`
          : nothing
      }

      <div class="row" style="margin-top: 14px; flex-wrap: wrap;">
        <button
          class="btn primary"
          ?disabled=${props.convosBusy}
          @click=${() => props.onConvosSetup()}
        >
          ${props.convosBusy ? "Setting up..." : convos?.configured ? "Regenerate Invite" : "Generate Invite Link"}
        </button>
        <button class="btn" @click=${() => props.onRefresh(true)}>
          Probe
        </button>
      </div>

      ${renderChannelConfigSection({ channelId: "convos", props })}
    </div>
  `;
}
