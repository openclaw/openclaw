import { html, nothing, type TemplateResult } from "lit";

import { formatAgo } from "../format";
import type { IMessageStatus } from "../types";
import { renderChannelIntegrationCard, type ChannelCardFrame } from "./channels.shared";

export function renderIMessageCard(params: {
  imessage?: IMessageStatus | null;
  frame: ChannelCardFrame;
  actions: TemplateResult;
  facts: TemplateResult;
  error: string | null;
}) {
  const { imessage, frame, actions, facts, error } = params;

  const details = html`
    <div class="status-list" style="margin-top: 16px;">
      <div>
        <span class="label">Configured</span>
        <span>${imessage?.configured ? "Yes" : "No"}</span>
      </div>
      <div>
        <span class="label">Running</span>
        <span>${imessage?.running ? "Yes" : "No"}</span>
      </div>
      <div>
        <span class="label">Last start</span>
        <span>${imessage?.lastStartAt ? formatAgo(imessage.lastStartAt) : "n/a"}</span>
      </div>
      <div>
        <span class="label">Last probe</span>
        <span>${imessage?.lastProbeAt ? formatAgo(imessage.lastProbeAt) : "n/a"}</span>
      </div>
    </div>

    ${imessage?.probe
      ? html`<div class="callout callout--info" style="margin-top: 12px;">
          Probe ${imessage.probe.ok ? "ok" : "failed"} · ${imessage.probe.error ?? ""}
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
