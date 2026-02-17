import { html, nothing } from "lit";
import { renderSpinner } from "../render-utils.ts";

export type VoiceProps = {
  loading: boolean;
  error: string | null;
  ttsEnabled: boolean;
  ttsProvider: string | null;
  ttsProviders: string[];
  wakeWord: string | null;
  talkMode: string | null;
  onRefresh: () => void;
  onTtsToggle: () => void;
  onTtsProviderChange: (provider: string) => void;
  onWakeWordChange: (word: string) => void;
  onTalkModeToggle: () => void;
};

export function renderVoice(props: VoiceProps) {
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: flex-start;">
        <div>
          <div class="card-title">Voice Controls</div>
          <div class="card-sub">Text-to-speech, voice wake, and talk mode settings.</div>
        </div>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      ${props.error ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>` : nothing}

      ${
        props.loading
          ? renderSpinner("Loading voice settings...")
          : html`
            <div style="margin-top: 16px; display: grid; gap: 24px;">
              ${renderTtsSection(props)}
              ${renderWakeSection(props)}
              ${renderTalkSection(props)}
            </div>
          `
      }
    </section>
  `;
}

function renderTtsSection(props: VoiceProps) {
  return html`
    <div class="voice-section">
      <div class="voice-section__title">
        Text-to-Speech
      </div>
      <div class="form-grid">
        <div class="card stat-card">
          <div class="stat-label">Status</div>
          <div class="stat-value ${props.ttsEnabled ? "ok" : ""}">
            ${props.ttsEnabled ? "Enabled" : "Disabled"}
          </div>
        </div>
        <label class="field">
          <span>Provider</span>
          <select
            .value=${props.ttsProvider ?? ""}
            @change=${(e: Event) => props.onTtsProviderChange((e.target as HTMLSelectElement).value)}
          >
            <option value="">None</option>
            ${props.ttsProviders.map((p) => html`<option value=${p}>${p}</option>`)}
          </select>
        </label>
      </div>
      <div style="margin-top: 12px;">
        <button class="btn" @click=${props.onTtsToggle}>
          ${props.ttsEnabled ? "Disable TTS" : "Enable TTS"}
        </button>
      </div>
    </div>
  `;
}

function renderWakeSection(props: VoiceProps) {
  return html`
    <div class="voice-section">
      <div class="voice-section__title">
        Voice Wake
      </div>
      <div class="form-grid">
        <label class="field">
          <span>Wake Word</span>
          <input
            .value=${props.wakeWord ?? ""}
            @input=${(e: Event) => props.onWakeWordChange((e.target as HTMLInputElement).value)}
            placeholder="e.g. hey openclaw"
          />
        </label>
      </div>
    </div>
  `;
}

function renderTalkSection(props: VoiceProps) {
  return html`
    <div class="voice-section">
      <div class="voice-section__title">
        Talk Mode
      </div>
      <div class="card stat-card" style="max-width: 200px;">
        <div class="stat-label">Mode</div>
        <div class="stat-value">${props.talkMode ?? "Off"}</div>
      </div>
      <div style="margin-top: 12px;">
        <button class="btn" @click=${props.onTalkModeToggle}>
          ${props.talkMode ? "Disable Talk Mode" : "Enable Talk Mode"}
        </button>
      </div>
    </div>
  `;
}
