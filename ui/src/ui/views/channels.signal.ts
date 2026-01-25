import { html, nothing, type TemplateResult } from "lit";

import { formatAgo } from "../format";
import type { SignalStatus } from "../types";
import { renderChannelIntegrationCard, type ChannelCardFrame } from "./channels.shared";

export function renderSignalCard(params: {
  signal?: SignalStatus | null;
  frame: ChannelCardFrame;
  actions: TemplateResult;
  facts: TemplateResult;
  error: string | null;
}) {
  const { signal, frame, actions, facts, error } = params;

  const details = html`
    <div class="status-list" style="margin-top: 16px;">
      <div>
        <span class="label">Configured</span>
        <span>${signal?.configured ? "Yes" : "No"}</span>
      </div>
      <div>
        <span class="label">Running</span>
        <span>${signal?.running ? "Yes" : "No"}</span>
      </div>
      <div>
        <span class="label">Base URL</span>
        <span>${signal?.baseUrl ?? "n/a"}</span>
      </div>
      <div>
        <span class="label">Last start</span>
        <span>${signal?.lastStartAt ? formatAgo(signal.lastStartAt) : "n/a"}</span>
      </div>
      <div>
        <span class="label">Last probe</span>
        <span>${signal?.lastProbeAt ? formatAgo(signal.lastProbeAt) : "n/a"}</span>
      </div>
    </div>

    ${signal?.probe
      ? html`<div class="callout callout--info" style="margin-top: 12px;">
          Probe ${signal.probe.ok ? "ok" : "failed"} · ${signal.probe.status ?? ""}
          ${signal.probe.error ?? ""}
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
