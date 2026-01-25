import { html, nothing, type TemplateResult } from "lit";

import { formatAgo } from "../format";
import type { DiscordStatus } from "../types";
import { renderChannelIntegrationCard, type ChannelCardFrame } from "./channels.shared";

export function renderDiscordCard(params: {
  discord?: DiscordStatus | null;
  frame: ChannelCardFrame;
  actions: TemplateResult;
  facts: TemplateResult;
  error: string | null;
}) {
  const { discord, frame, actions, facts, error } = params;

  const details = html`
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
        <span class="label">Last start</span>
        <span>${discord?.lastStartAt ? formatAgo(discord.lastStartAt) : "n/a"}</span>
      </div>
      <div>
        <span class="label">Last probe</span>
        <span>${discord?.lastProbeAt ? formatAgo(discord.lastProbeAt) : "n/a"}</span>
      </div>
    </div>

    ${discord?.probe
      ? html`<div class="callout callout--info" style="margin-top: 12px;">
          Probe ${discord.probe.ok ? "ok" : "failed"} · ${discord.probe.status ?? ""}
          ${discord.probe.error ?? ""}
        </div>`
      : nothing}
  `;

  return renderChannelIntegrationCard({
    frame,
    actions,
    facts,
    details,
    error: error ?? null,
  });
}
