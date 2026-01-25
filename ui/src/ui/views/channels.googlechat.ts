import { html, nothing, type TemplateResult } from "lit";

import { formatAgo } from "../format";
import type { GoogleChatStatus } from "../types";
import { renderChannelIntegrationCard, type ChannelCardFrame } from "./channels.shared";

export function renderGoogleChatCard(params: {
  googlechat?: GoogleChatStatus | null;
  frame: ChannelCardFrame;
  actions: TemplateResult;
  facts: TemplateResult;
  error: string | null;
}) {
  const { googlechat, frame, actions, facts, error } = params;

  const details = html`
    <div class="status-list" style="margin-top: 16px;">
      <div>
        <span class="label">Configured</span>
        <span>${googlechat ? (googlechat.configured ? "Yes" : "No") : "n/a"}</span>
      </div>
      <div>
        <span class="label">Running</span>
        <span>${googlechat ? (googlechat.running ? "Yes" : "No") : "n/a"}</span>
      </div>
      <div>
        <span class="label">Credential</span>
        <span>${googlechat?.credentialSource ?? "n/a"}</span>
      </div>
      <div>
        <span class="label">Audience</span>
        <span>
          ${googlechat?.audienceType
            ? `${googlechat.audienceType}${googlechat.audience ? ` · ${googlechat.audience}` : ""}`
            : "n/a"}
        </span>
      </div>
      <div>
        <span class="label">Last start</span>
        <span>${googlechat?.lastStartAt ? formatAgo(googlechat.lastStartAt) : "n/a"}</span>
      </div>
      <div>
        <span class="label">Last probe</span>
        <span>${googlechat?.lastProbeAt ? formatAgo(googlechat.lastProbeAt) : "n/a"}</span>
      </div>
    </div>

    ${googlechat?.probe
      ? html`<div class="callout callout--info" style="margin-top: 12px;">
          Probe ${googlechat.probe.ok ? "ok" : "failed"} · ${googlechat.probe.status ?? ""}
          ${googlechat.probe.error ?? ""}
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
