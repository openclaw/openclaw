import { html, nothing, type TemplateResult } from "lit";

import { formatAgo } from "../format";
import type { WhatsAppStatus } from "../types";
import { formatDuration, renderChannelIntegrationCard, type ChannelCardFrame } from "./channels.shared";

export function renderWhatsAppCard(params: {
  whatsapp?: WhatsAppStatus;
  frame: ChannelCardFrame;
  actions: TemplateResult;
  facts: TemplateResult;
  error: string | null;
  // WhatsApp-specific props passed through from ChannelsProps
  whatsappMessage?: string | null;
  whatsappQrDataUrl?: string | null;
  whatsappBusy?: boolean;
  onWhatsAppWait?: () => void;
  onRefresh?: (probe: boolean) => void;
}) {
  const {
    whatsapp,
    frame,
    actions,
    facts,
    error,
    whatsappMessage,
    whatsappQrDataUrl,
    whatsappBusy,
    onWhatsAppWait,
    onRefresh,
  } = params;

  const details = html`
    <div class="status-list" style="margin-top: 16px;">
      <div>
        <span class="label">Configured</span>
        <span>${whatsapp?.configured ? "Yes" : "No"}</span>
      </div>
      <div>
        <span class="label">Linked</span>
        <span>${whatsapp?.linked ? "Yes" : "No"}</span>
      </div>
      <div>
        <span class="label">Running</span>
        <span>${whatsapp?.running ? "Yes" : "No"}</span>
      </div>
      <div>
        <span class="label">Connected</span>
        <span>${whatsapp?.connected ? "Yes" : "No"}</span>
      </div>
      <div>
        <span class="label">Last connect</span>
        <span>
          ${whatsapp?.lastConnectedAt ? formatAgo(whatsapp.lastConnectedAt) : "n/a"}
        </span>
      </div>
      <div>
        <span class="label">Last message</span>
        <span>
          ${whatsapp?.lastMessageAt ? formatAgo(whatsapp.lastMessageAt) : "n/a"}
        </span>
      </div>
      <div>
        <span class="label">Auth age</span>
        <span>${whatsapp?.authAgeMs != null ? formatDuration(whatsapp.authAgeMs) : "n/a"}</span>
      </div>
    </div>

    ${whatsappMessage
      ? html`<div class="callout callout--info" style="margin-top: 12px;">
          ${whatsappMessage}
        </div>`
      : nothing}

    ${whatsappQrDataUrl
      ? html`
          <div class="channel-qr" style="margin-top: 12px;">
            <img class="channel-qr__image" src=${whatsappQrDataUrl} alt="WhatsApp QR" />
            <div class="channel-qr__message">
              Open WhatsApp → Settings → Linked devices → Link a device, then scan this QR.
            </div>
          </div>
        `
      : nothing}

    <div class="row" style="margin-top: 14px; flex-wrap: wrap;">
      <button
        class="btn btn--sm channel-card__action"
        ?disabled=${whatsappBusy}
        @click=${() => onWhatsAppWait?.()}
      >
        Wait for scan
      </button>
      <button class="btn btn--sm channel-card__action" @click=${() => onRefresh?.(false)}>
        Refresh
      </button>
    </div>
  `;

  return renderChannelIntegrationCard({
    frame,
    actions,
    facts,
    details,
    error: error ?? (whatsapp?.lastError ?? null),
    detailsOpen: Boolean(whatsappQrDataUrl || whatsappMessage),
  });
}
