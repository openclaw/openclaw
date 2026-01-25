import { html, nothing, type TemplateResult } from "lit";

import { formatAgo } from "../format";
import type { SlackStatus } from "../types";
import { renderChannelIntegrationCard, type ChannelCardFrame } from "./channels.shared";

export function renderSlackCard(params: {
  slack?: SlackStatus | null;
  frame: ChannelCardFrame;
  actions: TemplateResult;
  facts: TemplateResult;
  error: string | null;
}) {
  const { slack, frame, actions, facts, error } = params;

  const details = html`
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
        <span class="label">Last start</span>
        <span>${slack?.lastStartAt ? formatAgo(slack.lastStartAt) : "n/a"}</span>
      </div>
      <div>
        <span class="label">Last probe</span>
        <span>${slack?.lastProbeAt ? formatAgo(slack.lastProbeAt) : "n/a"}</span>
      </div>
    </div>

    ${slack?.probe
      ? html`<div class="callout callout--info" style="margin-top: 12px;">
          Probe ${slack.probe.ok ? "ok" : "failed"} · ${slack.probe.status ?? ""}
          ${slack.probe.error ?? ""}
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
