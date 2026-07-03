// Control UI view renders the mobile-first voice surface.
import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { t } from "../../i18n/index.ts";
import type { RealtimeTalkConversationEntry } from "../chat/realtime-talk-conversation.ts";
import type { RealtimeTalkStatus } from "../chat/realtime-talk.ts";
import { icons } from "../icons.ts";

type VoiceSelectOption = { labelKey: string; value: string };

export type VoiceViewOptions = {
  provider: string;
  model: string;
  voice: string;
  transport: string;
  vadThreshold: string;
  silenceDurationMs: string;
  prefixPaddingMs: string;
  reasoningEffort: string;
};

export type VoiceViewProps = {
  assistantName: string;
  userName?: string | null;
  sessionKey: string;
  connected: boolean;
  realtimeTalkActive: boolean;
  realtimeTalkStatus: RealtimeTalkStatus;
  realtimeTalkDetail: string | null;
  realtimeTalkTranscript: string | null;
  realtimeTalkConversation: RealtimeTalkConversationEntry[];
  realtimeTalkOptionsOpen: boolean;
  realtimeTalkOptions: VoiceViewOptions;
  onToggleRealtimeTalk: () => void;
  onToggleRealtimeTalkOptions: () => void;
  onRealtimeTalkOptionsChange: (next: Partial<VoiceViewOptions>) => void;
  onDismissRealtimeTalkError: () => void;
  onOpenChat: () => void;
};

const VOICE_OPTIONS: VoiceSelectOption[] = [
  { labelKey: "voice.options.default", value: "" },
  { labelKey: "voice.options.alloy", value: "alloy" },
  { labelKey: "voice.options.ash", value: "ash" },
  { labelKey: "voice.options.ballad", value: "ballad" },
  { labelKey: "voice.options.coral", value: "coral" },
  { labelKey: "voice.options.echo", value: "echo" },
  { labelKey: "voice.options.sage", value: "sage" },
  { labelKey: "voice.options.shimmer", value: "shimmer" },
  { labelKey: "voice.options.verse", value: "verse" },
  { labelKey: "voice.options.marin", value: "marin" },
  { labelKey: "voice.options.cedar", value: "cedar" },
];

const SENSITIVITY_OPTIONS: VoiceSelectOption[] = [
  { labelKey: "voice.options.default", value: "" },
  { labelKey: "voice.options.low", value: "0.65" },
  { labelKey: "voice.options.medium", value: "0.5" },
  { labelKey: "voice.options.high", value: "0.35" },
];

const TRANSPORT_OPTIONS: VoiceSelectOption[] = [
  { labelKey: "voice.options.auto", value: "" },
  { labelKey: "voice.options.webrtc", value: "webrtc" },
  { labelKey: "voice.options.providerWebSocket", value: "provider-websocket" },
  { labelKey: "voice.options.gatewayRelay", value: "gateway-relay" },
];

const REASONING_OPTIONS: VoiceSelectOption[] = [
  { labelKey: "voice.options.default", value: "" },
  { labelKey: "voice.options.low", value: "low" },
  { labelKey: "voice.options.medium", value: "medium" },
  { labelKey: "voice.options.high", value: "high" },
];

function statusLabel(props: VoiceViewProps): string {
  if (!props.connected) {
    return t("voice.status.disconnected");
  }
  if (props.realtimeTalkStatus === "error") {
    return props.realtimeTalkDetail ?? t("voice.status.error");
  }
  if (props.realtimeTalkDetail) {
    return props.realtimeTalkDetail;
  }
  switch (props.realtimeTalkStatus) {
    case "connecting":
      return t("voice.status.connecting");
    case "listening":
      return t("voice.status.listening");
    case "thinking":
      return t("voice.status.thinking");
    case "idle":
      return props.realtimeTalkActive ? t("voice.status.starting") : t("voice.status.ready");
  }
}

function statusClass(status: RealtimeTalkStatus, connected: boolean): string {
  if (!connected) {
    return "red-voice--disconnected";
  }
  return `red-voice--${status}`;
}

function renderVoiceSelect(params: {
  label: string;
  value: string;
  options: VoiceSelectOption[];
  onSelect: (value: string) => void;
}) {
  return html`
    <label class="red-voice__field">
      <span>${params.label}</span>
      <select
        .value=${params.value}
        @change=${(event: Event) =>
          params.onSelect((event.currentTarget as HTMLSelectElement).value)}
      >
        ${repeat(
          params.options,
          (entry) => entry.value,
          (entry) => html`<option value=${entry.value} ?selected=${entry.value === params.value}>
            ${t(entry.labelKey)}
          </option>`,
        )}
      </select>
    </label>
  `;
}

function renderConversation(props: VoiceViewProps) {
  const entries = props.realtimeTalkConversation;
  if (entries.length === 0) {
    return html`
      <div class="red-voice__empty" aria-live="polite">
        ${props.realtimeTalkTranscript || t("voice.transcript.empty")}
      </div>
    `;
  }
  return html`
    <div class="red-voice__turns" role="log" aria-label=${t("voice.transcript.label")}>
      ${repeat(
        entries,
        (entry) => entry.id,
        (entry) => {
          const speaker =
            entry.role === "user"
              ? props.userName?.trim() || t("voice.speakers.you")
              : props.assistantName;
          return html`
            <div class="red-voice__turn red-voice__turn--${entry.role}" data-role=${entry.role}>
              <span class="red-voice__speaker">${speaker}</span>
              <span class="red-voice__text">${entry.text}</span>
              ${entry.isStreaming
                ? html`<span
                    class="red-voice__streaming"
                    aria-label=${t("voice.transcript.stillListening")}
                  ></span>`
                : nothing}
            </div>
          `;
        },
      )}
    </div>
  `;
}

function renderOptions(props: VoiceViewProps) {
  if (!props.realtimeTalkOptionsOpen) {
    return nothing;
  }
  const options = props.realtimeTalkOptions;
  const update = (key: keyof VoiceViewOptions) => (event: Event) => {
    props.onRealtimeTalkOptionsChange({
      [key]: (event.currentTarget as HTMLInputElement | HTMLSelectElement).value,
    });
  };
  return html`
    <section class="red-voice__options" aria-label=${t("voice.actions.settings")}>
      ${renderVoiceSelect({
        label: t("voice.fields.voice"),
        value: options.voice,
        options: VOICE_OPTIONS,
        onSelect: (voice) => props.onRealtimeTalkOptionsChange({ voice }),
      })}
      ${renderVoiceSelect({
        label: t("voice.fields.sensitivity"),
        value: options.vadThreshold,
        options: SENSITIVITY_OPTIONS,
        onSelect: (vadThreshold) => props.onRealtimeTalkOptionsChange({ vadThreshold }),
      })}
      <label class="red-voice__field">
        <span>${t("voice.fields.model")}</span>
        <input
          .value=${options.model}
          @input=${update("model")}
          placeholder=${t("voice.options.auto")}
          spellcheck="false"
        />
      </label>
      <label class="red-voice__field">
        <span>${t("voice.fields.provider")}</span>
        <input
          .value=${options.provider}
          @input=${update("provider")}
          placeholder=${t("voice.options.auto")}
          spellcheck="false"
        />
      </label>
      ${renderVoiceSelect({
        label: t("voice.fields.transport"),
        value: options.transport,
        options: TRANSPORT_OPTIONS,
        onSelect: (transport) => props.onRealtimeTalkOptionsChange({ transport }),
      })}
      ${renderVoiceSelect({
        label: t("voice.fields.reasoning"),
        value: options.reasoningEffort,
        options: REASONING_OPTIONS,
        onSelect: (reasoningEffort) => props.onRealtimeTalkOptionsChange({ reasoningEffort }),
      })}
    </section>
  `;
}

export function renderVoice(props: VoiceViewProps) {
  const status = statusLabel(props);
  const active = props.realtimeTalkActive && props.realtimeTalkStatus !== "error";
  const primaryLabel = active ? t("voice.actions.endTalk") : t("voice.actions.startTalk");
  return html`
    <section class="red-voice ${statusClass(props.realtimeTalkStatus, props.connected)}">
      <header class="red-voice__header">
        <div class="red-voice__identity">
          <span class="red-voice__eyebrow">${t("voice.title")}</span>
          <h1>${props.assistantName || t("voice.defaultAssistant")}</h1>
        </div>
        <div class="red-voice__header-actions">
          <button
            type="button"
            class="red-voice__icon-button"
            @click=${props.onOpenChat}
            aria-label=${t("voice.actions.openChat")}
            title=${t("voice.actions.openChat")}
          >
            ${icons.messageSquare}
          </button>
          <button
            type="button"
            class="red-voice__icon-button ${props.realtimeTalkOptionsOpen
              ? "red-voice__icon-button--active"
              : ""}"
            @click=${props.onToggleRealtimeTalkOptions}
            ?disabled=${active}
            aria-label=${t("voice.actions.settings")}
            title=${t("voice.actions.settings")}
            aria-expanded=${props.realtimeTalkOptionsOpen ? "true" : "false"}
          >
            ${icons.settings}
          </button>
        </div>
      </header>

      <div class="red-voice__status-row">
        <span class="red-voice__status-dot" aria-hidden="true"></span>
        <span class="red-voice__status-text">${status}</span>
        <span class="red-voice__session">${props.sessionKey}</span>
      </div>

      <div class="red-voice__stage">
        <button
          type="button"
          class="red-voice__talk-button ${active ? "red-voice__talk-button--active" : ""}"
          @click=${props.onToggleRealtimeTalk}
          ?disabled=${!props.connected}
          aria-label=${primaryLabel}
          title=${primaryLabel}
        >
          <span class="red-voice__talk-icon" aria-hidden="true"
            >${active ? icons.micOff : icons.mic}</span
          >
          <span class="red-voice__talk-label">${primaryLabel}</span>
        </button>
        ${props.realtimeTalkStatus === "error"
          ? html`
              <button
                type="button"
                class="red-voice__dismiss"
                @click=${props.onDismissRealtimeTalkError}
              >
                ${t("voice.actions.dismiss")}
              </button>
            `
          : nothing}
      </div>

      ${renderOptions(props)}

      <section class="red-voice__transcript" aria-label=${t("voice.transcript.label")}>
        ${renderConversation(props)}
      </section>
    </section>
  `;
}
